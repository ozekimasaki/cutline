#!/usr/bin/env python3
"""CutLine FFmpeg worker. stdin JSON: render / validate / loudness."""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from typing import Any

PRE_HANDLE_MS = 80
POST_HANDLE_MS = 100
AUDIO_CROSSFADE_MS = 40
VIDEO_XFADE_MS = 120
MIN_OVERLAP_MS = 20
MIN_TAIL_MS = 50
AUDIO_FADE_SEC = AUDIO_CROSSFADE_MS / 1000
NOISE_HIGHPASS_HZ = 80
NOISE_FFT_NR = 12
NOISE_FFT_NF = -25
SILENCE_GATE_THRESHOLD = 0.025
SILENCE_GATE_RATIO = 8
SILENCE_GATE_ATTACK_MS = 10
SILENCE_GATE_RELEASE_MS = 300
CHANNEL_LAYOUT_STEREO = "aformat=channel_layouts=stereo"
CHANNEL_LAYOUT_MONO = "aformat=channel_layouts=mono"
CHANNEL_JOIN_STEREO = "join=inputs=2:channel_layout=stereo:map=0.0-FL|1.0-FR"
BURN_IN_FONT = "/usr/share/fonts/truetype/droid/DroidSansFallbackFull.ttf"
USER_MEDIA_OPEN = [
    "-protocol_whitelist",
    "file,crypto,data",
    "-format_whitelist",
    "mov,mp4,m4a,3gp,3g2,mj2,matroska,webm,avi,wav,mp3,aac,flac,ogg,mpeg,mpegts,asf",
]
DURATION_SLACK_MS = 600
MAX_SAFE_INTEGER = 9007199254740991
ENCODER_CANDIDATES = ["h264_nvenc", "h264_videotoolbox", "h264_qsv", "libx264"]
PRESETS = {
    "youtube-1080p": (1920, 1080),
    "youtube-4k": (3840, 2160),
    "podcast-video": (1920, 1080),
    "shorts": (1080, 1920),
    "archive-prores": (1920, 1080),
}
_cached_encoder: str | None = None


def main() -> int:
    raw = sys.stdin.read()
    try:
        data = json.loads(raw or "{}")
    except json.JSONDecodeError as err:
        return fail(str(err))
    if not isinstance(data, dict):
        return fail("JSON object が必要です")
    command = sys.argv[1] if len(sys.argv) > 1 else str(data.get("command") or "")
    try:
        if command == "render":
            result = cmd_render(data)
        elif command == "validate":
            result = cmd_validate(data)
        elif command == "loudness":
            result = cmd_loudness(data)
        elif command == "graph":
            result = cmd_graph(data)
        else:
            return fail(f"未対応の command です: {command}")
    except WorkerError as err:
        return fail(str(err))
    except Exception as err:  # noqa: BLE001 — CLI boundary
        return fail(str(err))
    sys.stdout.write(json.dumps(result, ensure_ascii=False))
    sys.stdout.write("\n")
    return 0


def fail(message: str) -> int:
    sys.stderr.write(message + "\n")
    sys.stdout.write(json.dumps({"ok": False, "error": message}, ensure_ascii=False) + "\n")
    return 1


class WorkerError(RuntimeError):
    pass


def cmd_loudness(data: dict[str, Any]) -> dict[str, Any]:
    profile = parse_loudness(data.get("profile") or data.get("loudness"))
    if str(data.get("preset") or "") == "podcast-video" and data.get("loudness") is None and data.get("profile") is None:
        profile = "podcast"
    target = target_lufs(profile)
    filt = loudnorm_filter(profile)
    result: dict[str, Any] = {
        "ok": True,
        "profile": profile,
        "targetLufs": target,
        "filter": filt,
        "encoder": detect_video_encoder() if shutil.which("ffmpeg") else None,
    }
    file_path = data.get("filePath")
    output_path = data.get("outputPath")
    if file_path and output_path:
        require_ffmpeg()
        encoder = detect_video_encoder()
        args = ["-y", "-i", str(file_path), "-af", filt, *video_codec_args(encoder), "-c:a", "aac", str(output_path)]
        run_ffmpeg(args)
        result["outputPath"] = output_path
        result["encoder"] = encoder
    return result


