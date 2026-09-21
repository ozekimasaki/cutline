import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { access, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { applyAudioBoundaries } from "./boundary";
import { BURN_IN_FONT, burnInFilter } from "./caption";
import { parseSmpteTimecodeMs, probeMediaMetadata, type FfprobeJson } from "./ingest";
import { syncTracks, type SyncableTrack } from "./sync";
import type { CameraId, ExportPreset, LoudnessProfile, SemanticRole } from "./types";

const execFileAsync = promisify(execFile);

const SAMPLE_DURATION_SEC = 24;

/** User files stay on local protocols and cannot open playlist side files. */
export const USER_MEDIA_PROTOCOL_WHITELIST = "file,crypto,data";
export const USER_MEDIA_FORMAT_WHITELIST =
  "mov,mp4,m4a,3gp,3g2,mj2,matroska,webm,avi,wav,mp3,aac,flac,ogg,mpeg,mpegts,asf";

export function userMediaOpenArgs(): string[] {
  return [
    "-protocol_whitelist",
    USER_MEDIA_PROTOCOL_WHITELIST,
    "-format_whitelist",
    USER_MEDIA_FORMAT_WHITELIST,
  ];
}

export class MissingCameraError extends Error {
  readonly camera: CameraId;

  constructor(camera: CameraId) {
    super(`カメラ ${camera} のファイルが無いため書き出せません`);
    this.name = "MissingCameraError";
    this.camera = camera;
  }
}

export function cameraTrimMs(
  startMs: number,
  endMs: number,
  offsetMs: number,
): { startMs: number; endMs: number } {
  const offset = Number.isFinite(offsetMs) ? Math.round(offsetMs) : 0;
  const start = Math.max(0, Math.round(startMs + offset));
  const end = Math.max(start, Math.round(endMs + offset));
  return { startMs: start, endMs: end };
}

export function videoInputIndex(
  camera: CameraId | undefined,
  indexByCamera: Partial<Record<CameraId, number>>,
): number {
  const id = camera ?? "A";
  const index = indexByCamera[id];
  if (index === undefined) {
    throw new MissingCameraError(id);
  }
  return index;
}

export function captionFilePath(index: number, captionDir?: string): string {
  const name = `caption-${index}.txt`;
  return captionDir ? path.join(captionDir, name) : name;
}

export async function probeDurationMs(filePath: string): Promise<number> {
  const { stdout } = await execFileAsync("ffprobe", [
    ...userMediaOpenArgs(),
    "-v",
    "error",
    "-show_entries",
    "format=duration",
    "-of",
    "json",
    filePath,
  ]);
  const parsed = JSON.parse(stdout) as { format?: { duration?: string } };
  const seconds = Number(parsed.format?.duration ?? 0);
  return Number.isFinite(seconds) ? Math.round(seconds * 1000) : 0;
}

export async function compressVideo(
  inputPath: string,
  outputPath: string,
): Promise<void> {
  await execFileAsync("ffmpeg", [
    "-y",
    ...userMediaOpenArgs(),
    "-i",
    inputPath,
    "-vf",
    "scale=640:-2",
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "32",
    "-c:a",
    "aac",
    "-b:a",
    "64k",
    "-movflags",
    "+faststart",
    outputPath,
  ]);
}

export async function ensureSampleVideo(): Promise<string> {
  const dir = path.join(os.tmpdir(), "cutline");
  await mkdir(dir, { recursive: true });
  const dest = path.join(dir, "sample.mp4");
  try {
    await access(dest);
    return dest;
  } catch {
    // generate below
  }

  const scenes: { color: string; hz: number }[] = [
    { color: "0xc2410c", hz: 220 },
    { color: "0x1e3a5f", hz: 330 },
    { color: "0x3f3f46", hz: 110 },
    { color: "0xb45309", hz: 440 },
    { color: "0x365314", hz: 165 },
    { color: "0x431407", hz: 196 },
  ];
  const parts: string[] = [];
  for (const [index, scene] of scenes.entries()) {
    const part = path.join(dir, `sample-part-${index}.mp4`);
    await execFileAsync("ffmpeg", [
      "-y",
      "-f",
      "lavfi",
      "-i",
      `color=c=${scene.color}:s=1280x720:d=4`,
      "-f",
      "lavfi",
      "-i",
      `sine=frequency=${scene.hz}:duration=4`,
      "-shortest",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-b:a",
      "96k",
      part,
    ]);
    parts.push(part);
  }

  const listPath = path.join(dir, "sample-concat.txt");
  await writeFile(
    listPath,
    parts.map((part) => `file '${part.replaceAll("'", "'\\''")}'`).join("\n"),
    "utf8",
  );
  await execFileAsync("ffmpeg", [
    "-y",
    "-f",
    "concat",
    "-safe",
    "0",
    "-i",
    listPath,
    "-c",
    "copy",
    dest,
  ]);
  return dest;
}

export const PRE_HANDLE_MS = 80;
export const POST_HANDLE_MS = 100;
/** Short acrossfade so conversation cuts do not click (spec §61). */
export const AUDIO_CROSSFADE_MS = 40;
/** Camera / punch-in / morph dissolve. Same overlap on audio to keep A/V locked. */
export const VIDEO_XFADE_MS = 120;
const MIN_OVERLAP_MS = 20;
const MIN_TAIL_MS = 50;
export const AUDIO_FADE_SEC = AUDIO_CROSSFADE_MS / 1000;

/** Spec §59: rumble cut + FFT denoise. Duration-preserving. */
export const NOISE_HIGHPASS_HZ = 80;
export const NOISE_FFT_NR = 12;
export const NOISE_FFT_NF = -25;
/** Spec §59: gate residual silence. Must not shorten A/V (no silenceremove). */
export const SILENCE_GATE_THRESHOLD = 0.025;
export const SILENCE_GATE_RATIO = 8;
export const SILENCE_GATE_ATTACK_MS = 10;
export const SILENCE_GATE_RELEASE_MS = 300;
export const CHANNEL_LAYOUT_STEREO = "aformat=channel_layouts=stereo";
export const CHANNEL_LAYOUT_MONO = "aformat=channel_layouts=mono";
/** Mic 1 → FL (Speaker A), Mic 2 → FR (Speaker B). */
export const CHANNEL_JOIN_STEREO =
  "join=inputs=2:channel_layout=stereo:map=0.0-FL|1.0-FR";

export type RenderGraphClip = {
  startMs: number;
  endMs: number;
  camera?: CameraId;
  punchIn?: boolean;
  morph?: boolean;
  text?: string;
  burnIn?: boolean;
  role?: SemanticRole | string;
  sourceStartMs?: number;
  sourceEndMs?: number;
};

export type VideoJoinKind = "xfade" | "trim-concat" | "concat";
export type AudioJoinKind = "acrossfade" | "concat";

export type RenderJunction = {
  index: number;
  audio: AudioJoinKind;
  video: VideoJoinKind;
  overlapMs: number;
  reason: "camera" | "punch-in" | "morph" | "conversation-cut" | "none";
};

export type AudioRouteInput = {
  mixInputIndex?: number;
  micAInputIndex?: number;
  micBInputIndex?: number;
};

export type ResolvedAudioRoute =
  | { kind: "input"; inputIndex: number }
  | { kind: "mics"; micA: number; micB: number };

export type RenderGraph = {
  filterComplex: string;
  durationMs: number;
  junctions: RenderJunction[];
  audioRoute: ResolvedAudioRoute;
};

export function parseLoudness(value: string | undefined | null): LoudnessProfile {
  return value === "podcast" ? "podcast" : "youtube";
}

export function parseExportPreset(value: string | undefined | null): ExportPreset {
  switch (value) {
    case "youtube-4k":
    case "podcast-video":
    case "shorts":
    case "archive-prores":
    case "youtube-1080p":
      return value;
    default:
      return "youtube-1080p";
  }
}

export function targetLufs(profile: LoudnessProfile): number {
  return profile === "podcast" ? -16 : -14;
}

export function loudnessForPreset(
  preset: ExportPreset,
  override?: LoudnessProfile,
): LoudnessProfile {
  if (override) {
    return override;
  }
  return preset === "podcast-video" ? "podcast" : "youtube";
}

export function presetSize(preset: ExportPreset): { width: number; height: number } {
  switch (preset) {
    case "youtube-4k":
      return { width: 3840, height: 2160 };
    case "shorts":
      return { width: 1080, height: 1920 };
    case "youtube-1080p":
    case "podcast-video":
    case "archive-prores":
      return { width: 1920, height: 1080 };
    default: {
      const _never: never = preset;
      return _never;
    }
  }
}

export function scaleFilter(preset: ExportPreset): string {
  const { width, height } = presetSize(preset);
  return `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1`;
}

export function loudnormFilter(profile: LoudnessProfile): string {
  return `loudnorm=I=${targetLufs(profile)}:TP=-1.5:LRA=11`;
}

export function noiseHandlingFilter(): string {
  return `highpass=f=${NOISE_HIGHPASS_HZ},afftdn=nr=${NOISE_FFT_NR}:nf=${NOISE_FFT_NF}`;
}

export function silenceCompressionFilter(): string {
  return `agate=threshold=${SILENCE_GATE_THRESHOLD}:ratio=${SILENCE_GATE_RATIO}:attack=${SILENCE_GATE_ATTACK_MS}:release=${SILENCE_GATE_RELEASE_MS}`;
}

export function audioProcessFilter(): string {
  return `${noiseHandlingFilter()},${silenceCompressionFilter()}`;
}

export function audioTailFilter(
  loudnorm: boolean,
  loudnessFilter?: string,
): string {
  const process = audioProcessFilter();
  if (loudnorm && loudnessFilter) {
    return `${process},${loudnessFilter}`;
  }
  return process;
}

export function resolveAudioRoute(
  input?: AudioRouteInput,
): ResolvedAudioRoute {
  const mix = input?.mixInputIndex ?? 0;
  const micA = input?.micAInputIndex;
  const micB = input?.micBInputIndex;
  const hasA = typeof micA === "number";
  const hasB = typeof micB === "number";
  if (hasA && hasB) {
    return { kind: "mics", micA, micB };
  }
  if (hasA) {
    return { kind: "input", inputIndex: micA };
  }
  if (hasB) {
    return { kind: "input", inputIndex: micB };
  }
  return { kind: "input", inputIndex: mix };
}

export function planInputIndices(input: {
  cameraPaths?: Partial<Record<CameraId, string>>;
  micPaths?: Partial<Record<"A" | "B", string>>;
}): {
  indexByCamera: Partial<Record<CameraId, number>>;
  audioRoute: AudioRouteInput;
  extras: string[];
} {
  const extras: string[] = [];
  const indexByCamera: Partial<Record<CameraId, number>> = { A: 0 };
  (["B", "WIDE"] as const).forEach((id) => {
    const filePath = input.cameraPaths?.[id];
    if (filePath) {
      indexByCamera[id] = extras.length + 1;
      extras.push(filePath);
    }
  });
  if (input.cameraPaths?.A) {
    indexByCamera.A = 0;
  }
  const audioRoute: AudioRouteInput = { mixInputIndex: 0 };
  (["A", "B"] as const).forEach((id) => {
    const filePath = input.micPaths?.[id];
    if (!filePath) {
      return;
    }
    const index = extras.length + 1;
    if (id === "A") {
      audioRoute.micAInputIndex = index;
    } else {
      audioRoute.micBInputIndex = index;
    }
    extras.push(filePath);
  });
  return { indexByCamera, audioRoute, extras };
}

export function withHandles(
  clips: { startMs: number; endMs: number }[],
  sourceDurationMs: number,
): { startMs: number; endMs: number }[] {
  return clips.map((clip) => ({
    startMs: Math.max(0, clip.startMs - PRE_HANDLE_MS),
    endMs: Math.min(
      sourceDurationMs || Number.MAX_SAFE_INTEGER,
      clip.endMs + POST_HANDLE_MS,
    ),
  }));
}

export function isKeepPause(role: string | undefined): boolean {
  return role === "pause";
}

export function clipDurationMs(clip: Pick<RenderGraphClip, "startMs" | "endMs">): number {
  return Math.max(0, clip.endMs - clip.startMs);
}

export function needsVideoXfade(
  prev: RenderGraphClip,
  next: RenderGraphClip,
): boolean {
  if (isKeepPause(prev.role) || isKeepPause(next.role)) {
    return false;
  }
  const cameraChanged = (prev.camera ?? "A") !== (next.camera ?? "A");
  const punchChanged = Boolean(prev.punchIn) !== Boolean(next.punchIn);
  return cameraChanged || punchChanged || isRemainingJumpCut(prev, next);
}

export function isConversationCut(
  prev: RenderGraphClip,
  next: RenderGraphClip,
): boolean {
  const prevOut = prev.sourceEndMs ?? prev.endMs;
  const nextIn = next.sourceStartMs ?? next.startMs;
  return nextIn - prevOut > 1;
}

/** Spec §44 item 5: morph/transition when reaction/wide/other/punch-in still leave a jump. */
export function isRemainingJumpCut(
  prev: RenderGraphClip,
  next: RenderGraphClip,
): boolean {
  if (isKeepPause(prev.role) || isKeepPause(next.role)) {
    return false;
  }
  if ((prev.camera ?? "A") !== (next.camera ?? "A")) {
    return false;
  }
  return isConversationCut(prev, next) || prev.morph === true || next.morph === true;
}

export function junctionReason(
  prev: RenderGraphClip,
  next: RenderGraphClip,
): RenderJunction["reason"] {
  if (isKeepPause(prev.role) || isKeepPause(next.role)) {
    if (isConversationCut(prev, next)) {
      return "conversation-cut";
    }
    return "none";
  }
  if ((prev.camera ?? "A") !== (next.camera ?? "A")) {
    return "camera";
  }
  if (Boolean(prev.punchIn) !== Boolean(next.punchIn)) {
    return "punch-in";
  }
  if (isRemainingJumpCut(prev, next)) {
    return "morph";
  }
  if (isConversationCut(prev, next)) {
    return "conversation-cut";
  }
  return "none";
}

export function overlapMsForJunction(
  prev: RenderGraphClip,
  next: RenderGraphClip,
): number {
  const prevDur = clipDurationMs(prev);
  const nextDur = clipDurationMs(next);
  const wanted = needsVideoXfade(prev, next)
    ? VIDEO_XFADE_MS
    : AUDIO_CROSSFADE_MS;
  const cap = Math.min(
    Math.floor(prevDur / 2),
    Math.floor(nextDur / 2),
    prevDur - MIN_TAIL_MS,
    nextDur - MIN_TAIL_MS,
  );
  if (cap < MIN_OVERLAP_MS) {
    return 0;
  }
  return Math.min(wanted, cap);
}

export function planJunctions(clips: RenderGraphClip[]): RenderJunction[] {
  const junctions: RenderJunction[] = [];
  for (let index = 1; index < clips.length; index += 1) {
    const prev = clips[index - 1];
    const next = clips[index];
    if (!prev || !next) {
      continue;
    }
    const overlapMs = overlapMsForJunction(prev, next);
    const reason = junctionReason(prev, next);
    if (overlapMs <= 0) {
      junctions.push({
        index,
        audio: "concat",
        video: "concat",
        overlapMs: 0,
        reason,
      });
      continue;
    }
    const video: VideoJoinKind = needsVideoXfade(prev, next)
      ? "xfade"
      : "trim-concat";
    junctions.push({
      index,
      audio: "acrossfade",
      video,
      overlapMs,
      reason,
    });
  }
  return junctions;
}

export function renderOutputDurationMs(clips: RenderGraphClip[]): number {
  if (clips.length === 0) {
    return 0;
  }
  const raw = clips.reduce((sum, clip) => sum + clipDurationMs(clip), 0);
  const overlap = planJunctions(clips).reduce(
    (sum, junction) => sum + junction.overlapMs,
    0,
  );
  return Math.max(0, raw - overlap);
}

export function msToSec(ms: number): string {
  return (ms / 1000).toFixed(3);
}

export function clipAudioFilters(
  clip: RenderGraphClip,
  index: number,
  route: ResolvedAudioRoute,
  singleClip: boolean,
): string[] {
  const start = msToSec(clip.startMs);
  const end = msToSec(clip.endMs);
  let fade = "";
  if (singleClip) {
    const fadeSec = msToSec(AUDIO_CROSSFADE_MS);
    const fadeOutStart = msToSec(
      Math.max(0, clipDurationMs(clip) - AUDIO_CROSSFADE_MS),
    );
    fade = `,afade=t=in:d=${fadeSec},afade=t=out:st=${fadeOutStart}:d=${fadeSec}`;
  }
  switch (route.kind) {
    case "input":
      return [
        `[${route.inputIndex}:a]atrim=start=${start}:end=${end},asetpts=PTS-STARTPTS,${CHANNEL_LAYOUT_STEREO}${fade}[a${index}]`,
      ];
    case "mics":
      return [
        `[${route.micA}:a]atrim=start=${start}:end=${end},asetpts=PTS-STARTPTS,${CHANNEL_LAYOUT_MONO}[ma${index}]`,
        `[${route.micB}:a]atrim=start=${start}:end=${end},asetpts=PTS-STARTPTS,${CHANNEL_LAYOUT_MONO}[mb${index}]`,
        `[ma${index}][mb${index}]${CHANNEL_JOIN_STEREO}${fade}[a${index}]`,
      ];
    default: {
      const _never: never = route;
      return _never;
    }
  }
}

export function buildRenderFilterComplex(input: {
  clips: RenderGraphClip[];
  indexByCamera?: Partial<Record<CameraId, number>>;
  cameraOffsetsMs?: Partial<Record<CameraId, number>>;
  audioRoute?: AudioRouteInput;
  scale: string;
  loudnorm: boolean;
  loudnessFilter?: string;
  fontFile?: string;
  captionDir?: string;
}): RenderGraph {
  const clips = input.clips;
  const junctions = planJunctions(clips);
  const audioRoute = resolveAudioRoute(input.audioRoute);
  if (clips.length === 0) {
    return { filterComplex: "", durationMs: 0, junctions, audioRoute };
  }
  const indexByCamera = input.indexByCamera ?? { A: 0 };
  const fontFile = input.fontFile ?? BURN_IN_FONT;
  const filters: string[] = [];
  const singleClip = clips.length === 1;

  const cameraOffsetsMs = input.cameraOffsetsMs ?? {};
  clips.forEach((clip, index) => {
    const camera = clip.camera ?? "A";
    const videoIndex = videoInputIndex(camera, indexByCamera);
    const picture = cameraTrimMs(
      clip.startMs,
      clip.endMs,
      cameraOffsetsMs[camera] ?? 0,
    );
    const pictureStart = msToSec(picture.startMs);
    const pictureEnd = msToSec(picture.endMs);
    const punch =
      clip.punchIn === true ? ",scale=1472:828,crop=1280:720" : "";
    const caption =
      clip.burnIn && clip.text?.trim()
        ? `,${burnInFilter(captionFilePath(index, input.captionDir), fontFile)}`
        : "";
    filters.push(
      `[${videoIndex}:v]trim=start=${pictureStart}:end=${pictureEnd},setpts=PTS-STARTPTS${punch}${caption},${input.scale},format=yuv420p[v${index}]`,
    );
    filters.push(...clipAudioFilters(clip, index, audioRoute, singleClip));
  });

  let videoAcc = "v0";
  let audioAcc = "a0";
  let accMs = clipDurationMs(clips[0]!);
  junctions.forEach((junction) => {
    const clip = clips[junction.index];
    if (!clip) {
      return;
    }
    const nextVideo = `v${junction.index}`;
    const nextAudio = `a${junction.index}`;
    const videoOut = `vm${junction.index}`;
    const audioOut = `am${junction.index}`;
    switch (junction.video) {
      case "xfade": {
        const offset = msToSec(accMs - junction.overlapMs);
        const duration = msToSec(junction.overlapMs);
        filters.push(
          `[${videoAcc}][${nextVideo}]xfade=transition=fade:duration=${duration}:offset=${offset}[${videoOut}]`,
        );
        break;
      }
      case "trim-concat": {
        const start = msToSec(junction.overlapMs);
        filters.push(
          `[${nextVideo}]trim=start=${start},setpts=PTS-STARTPTS[${nextVideo}t]`,
        );
        filters.push(
          `[${videoAcc}][${nextVideo}t]concat=n=2:v=1:a=0[${videoOut}]`,
        );
        break;
      }
      case "concat": {
        filters.push(
          `[${videoAcc}][${nextVideo}]concat=n=2:v=1:a=0[${videoOut}]`,
        );
        break;
      }
      default: {
        const _never: never = junction.video;
        return _never;
      }
    }
    switch (junction.audio) {
      case "acrossfade": {
        const duration = msToSec(junction.overlapMs);
        filters.push(
          `[${audioAcc}][${nextAudio}]acrossfade=d=${duration}:c1=tri:c2=tri[${audioOut}]`,
        );
        break;
      }
      case "concat": {
        filters.push(
          `[${audioAcc}][${nextAudio}]concat=n=2:v=0:a=1[${audioOut}]`,
        );
        break;
      }
      default: {
        const _never: never = junction.audio;
        return _never;
      }
    }
    videoAcc = videoOut;
    audioAcc = audioOut;
    accMs += clipDurationMs(clip) - junction.overlapMs;
  });

  filters.push(`[${videoAcc}]copy[v]`);
  filters.push(
    `[${audioAcc}]${audioTailFilter(input.loudnorm, input.loudnessFilter)}[a]`,
  );

  return {
    filterComplex: filters.join(";"),
    durationMs: accMs,
    junctions,
    audioRoute,
  };
}

export function toRenderGraphClips(
  handled: { startMs: number; endMs: number }[],
  source: RenderGraphClip[],
): RenderGraphClip[] {
  return handled.map((clip, index) => {
    const original = source[index];
    return {
      startMs: clip.startMs,
      endMs: clip.endMs,
      camera: original?.camera,
      punchIn: original?.punchIn,
      morph: original?.morph,
      text: original?.text,
      burnIn: original?.burnIn,
      role: original?.role,
      sourceStartMs: original?.sourceStartMs ?? original?.startMs,
      sourceEndMs: original?.sourceEndMs ?? original?.endMs,
    };
  });
}

export async function renderKeptClips(input: {
  sourcePath: string;
  outputPath: string;
  clips: {
    startMs: number;
    endMs: number;
    camera?: "A" | "B" | "WIDE";
    punchIn?: boolean;
    morph?: boolean;
    text?: string;
    burnIn?: boolean;
    role?: string;
    verdict?: "keep" | "cut" | "review";
    verdictSource?: "code" | "user";
    semanticStartMs?: number;
    semanticEndMs?: number;
  }[];
  sourceDurationMs?: number;
  cameraPaths?: Partial<Record<"A" | "B" | "WIDE", string>>;
  cameraOffsetsMs?: Partial<Record<CameraId, number>>;
  micPaths?: Partial<Record<"A" | "B", string>>;
  loudness?: LoudnessProfile;
  preset?: ExportPreset;
}): Promise<void> {
  if (input.clips.length === 0) {
    throw new Error("残すクリップがありません");
  }
  const snapped = await applyAudioBoundaries(input.clips, {
    filePath: input.sourcePath,
    durationMs: input.sourceDurationMs,
  });
  const clips = withHandles(snapped, input.sourceDurationMs ?? 0).map(
    (clip, index) => {
      const original = input.clips[index];
      return {
        ...clip,
        camera: original?.camera,
        punchIn: original?.punchIn,
        morph: original?.morph,
        text: original?.text,
        burnIn: original?.burnIn,
        role: original?.role,
        sourceStartMs: original?.startMs,
        sourceEndMs: original?.endMs,
      };
    },
  );
  const planned = planInputIndices({
    cameraPaths: input.cameraPaths,
    micPaths: input.micPaths,
  });
  const cameraOffsetsMs =
    input.cameraOffsetsMs ??
    (await measureCameraOffsetsMs({
      sourcePath: input.sourcePath,
      cameraPaths: input.cameraPaths,
    }));
  const inputs: string[] = [input.sourcePath, ...planned.extras];
  const preset = parseExportPreset(input.preset);
  const loudness = loudnessForPreset(preset, input.loudness);
  try {
    await runConcat(
      inputs,
      input.outputPath,
      clips,
      planned.indexByCamera,
      cameraOffsetsMs,
      planned.audioRoute,
      true,
      loudness,
      preset,
    );
  } catch (error) {
    if (error instanceof MissingCameraError) {
      throw error;
    }
    await runConcat(
      inputs,
      input.outputPath,
      clips,
      planned.indexByCamera,
      cameraOffsetsMs,
      planned.audioRoute,
      false,
      loudness,
      preset,
    );
  }
}

async function runConcat(
  inputs: string[],
  outputPath: string,
  clips: RenderGraphClip[],
  indexByCamera: Partial<Record<"A" | "B" | "WIDE", number>>,
  cameraOffsetsMs: Partial<Record<CameraId, number>>,
  audioRoute: AudioRouteInput,
  loudnorm: boolean,
  loudness: LoudnessProfile,
  preset: ExportPreset,
): Promise<void> {
  const captionDir = await mkdtemp(path.join(os.tmpdir(), "cutline-caption-"));
  await writeBurnInFiles(clips, captionDir);
  const graph = buildRenderFilterComplex({
    clips,
    indexByCamera,
    cameraOffsetsMs,
    audioRoute,
    scale: scaleFilter(preset),
    loudnorm,
    loudnessFilter: loudnormFilter(loudness),
    captionDir,
  });
  const args = ["-y"];
  for (const filePath of inputs) {
    args.push(...userMediaOpenArgs(), "-i", filePath);
  }
  const encoder = await detectVideoEncoder();
  args.push(
    "-filter_complex",
    graph.filterComplex,
    "-map",
    "[v]",
    "-map",
    "[a]",
    ...outputCodecArgs(preset, encoder),
    outputPath,
  );
  await execFileAsync("ffmpeg", args);
}

export function outputCodecArgs(preset: ExportPreset, encoder: string): string[] {
  if (preset === "archive-prores") {
    return ["-c:v", "prores_ks", "-profile:v", "3", "-c:a", "pcm_s16le"];
  }
  const videoCodec =
    encoder === "libx264"
      ? ["-c:v", "libx264", "-preset", "veryfast", "-crf", "18"]
      : ["-c:v", encoder];
  return [...videoCodec, "-c:a", "aac", "-movflags", "+faststart"];
}

let cachedEncoder: string | undefined;

export async function detectVideoEncoder(): Promise<string> {
  if (cachedEncoder) {
    return cachedEncoder;
  }
  const candidates = ["h264_nvenc", "h264_videotoolbox", "h264_qsv", "libx264"];
  for (const name of candidates) {
    if (await encoderWorks(name)) {
      cachedEncoder = name;
      return name;
    }
  }
  cachedEncoder = "libx264";
  return cachedEncoder;
}

async function encoderWorks(name: string): Promise<boolean> {
  try {
    await execFileAsync("ffmpeg", [
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
    ]);
    return true;
  } catch {
    return false;
  }
}

export async function ensureSampleCameras(): Promise<{
  A: string;
  B: string;
  WIDE: string;
}> {
  const dir = path.join(os.tmpdir(), "cutline");
  await mkdir(dir, { recursive: true });
  const A = await ensureSampleVideo();
  const B = path.join(dir, "sample-cam-b.mp4");
  const WIDE = path.join(dir, "sample-cam-wide.mp4");
  await writeSolidCamera(B, "0x1e3a5f", 330);
  await writeSolidCamera(WIDE, "0x365314", 110);
  return { A, B, WIDE };
}

async function writeSolidCamera(
  dest: string,
  color: string,
  hz: number,
): Promise<void> {
  try {
    await access(dest);
    return;
  } catch {
    // generate
  }
  await execFileAsync("ffmpeg", [
    "-y",
    "-f",
    "lavfi",
    "-i",
    `color=c=${color}:s=1280x720:d=${SAMPLE_DURATION_SEC}`,
    "-f",
    "lavfi",
    "-i",
    `sine=frequency=${hz}:duration=${SAMPLE_DURATION_SEC}`,
    "-shortest",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-b:a",
    "96k",
    dest,
  ]);
}

export function sampleDurationMs(): number {
  return SAMPLE_DURATION_SEC * 1000;
}

export async function measureCameraOffsetsMs(input: {
  sourcePath: string;
  cameraPaths?: Partial<Record<CameraId, string>>;
}): Promise<Partial<Record<CameraId, number>>> {
  const offsets: Partial<Record<CameraId, number>> = { A: 0 };
  const extras = (["B", "WIDE"] as const).flatMap((id) => {
    const filePath = input.cameraPaths?.[id];
    return filePath ? [{ id, filePath }] : [];
  });
  if (!input.sourcePath || extras.length === 0) {
    return offsets;
  }
  try {
    const reference = await probeMediaMetadata(input.sourcePath, {
      probe: probeWhitelisted,
    });
    const tracks: SyncableTrack[] = [syncTrackFromMetadata("mix", reference)];
    for (const extra of extras) {
      const meta = await probeMediaMetadata(extra.filePath, {
        probe: probeWhitelisted,
      });
      tracks.push(syncTrackFromMetadata(extra.id, meta));
    }
    const synced = await syncTracks(tracks, {
      referenceId: "mix",
      extractWaveform: extractUserWaveform,
    });
    for (const extra of extras) {
      offsets[extra.id] =
        synced.offsets.find((item) => item.id === extra.id)?.offsetMs ?? 0;
    }
  } catch {
    return offsets;
  }
  return offsets;
}

async function writeBurnInFiles(
  clips: RenderGraphClip[],
  captionDir: string,
): Promise<void> {
  await mkdir(captionDir, { recursive: true });
  await Promise.all(
    clips.map(async (clip, index) => {
      const text = clip.text?.trim();
      if (!clip.burnIn || !text) {
        return;
      }
      await writeFile(path.join(captionDir, `caption-${index}.txt`), text, "utf8");
    }),
  );
}

async function probeWhitelisted(filePath: string): Promise<FfprobeJson> {
  const { stdout } = await execFileAsync("ffprobe", [
    ...userMediaOpenArgs(),
    "-v",
    "error",
    "-print_format",
    "json",
    "-show_format",
    "-show_streams",
    filePath,
  ]);
  return JSON.parse(stdout) as FfprobeJson;
}

function syncTrackFromMetadata(
  id: string,
  meta: Awaited<ReturnType<typeof probeMediaMetadata>>,
): SyncableTrack {
  const fps = meta.fps && meta.fps > 0 ? meta.fps : 30;
  const audioFromSamples =
    meta.audioTimeReferenceSamples != null && meta.sampleRate
      ? Math.round((meta.audioTimeReferenceSamples / meta.sampleRate) * 1000)
      : null;
  return {
    id,
    filePath: meta.filePath,
    embeddedTimecodeMs: parseSmpteTimecodeMs(meta.embeddedTimecode, fps),
    audioTimecodeMs:
      parseSmpteTimecodeMs(meta.audioTimecode, fps) ?? audioFromSamples,
    audioTimeReferenceSamples: meta.audioTimeReferenceSamples,
    sampleRate: meta.sampleRate,
  };
}

async function extractUserWaveform(
  filePath: string,
): Promise<{ samples: Float32Array; sampleRate: number }> {
  const sampleRate = 8000;
  const { stdout } = await execFileAsync(
    "ffmpeg",
    [
      ...userMediaOpenArgs(),
      "-v",
      "error",
      "-i",
      filePath,
      "-t",
      "20",
      "-ac",
      "1",
      "-ar",
      String(sampleRate),
      "-f",
      "f32le",
      "-acodec",
      "pcm_f32le",
      "pipe:1",
    ],
    { encoding: "buffer", maxBuffer: 32 * 1024 * 1024 },
  );
  const buffer = stdout as unknown as Buffer;
  const aligned = new Float32Array(
    buffer.buffer,
    buffer.byteOffset,
    Math.floor(buffer.byteLength / 4),
  );
  return { samples: new Float32Array(aligned), sampleRate };
}