def cmd_validate(data: dict[str, Any]) -> dict[str, Any]:
    require_ffmpeg()
    file_path = str(data.get("filePath") or "")
    if not file_path:
        raise WorkerError("filePath がありません")
    expected = int(data.get("expectedDurationMs") or 0)
    probe = probe_media(file_path)
    detect = detect_anomalies(file_path)
    duration_delta = abs(probe["durationMs"] - expected)
    av_sync_ok = (
        probe["hasAudio"]
        and probe["hasVideo"]
        and abs(probe["videoDurationMs"] - probe["audioDurationMs"]) <= 80
    )
    duration_ok = duration_delta <= DURATION_SLACK_MS
    notes: list[str] = []
    if not probe["hasVideo"]:
        notes.append("映像ストリームがありません")
    if not probe["hasAudio"]:
        notes.append("音声ストリームがありません")
    if not duration_ok:
        notes.append(
            f"尺が想定とずれています（{probe['durationMs']}ms / 想定 {expected}ms）"
        )
    if not av_sync_ok:
        notes.append("映像と音声の尺差が 80ms を超えています")
    if detect["blackFrames"]:
        notes.append("黒味区間を検出しました")
    if detect["frozenFrames"]:
        notes.append("固まったフレームを検出しました")
    if detect["silenceAnomaly"]:
        notes.append("2秒を超える無音があります")
    ok = (
        probe["hasAudio"]
        and probe["hasVideo"]
        and duration_ok
        and av_sync_ok
        and not detect["blackFrames"]
    )
    return {
        "ok": ok,
        "durationMs": probe["durationMs"],
        "expectedDurationMs": expected,
        "hasAudio": probe["hasAudio"],
        "hasVideo": probe["hasVideo"],
        "blackFrames": detect["blackFrames"],
        "frozenFrames": detect["frozenFrames"],
        "silenceAnomaly": detect["silenceAnomaly"],
        "avSyncOk": av_sync_ok,
        "notes": notes,
    }


def cmd_render(data: dict[str, Any]) -> dict[str, Any]:
    require_ffmpeg()
    if data.get("probeOnly"):
        encoder = detect_video_encoder()
        return {"ok": True, "encoder": encoder}
    source_path = str(data.get("sourcePath") or "")
    output_path = str(data.get("outputPath") or "")
    clips = data.get("clips") or []
    if not source_path or not output_path:
        raise WorkerError("sourcePath と outputPath が必要です")
    if not isinstance(clips, list) or len(clips) == 0:
        raise WorkerError("残すクリップがありません")
    loudness = parse_loudness(data.get("loudness"))
    preset = parse_preset(data.get("preset"))
    if data.get("loudness") is None:
        loudness = "podcast" if preset == "podcast-video" else "youtube"
    source_duration_ms = int(data.get("sourceDurationMs") or 0)
    camera_paths = data.get("cameraPaths") or {}
    if not isinstance(camera_paths, dict):
        camera_paths = {}
    mic_paths = data.get("micPaths") or {}
    if not isinstance(mic_paths, dict):
        mic_paths = {}
    handled = with_handles(clips, source_duration_ms)
    index_by_camera, audio_route, extras = plan_input_indices(camera_paths, mic_paths)
    camera_offsets = data.get("cameraOffsetsMs") or {}
    if not isinstance(camera_offsets, dict):
        camera_offsets = {}
    inputs = [source_path, *extras]
    encoder = detect_video_encoder()
    try:
        run_concat(
            inputs,
            output_path,
            handled,
            index_by_camera,
            audio_route,
            True,
            loudness,
            encoder,
            preset,
            camera_offsets,
        )
    except WorkerError as err:
        if "ファイルが無い" in str(err):
            raise
        run_concat(
            inputs,
            output_path,
            handled,
            index_by_camera,
            audio_route,
            False,
            loudness,
            encoder,
            preset,
            camera_offsets,
        )
    return {
        "ok": True,
        "encoder": encoder,
        "outputPath": output_path,
        "loudness": loudness,
        "preset": preset,
    }


def cmd_graph(data: dict[str, Any]) -> dict[str, Any]:
    clips = data.get("clips") or []
    if not isinstance(clips, list) or len(clips) == 0:
        raise WorkerError("残すクリップがありません")
    loudness = parse_loudness(data.get("loudness"))
    preset = parse_preset(data.get("preset"))
    if data.get("loudness") is None:
        loudness = "podcast" if preset == "podcast-video" else "youtube"
    source_duration_ms = int(data.get("sourceDurationMs") or 0)
    handled = with_handles(clips, source_duration_ms)
    camera_paths = data.get("cameraPaths") or {}
    if not isinstance(camera_paths, dict):
        camera_paths = {}
    mic_paths = data.get("micPaths") or {}
    if not isinstance(mic_paths, dict):
        mic_paths = {}
    index_by_camera, audio_route, _extras = plan_input_indices(camera_paths, mic_paths)
    camera_offsets = data.get("cameraOffsetsMs") or {}
    if not isinstance(camera_offsets, dict):
        camera_offsets = {}
    loudnorm = data.get("loudnorm")
    if loudnorm is None:
        loudnorm = True
    caption_dir = data.get("captionDir")
    graph = build_render_graph(
        handled,
        index_by_camera,
        bool(loudnorm),
        loudness,
        preset,
        audio_route,
        camera_offsets,
        str(caption_dir) if caption_dir else None,
    )
    return {
        "ok": True,
        "filterComplex": graph["filter_complex"],
        "durationMs": graph["duration_ms"],
        "junctions": graph["junctions"],
        "audioRoute": graph["audio_route"],
        "loudness": loudness,
        "preset": preset,
    }


def plan_input_indices(
    camera_paths: dict[str, Any],
    mic_paths: dict[str, Any],
) -> tuple[dict[str, int], dict[str, Any], list[str]]:
    extras: list[str] = []
    index_by_camera: dict[str, int] = {"A": 0}
    for cam_id in ("B", "WIDE"):
        file_path = camera_paths.get(cam_id)
        if file_path:
            index_by_camera[cam_id] = len(extras) + 1
            extras.append(str(file_path))
    if camera_paths.get("A"):
        index_by_camera["A"] = 0
    audio_route: dict[str, Any] = {"mixInputIndex": 0}
    for mic_id, key in (("A", "micAInputIndex"), ("B", "micBInputIndex")):
        file_path = mic_paths.get(mic_id)
        if not file_path:
            continue
        audio_route[key] = len(extras) + 1
        extras.append(str(file_path))
    return index_by_camera, audio_route, extras


def resolve_audio_route(route: dict[str, Any] | None) -> dict[str, Any]:
    data = route or {}
    mix = int(data["mixInputIndex"]) if data.get("mixInputIndex") is not None else 0
    mic_a = data.get("micAInputIndex")
    mic_b = data.get("micBInputIndex")
    has_a = mic_a is not None
    has_b = mic_b is not None
    if has_a and has_b:
        return {"kind": "mics", "micA": int(mic_a), "micB": int(mic_b)}
    if has_a:
        return {"kind": "input", "inputIndex": int(mic_a)}
    if has_b:
        return {"kind": "input", "inputIndex": int(mic_b)}
    return {"kind": "input", "inputIndex": mix}


def with_handles(clips: list[Any], source_duration_ms: int) -> list[dict[str, Any]]:
    limit = source_duration_ms or MAX_SAFE_INTEGER
    out: list[dict[str, Any]] = []
    for raw in clips:
        clip = raw if isinstance(raw, dict) else {}
        start = max(0, int(clip.get("startMs") or 0) - PRE_HANDLE_MS)
        end = min(limit, int(clip.get("endMs") or 0) + POST_HANDLE_MS)
        out.append(
            {
                "startMs": start,
                "endMs": end,
                "camera": clip.get("camera"),
                "punchIn": clip.get("punchIn"),
                "morph": clip.get("morph"),
                "text": clip.get("text"),
                "burnIn": clip.get("burnIn"),
                "role": clip.get("role"),
                "sourceStartMs": int(clip.get("startMs") or 0),
                "sourceEndMs": int(clip.get("endMs") or 0),
            }
        )
    return out


def clip_duration_ms(clip: dict[str, Any]) -> int:
    return max(0, int(clip.get("endMs") or 0) - int(clip.get("startMs") or 0))


def is_keep_pause(role: Any) -> bool:
    return role == "pause"


def needs_video_xfade(prev: dict[str, Any], nxt: dict[str, Any]) -> bool:
    if is_keep_pause(prev.get("role")) or is_keep_pause(nxt.get("role")):
        return False
    camera_changed = str(prev.get("camera") or "A") != str(nxt.get("camera") or "A")
    punch_changed = bool(prev.get("punchIn")) != bool(nxt.get("punchIn"))
    return camera_changed or punch_changed or is_remaining_jump_cut(prev, nxt)


def is_conversation_cut(prev: dict[str, Any], nxt: dict[str, Any]) -> bool:
    prev_out = int(prev.get("sourceEndMs") if prev.get("sourceEndMs") is not None else prev.get("endMs") or 0)
    next_in = int(nxt.get("sourceStartMs") if nxt.get("sourceStartMs") is not None else nxt.get("startMs") or 0)
    return next_in - prev_out > 1


def is_remaining_jump_cut(prev: dict[str, Any], nxt: dict[str, Any]) -> bool:
    if is_keep_pause(prev.get("role")) or is_keep_pause(nxt.get("role")):
        return False
    if str(prev.get("camera") or "A") != str(nxt.get("camera") or "A"):
        return False
    return is_conversation_cut(prev, nxt) or prev.get("morph") is True or nxt.get("morph") is True


def junction_reason(prev: dict[str, Any], nxt: dict[str, Any]) -> str:
    if is_keep_pause(prev.get("role")) or is_keep_pause(nxt.get("role")):
        return "conversation-cut" if is_conversation_cut(prev, nxt) else "none"
    if str(prev.get("camera") or "A") != str(nxt.get("camera") or "A"):
        return "camera"
    if bool(prev.get("punchIn")) != bool(nxt.get("punchIn")):
        return "punch-in"
    if is_remaining_jump_cut(prev, nxt):
        return "morph"
    if is_conversation_cut(prev, nxt):
        return "conversation-cut"
    return "none"


def overlap_ms_for_junction(prev: dict[str, Any], nxt: dict[str, Any]) -> int:
    prev_dur = clip_duration_ms(prev)
    next_dur = clip_duration_ms(nxt)
    wanted = VIDEO_XFADE_MS if needs_video_xfade(prev, nxt) else AUDIO_CROSSFADE_MS
    cap = min(prev_dur // 2, next_dur // 2, prev_dur - MIN_TAIL_MS, next_dur - MIN_TAIL_MS)
    if cap < MIN_OVERLAP_MS:
        return 0
    return min(wanted, cap)


def plan_junctions(clips: list[dict[str, Any]]) -> list[dict[str, Any]]:
    junctions: list[dict[str, Any]] = []
    for index in range(1, len(clips)):
        prev = clips[index - 1]
        nxt = clips[index]
        overlap_ms = overlap_ms_for_junction(prev, nxt)
        reason = junction_reason(prev, nxt)
        if overlap_ms <= 0:
            junctions.append(
                {
                    "index": index,
                    "audio": "concat",
                    "video": "concat",
                    "overlapMs": 0,
                    "reason": reason,
                }
            )
            continue
        video = "xfade" if needs_video_xfade(prev, nxt) else "trim-concat"
        junctions.append(
            {
                "index": index,
                "audio": "acrossfade",
                "video": video,
                "overlapMs": overlap_ms,
                "reason": reason,
            }
        )
    return junctions


def ms_to_sec(ms: int) -> str:
    return f"{ms / 1000:.3f}"


def shift_trim(start_ms: int, end_ms: int, offset_ms: int) -> tuple[int, int]:
    start = max(0, int(start_ms) + int(offset_ms))
    end = max(start, int(end_ms) + int(offset_ms))
    return start, end


def caption_file_path(index: int, caption_dir: str | None) -> str:
    name = f"caption-{index}.txt"
    if caption_dir:
        return os.path.join(caption_dir, name)
    return name


def build_render_graph(
    clips: list[dict[str, Any]],
    index_by_camera: dict[str, int],
    loudnorm: bool,
    loudness: str,
    preset: str,
    audio_route_input: dict[str, Any] | None = None,
    camera_offsets: dict[str, Any] | None = None,
    caption_dir: str | None = None,
) -> dict[str, Any]:
    junctions = plan_junctions(clips)
    audio_route = resolve_audio_route(audio_route_input)
    if len(clips) == 0:
        return {
            "filter_complex": "",
            "duration_ms": 0,
            "junctions": junctions,
            "audio_route": audio_route,
        }
    filters: list[str] = []
    scale = scale_filter(preset)
    single_clip = len(clips) == 1
    offsets = camera_offsets or {}
    for index, clip in enumerate(clips):
        camera = str(clip.get("camera") or "A")
        if camera not in index_by_camera:
            raise WorkerError(f"カメラ {camera} のファイルが無いため書き出せません")
        video_index = index_by_camera[camera]
        offset = int(offsets.get(camera) or 0)
        picture_start, picture_end = shift_trim(int(clip["startMs"]), int(clip["endMs"]), offset)
        start = ms_to_sec(picture_start)
        end = ms_to_sec(picture_end)
        punch = ",scale=1472:828,crop=1280:720" if clip.get("punchIn") is True else ""
        text = str(clip.get("text") or "").strip()
        caption = (
            f",{burn_in_filter(caption_file_path(index, caption_dir))}"
            if clip.get("burnIn") and text
            else ""
        )
        filters.append(
            f"[{video_index}:v]trim=start={start}:end={end},setpts=PTS-STARTPTS{punch}{caption},{scale},format=yuv420p[v{index}]"
        )
        filters.extend(clip_audio_filters(clip, index, audio_route, single_clip))
    video_acc = "v0"
    audio_acc = "a0"
    acc_ms = clip_duration_ms(clips[0])
    for junction in junctions:
        index = int(junction["index"])
        clip = clips[index]
        next_video = f"v{index}"
        next_audio = f"a{index}"
        video_out = f"vm{index}"
        audio_out = f"am{index}"
        video_kind = junction["video"]
        if video_kind == "xfade":
            offset = ms_to_sec(acc_ms - int(junction["overlapMs"]))
            duration = ms_to_sec(int(junction["overlapMs"]))
            filters.append(
                f"[{video_acc}][{next_video}]xfade=transition=fade:duration={duration}:offset={offset}[{video_out}]"
            )
        elif video_kind == "trim-concat":
            start = ms_to_sec(int(junction["overlapMs"]))
            filters.append(f"[{next_video}]trim=start={start},setpts=PTS-STARTPTS[{next_video}t]")
            filters.append(f"[{video_acc}][{next_video}t]concat=n=2:v=1:a=0[{video_out}]")
        elif video_kind == "concat":
            filters.append(f"[{video_acc}][{next_video}]concat=n=2:v=1:a=0[{video_out}]")
        else:
            raise WorkerError(f"未知の video join: {video_kind}")
        audio_kind = junction["audio"]
        if audio_kind == "acrossfade":
            duration = ms_to_sec(int(junction["overlapMs"]))
            filters.append(
                f"[{audio_acc}][{next_audio}]acrossfade=d={duration}:c1=tri:c2=tri[{audio_out}]"
            )
        elif audio_kind == "concat":
            filters.append(f"[{audio_acc}][{next_audio}]concat=n=2:v=0:a=1[{audio_out}]")
        else:
            raise WorkerError(f"未知の audio join: {audio_kind}")
        video_acc = video_out
        audio_acc = audio_out
        acc_ms += clip_duration_ms(clip) - int(junction["overlapMs"])
    filters.append(f"[{video_acc}]copy[v]")
    filters.append(f"[{audio_acc}]{audio_tail_filter(loudnorm, loudness)}[a]")
    return {
        "filter_complex": ";".join(filters),
        "duration_ms": acc_ms,
        "junctions": junctions,
        "audio_route": audio_route,
    }


def clip_audio_filters(
    clip: dict[str, Any],
    index: int,
    route: dict[str, Any],
    single_clip: bool,
) -> list[str]:
    start = ms_to_sec(int(clip["startMs"]))
    end = ms_to_sec(int(clip["endMs"]))
    fade = ""
    if single_clip:
        fade_sec = ms_to_sec(AUDIO_CROSSFADE_MS)
        fade_out_start = ms_to_sec(max(0, clip_duration_ms(clip) - AUDIO_CROSSFADE_MS))
        fade = f",afade=t=in:d={fade_sec},afade=t=out:st={fade_out_start}:d={fade_sec}"
    kind = route["kind"]
    if kind == "input":
        inp = int(route["inputIndex"])
        return [
            f"[{inp}:a]atrim=start={start}:end={end},asetpts=PTS-STARTPTS,"
            f"{CHANNEL_LAYOUT_STEREO}{fade}[a{index}]"
        ]
    if kind == "mics":
        mic_a = int(route["micA"])
        mic_b = int(route["micB"])
        return [
            f"[{mic_a}:a]atrim=start={start}:end={end},asetpts=PTS-STARTPTS,"
            f"{CHANNEL_LAYOUT_MONO}[ma{index}]",
            f"[{mic_b}:a]atrim=start={start}:end={end},asetpts=PTS-STARTPTS,"
            f"{CHANNEL_LAYOUT_MONO}[mb{index}]",
            f"[ma{index}][mb{index}]{CHANNEL_JOIN_STEREO}{fade}[a{index}]",
        ]
    raise WorkerError(f"未知の audio route: {kind}")


def write_captions(clips: list[dict[str, Any]], caption_dir: str) -> None:
    os.makedirs(caption_dir, exist_ok=True)
    for index, clip in enumerate(clips):
        text = str(clip.get("text") or "").strip()
        if clip.get("burnIn") and text:
            with open(caption_file_path(index, caption_dir), "w", encoding="utf-8") as handle:
                handle.write(text)


def run_concat(
    inputs: list[str],
    output_path: str,
    clips: list[dict[str, Any]],
    index_by_camera: dict[str, int],
    audio_route: dict[str, Any],
    loudnorm: bool,
    loudness: str,
    encoder: str,
    preset: str,
    camera_offsets: dict[str, Any] | None = None,
) -> None:
    caption_dir = tempfile.mkdtemp(prefix="cutline-caption-")
    write_captions(clips, caption_dir)
    graph = build_render_graph(
        clips,
        index_by_camera,
        loudnorm,
        loudness,
        preset,
        audio_route,
        camera_offsets,
        caption_dir,
    )
    args = ["-y"]
    for file_path in inputs:
        args.extend([*USER_MEDIA_OPEN, "-i", file_path])
    args.extend(
        [
            "-filter_complex",
            graph["filter_complex"],
            "-map",
            "[v]",
            "-map",
            "[a]",
            *output_codec_args(preset, encoder),
            output_path,
        ]
    )
    run_ffmpeg(args)


def burn_in_filter(text_file: str, font_file: str = BURN_IN_FONT) -> str:
    return (
        f"drawtext=fontfile={escape_drawtext(font_file)}:"
        f"textfile={escape_drawtext(text_file)}:expansion=none:"
        "x=(w-text_w)/2:y=h-72:fontsize=28:fontcolor=white:box=1:boxcolor=black@0.62"
    )


def escape_drawtext(text: str) -> str:
    return (
        text.replace("\\", "\\\\")
        .replace("'", "\\'")
        .replace(":", "\\:")
        .replace("%", "\\%")
    )


def parse_preset(value: Any) -> str:
    key = str(value or "youtube-1080p")
    if key in PRESETS:
        return key
    return "youtube-1080p"


def scale_filter(preset: str) -> str:
    width, height = PRESETS.get(preset, PRESETS["youtube-1080p"])
    return (
        f"scale={width}:{height}:force_original_aspect_ratio=decrease,"
        f"pad={width}:{height}:(ow-iw)/2:(oh-ih)/2,setsar=1"
    )


def output_codec_args(preset: str, encoder: str) -> list[str]:
    if preset == "archive-prores":
        return ["-c:v", "prores_ks", "-profile:v", "3", "-c:a", "pcm_s16le"]
    return [*video_codec_args(encoder), "-c:a", "aac", "-movflags", "+faststart"]


def parse_loudness(value: Any) -> str:
    if str(value).lower() == "podcast":
        return "podcast"
    return "youtube"


def target_lufs(profile: str) -> int:
    return -16 if profile == "podcast" else -14


def loudnorm_filter(profile: str) -> str:
    return f"loudnorm=I={target_lufs(profile)}:TP=-1.5:LRA=11"


def noise_handling_filter() -> str:
    return f"highpass=f={NOISE_HIGHPASS_HZ},afftdn=nr={NOISE_FFT_NR}:nf={NOISE_FFT_NF}"


def silence_compression_filter() -> str:
    return (
        f"agate=threshold={SILENCE_GATE_THRESHOLD}:ratio={SILENCE_GATE_RATIO}:"
        f"attack={SILENCE_GATE_ATTACK_MS}:release={SILENCE_GATE_RELEASE_MS}"
    )


def audio_process_filter() -> str:
    return f"{noise_handling_filter()},{silence_compression_filter()}"


def audio_tail_filter(loudnorm: bool, loudness: str) -> str:
    process = audio_process_filter()
    if loudnorm:
        return f"{process},{loudnorm_filter(loudness)}"
    return process


def video_codec_args(encoder: str) -> list[str]:
    if encoder == "libx264":
        return ["-c:v", "libx264", "-preset", "veryfast", "-crf", "18"]
    return ["-c:v", encoder]


def detect_video_encoder() -> str:
    global _cached_encoder
    if _cached_encoder:
        return _cached_encoder
    for name in ENCODER_CANDIDATES:
        if encoder_works(name):
            _cached_encoder = name
            return name
    _cached_encoder = "libx264"
    return _cached_encoder


def encoder_works(name: str) -> bool:
    try:
        run_ffmpeg(
            [
                "-hide_banner",
                "-loglevel",
                "error",
                "-f",
                "lavfi",
                "-i",
                "color=s=32x32:d=0.2",
                "-c:v",
                name,
                "-f",
                "null",
                "-",
            ]
        )
        return True
    except WorkerError:
        return False


def probe_media(file_path: str) -> dict[str, Any]:
    stdout = run_ffprobe(
        [
            *USER_MEDIA_OPEN,
            "-v",
            "error",
            "-show_streams",
            "-show_format",
            "-of",
            "json",
            file_path,
        ]
    )
    parsed = json.loads(stdout or "{}")
    streams = parsed.get("streams") or []
    video = next((stream for stream in streams if stream.get("codec_type") == "video"), None)
    audio = next((stream for stream in streams if stream.get("codec_type") == "audio"), None)
    format_ms = seconds_to_ms((parsed.get("format") or {}).get("duration"))
    video_ms = seconds_to_ms((video or {}).get("duration")) or format_ms
    audio_ms = seconds_to_ms((audio or {}).get("duration")) or format_ms
    return {
        "durationMs": format_ms or video_ms,
        "hasAudio": bool(audio),
        "hasVideo": bool(video),
        "videoDurationMs": video_ms,
        "audioDurationMs": audio_ms,
    }


def detect_anomalies(file_path: str) -> dict[str, bool]:
    try:
        stderr = run_ffmpeg_stderr(
            [
                "-hide_banner",
                *USER_MEDIA_OPEN,
                "-i",
                file_path,
                "-vf",
                "blackdetect=d=0.4:pic_th=0.98,freezedetect=n=0.003:d=5",
                "-af",
                "silencedetect=n=-45dB:d=2",
                "-f",
                "null",
                "-",
            ]
        )
    except WorkerError as err:
        stderr = str(err)
    return parse_detect_log(stderr)


def parse_detect_log(stderr: str) -> dict[str, bool]:
    silence = [float(match) for match in re.findall(r"silence_duration:\s*([0-9.]+)", stderr, re.I)]
    return {
        "blackFrames": bool(re.search(r"black_duration:\s*([0-9.]+)", stderr, re.I)),
        "frozenFrames": bool(re.search(r"lavfi\.freezedetect\.freeze_start", stderr, re.I)),
        "silenceAnomaly": any(value >= 2 for value in silence),
    }


def seconds_to_ms(value: Any) -> int:
    try:
        seconds = float(value or 0)
    except (TypeError, ValueError):
        return 0
    if seconds != seconds or seconds == float("inf") or seconds == float("-inf"):
        return 0
    return int(round(seconds * 1000))


def require_ffmpeg() -> None:
    if not shutil.which("ffmpeg") or not shutil.which("ffprobe"):
        raise WorkerError("ffmpeg が見つかりません")


def run_ffmpeg(args: list[str]) -> str:
    return run_ffmpeg_stderr(args)


def run_ffmpeg_stderr(args: list[str]) -> str:
    completed = subprocess.run(
        ["ffmpeg", *args],
        check=False,
        capture_output=True,
        text=True,
    )
    if completed.returncode != 0:
        raise WorkerError(completed.stderr or completed.stdout or "ffmpeg failed")
    return completed.stderr or ""


def run_ffprobe(args: list[str]) -> str:
    completed = subprocess.run(
        ["ffprobe", *args],
        check=False,
        capture_output=True,
        text=True,
    )
    if completed.returncode != 0:
        raise WorkerError(completed.stderr or completed.stdout or "ffprobe failed")
    return completed.stdout or ""


if __name__ == "__main__":
    sys.exit(main())
