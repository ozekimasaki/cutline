import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pythonWorkerPath } from "./engine";
import { buildFilterComplexCommand } from "./export";
import {
  AUDIO_CROSSFADE_MS,
  VIDEO_XFADE_MS,
  MissingCameraError,
  USER_MEDIA_FORMAT_WHITELIST,
  USER_MEDIA_PROTOCOL_WHITELIST,
  buildRenderFilterComplex,
  cameraTrimMs,
  isConversationCut,
  userMediaOpenArgs,
  isRemainingJumpCut,
  loudnormFilter,
  needsVideoXfade,
  planJunctions,
  renderOutputDurationMs,
  scaleFilter,
  toRenderGraphClips,
  withHandles,
  type RenderGraphClip,
} from "./ffmpeg";
import type { JevSignals, ScoredClip } from "./types";

function clip(partial: Partial<RenderGraphClip> & Pick<RenderGraphClip, "startMs" | "endMs">): RenderGraphClip {
  return {
    camera: "A",
    role: "content",
    sourceStartMs: partial.sourceStartMs ?? partial.startMs,
    sourceEndMs: partial.sourceEndMs ?? partial.endMs,
    ...partial,
  };
}

function signals(): JevSignals {
  return {
    importance: 0.8,
    novelty: 0.5,
    redundancy: 0.1,
    contextRequired: 0.4,
    filler: 0.05,
    falseStart: 0.04,
    selfCorrection: 0.04,
    tangent: 0.05,
    humanTexture: 0.3,
    removalNatural: 0.2,
    reactionValue: 0.1,
    reviewRequired: 0.08,
    confidence: 0.92,
    provider: "mock",
  };
}

function scored(
  id: string,
  startMs: number,
  endMs: number,
  extra: Partial<ScoredClip> = {},
): ScoredClip {
  return {
    id,
    speaker: extra.speaker ?? "A",
    text: extra.text ?? id,
    startMs,
    endMs,
    role: extra.role ?? "content",
    signals: extra.signals ?? signals(),
    keepScore: extra.keepScore ?? 0.8,
    autoMarker: false,
    verdict: extra.verdict ?? "keep",
    verdictSource: extra.verdictSource ?? "code",
    reason: extra.reason ?? id,
    camera: extra.camera,
    punchIn: extra.punchIn,
    morph: extra.morph,
  };
}

function graphOf(clips: RenderGraphClip[]) {
  return buildRenderFilterComplex({
    clips,
    indexByCamera: { A: 0, B: 1, WIDE: 2 },
    scale: scaleFilter("youtube-1080p"),
    loudnorm: true,
    loudnessFilter: loudnormFilter("youtube"),
  });
}

describe("render graph transitions", () => {
  it("does not xfade KEEP semantic pauses", () => {
    const clips = [
      clip({ startMs: 0, endMs: 1000, role: "content" }),
      clip({ startMs: 1000, endMs: 2200, role: "pause" }),
      clip({ startMs: 2200, endMs: 3400, role: "content" }),
    ];
    assert.equal(needsVideoXfade(clips[0]!, clips[1]!), false);
    assert.equal(needsVideoXfade(clips[1]!, clips[2]!), false);
    const junctions = planJunctions(clips);
    assert.equal(junctions[0]?.video, "trim-concat");
    assert.equal(junctions[0]?.audio, "acrossfade");
    assert.equal(junctions[0]?.overlapMs, AUDIO_CROSSFADE_MS);
    assert.equal(junctions[1]?.video, "trim-concat");
    const built = graphOf(clips);
    assert.match(built.filterComplex, /acrossfade=d=0\.040:c1=tri:c2=tri/);
    assert.doesNotMatch(built.filterComplex, /xfade=/);
    assert.match(built.filterComplex, /trim=start=0\.040,setpts=PTS-STARTPTS\[v1t\]/);
    assert.match(built.filterComplex, /highpass=f=80,afftdn=nr=12:nf=-25/);
    assert.match(built.filterComplex, /agate=threshold=0\.025:ratio=8:attack=10:release=300/);
    assert.match(built.filterComplex, /loudnorm=I=-14:TP=-1\.5:LRA=11/);
    assert.doesNotMatch(built.filterComplex, /silenceremove/);
  });

  it("uses xfade on camera change, punch-in, and remaining jump-cut morph", () => {
    const cameraChange = [
      clip({ startMs: 0, endMs: 1000, camera: "A", sourceEndMs: 1000 }),
      clip({
        startMs: 2000,
        endMs: 3200,
        camera: "B",
        sourceStartMs: 2000,
        sourceEndMs: 3200,
      }),
    ];
    assert.equal(isConversationCut(cameraChange[0]!, cameraChange[1]!), true);
    assert.equal(needsVideoXfade(cameraChange[0]!, cameraChange[1]!), true);
    const cameraGraph = graphOf(cameraChange);
    assert.equal(cameraGraph.junctions[0]?.reason, "camera");
    assert.equal(cameraGraph.junctions[0]?.video, "xfade");
    assert.equal(cameraGraph.junctions[0]?.overlapMs, VIDEO_XFADE_MS);
    assert.match(
      cameraGraph.filterComplex,
      /xfade=transition=fade:duration=0\.120:offset=0\.880/,
    );
    assert.match(cameraGraph.filterComplex, /acrossfade=d=0\.120:c1=tri:c2=tri/);
    assert.equal(cameraGraph.durationMs, 1000 + 1200 - VIDEO_XFADE_MS);

    const punch = [
      clip({ startMs: 0, endMs: 1000, punchIn: false }),
      clip({ startMs: 1800, endMs: 3000, punchIn: true, sourceStartMs: 1800 }),
    ];
    const punchGraph = graphOf(punch);
    assert.equal(punchGraph.junctions[0]?.reason, "punch-in");
    assert.match(punchGraph.filterComplex, /xfade=transition=fade/);
    assert.match(punchGraph.filterComplex, /scale=1472:828,crop=1280:720/);

    const sameCamCut = [
      clip({ startMs: 0, endMs: 1000, camera: "A", sourceEndMs: 1000 }),
      clip({
        startMs: 4000,
        endMs: 5200,
        camera: "A",
        sourceStartMs: 4000,
      }),
    ];
    assert.equal(isRemainingJumpCut(sameCamCut[0]!, sameCamCut[1]!), true);
    assert.equal(needsVideoXfade(sameCamCut[0]!, sameCamCut[1]!), true);
    const cutGraph = graphOf(sameCamCut);
    assert.equal(cutGraph.junctions[0]?.reason, "morph");
    assert.equal(cutGraph.junctions[0]?.video, "xfade");
    assert.equal(cutGraph.junctions[0]?.audio, "acrossfade");
    assert.equal(cutGraph.junctions[0]?.overlapMs, VIDEO_XFADE_MS);
    assert.match(cutGraph.filterComplex, /xfade=transition=fade:duration=0\.120/);
    assert.match(cutGraph.filterComplex, /acrossfade=d=0\.120:c1=tri:c2=tri/);

    const consecutivePunch = [
      clip({ startMs: 0, endMs: 1000, camera: "A", punchIn: true, morph: true }),
      clip({
        startMs: 4000,
        endMs: 5200,
        camera: "A",
        punchIn: true,
        morph: true,
        sourceStartMs: 4000,
      }),
    ];
    assert.equal(needsVideoXfade(consecutivePunch[0]!, consecutivePunch[1]!), true);
    const morphGraph = graphOf(consecutivePunch);
    assert.equal(morphGraph.junctions[0]?.reason, "morph");
    assert.match(morphGraph.filterComplex, /xfade=transition=fade/);
    assert.match(morphGraph.filterComplex, /acrossfade=/);
  });

  it("does not morph KEEP semantic pauses even across a source gap", () => {
    const clips = [
      clip({ startMs: 0, endMs: 1000, role: "content", sourceEndMs: 1000 }),
      clip({
        startMs: 4000,
        endMs: 5200,
        role: "pause",
        sourceStartMs: 4000,
        morph: true,
      }),
      clip({
        startMs: 5200,
        endMs: 6400,
        role: "content",
        sourceStartMs: 5200,
      }),
    ];
    assert.equal(needsVideoXfade(clips[0]!, clips[1]!), false);
    assert.equal(needsVideoXfade(clips[1]!, clips[2]!), false);
    const built = graphOf(clips);
    assert.equal(built.junctions[0]?.reason, "conversation-cut");
    assert.equal(built.junctions[0]?.video, "trim-concat");
    assert.equal(built.junctions[0]?.audio, "acrossfade");
    assert.doesNotMatch(built.filterComplex, /xfade=/);
    assert.match(built.filterComplex, /acrossfade=d=0\.040:c1=tri:c2=tri/);
  });

  it("keeps A/V duration in lockstep after overlaps", () => {
    const clips = [
      clip({ startMs: 0, endMs: 2000, camera: "A" }),
      clip({ startMs: 2500, endMs: 4500, camera: "B", sourceStartMs: 2500 }),
      clip({ startMs: 4500, endMs: 6000, role: "pause", sourceStartMs: 4500 }),
    ];
    const duration = renderOutputDurationMs(clips);
    const built = graphOf(clips);
    assert.equal(built.durationMs, duration);
    assert.equal(
      duration,
      2000 + 2000 + 1500 - VIDEO_XFADE_MS - AUDIO_CROSSFADE_MS,
    );
  });
});

describe("export filter_complex download", () => {
  it("emits acrossfade and camera xfade from Timeline IR clips", () => {
    const command = buildFilterComplexCommand({
      fileName: "sample.mp4",
      clips: [
        scored("a", 0, 2000, { camera: "A", text: "今日は" }),
        scored("b", 4000, 6000, { camera: "B", speaker: "B", text: "反応" }),
      ],
    });
    assert.match(command, /acrossfade=/);
    assert.match(command, /xfade=transition=fade/);
  });
});

describe("python worker graph matches TypeScript", () => {
  it("returns the same filter_complex for handled clips", () => {
    const source: RenderGraphClip[] = [
      clip({ startMs: 1000, endMs: 3000, camera: "A", role: "content" }),
      clip({
        startMs: 5000,
        endMs: 7000,
        camera: "B",
        role: "content",
        sourceStartMs: 5000,
        sourceEndMs: 7000,
      }),
      clip({
        startMs: 7000,
        endMs: 8500,
        camera: "B",
        role: "pause",
        sourceStartMs: 7000,
        sourceEndMs: 8500,
      }),
    ];
    const handled = withHandles(source, 24_000);
    const ts = buildRenderFilterComplex({
      clips: toRenderGraphClips(handled, source),
      indexByCamera: { A: 0, B: 1 },
      scale: scaleFilter("youtube-1080p"),
      loudnorm: true,
      loudnessFilter: loudnormFilter("youtube"),
    });
    const python = spawnSync("python3", [pythonWorkerPath()], {
      input: JSON.stringify({
        command: "graph",
        sourceDurationMs: 24_000,
        preset: "youtube-1080p",
        loudness: "youtube",
        cameraPaths: { B: "/tmp/cam-b.mp4" },
        clips: source,
      }),
      encoding: "utf8",
      timeout: 15_000,
    });
    assert.equal(python.status, 0, python.stderr);
    const parsed = JSON.parse(python.stdout) as {
      ok: boolean;
      filterComplex: string;
      durationMs: number;
    };
    assert.equal(parsed.ok, true);
    assert.equal(parsed.filterComplex, ts.filterComplex);
    assert.equal(parsed.durationMs, ts.durationMs);
  });

  it("matches TypeScript morph xfade on a remaining same-camera jump", () => {
    const source: RenderGraphClip[] = [
      clip({ startMs: 0, endMs: 1000, camera: "A", role: "content" }),
      clip({
        startMs: 4000,
        endMs: 5200,
        camera: "A",
        role: "content",
        sourceStartMs: 4000,
        sourceEndMs: 5200,
        morph: true,
      }),
    ];
    const handled = withHandles(source, 24_000);
    const ts = buildRenderFilterComplex({
      clips: toRenderGraphClips(handled, source),
      indexByCamera: { A: 0 },
      scale: scaleFilter("youtube-1080p"),
      loudnorm: true,
      loudnessFilter: loudnormFilter("youtube"),
    });
    const python = spawnSync("python3", [pythonWorkerPath()], {
      input: JSON.stringify({
        command: "graph",
        sourceDurationMs: 24_000,
        preset: "youtube-1080p",
        loudness: "youtube",
        clips: source,
      }),
      encoding: "utf8",
      timeout: 15_000,
    });
    assert.equal(python.status, 0, python.stderr);
    const parsed = JSON.parse(python.stdout) as {
      ok: boolean;
      filterComplex: string;
      durationMs: number;
    };
    assert.equal(parsed.ok, true);
    assert.match(ts.filterComplex, /xfade=transition=fade/);
    assert.equal(parsed.filterComplex, ts.filterComplex);
    assert.equal(parsed.durationMs, ts.durationMs);
  });
});

describe("ffmpeg xfade smoke", () => {
  it("renders two camera clips without A/V desync", (t) => {
    const ffmpeg = spawnSync("ffmpeg", ["-version"], { encoding: "utf8" });
    if (ffmpeg.status !== 0) {
      t.skip("ffmpeg がありません");
      return;
    }
    const dir = mkdtempSync(path.join(os.tmpdir(), "cutline-xfade-"));
    const camA = path.join(dir, "a.mp4");
    const camB = path.join(dir, "b.mp4");
    const output = path.join(dir, "out.mp4");
    for (const [file, color, hz] of [
      [camA, "0xc2410c", "220"],
      [camB, "0x1e3a5f", "330"],
    ] as const) {
      const make = spawnSync(
        "ffmpeg",
        [
          "-y",
          "-f",
          "lavfi",
          "-i",
          `color=c=${color}:s=1280x720:d=2`,
          "-f",
          "lavfi",
          "-i",
          `sine=frequency=${hz}:duration=2`,
          "-shortest",
          "-c:v",
          "libx264",
          "-pix_fmt",
          "yuv420p",
          "-c:a",
          "aac",
          file,
        ],
        { encoding: "utf8" },
      );
      assert.equal(make.status, 0, make.stderr);
    }
    const render = spawnSync("python3", [pythonWorkerPath()], {
      input: JSON.stringify({
        command: "render",
        sourcePath: camA,
        outputPath: output,
        sourceDurationMs: 2000,
        preset: "youtube-1080p",
        loudness: "youtube",
        cameraPaths: { B: camB },
        clips: [
          { startMs: 0, endMs: 800, camera: "A", role: "content" },
          { startMs: 800, endMs: 1600, camera: "B", role: "content" },
        ],
      }),
      encoding: "utf8",
      timeout: 120_000,
      maxBuffer: 20 * 1024 * 1024,
    });
    assert.equal(render.status, 0, render.stderr);
    const rendered = JSON.parse(render.stdout) as { ok: boolean };
    assert.equal(rendered.ok, true);
    const validate = spawnSync("python3", [pythonWorkerPath()], {
      input: JSON.stringify({
        command: "validate",
        filePath: output,
        expectedDurationMs: renderOutputDurationMs(
          toRenderGraphClips(
            withHandles(
              [
                { startMs: 0, endMs: 800, camera: "A", role: "content" },
                { startMs: 800, endMs: 1600, camera: "B", role: "content" },
              ],
              2000,
            ),
            [
              { startMs: 0, endMs: 800, camera: "A", role: "content" },
              { startMs: 800, endMs: 1600, camera: "B", role: "content" },
            ],
          ),
        ),
      }),
      encoding: "utf8",
      timeout: 60_000,
    });
    assert.equal(validate.status, 0, validate.stderr);
    const checked = JSON.parse(validate.stdout) as {
      hasAudio: boolean;
      hasVideo: boolean;
      avSyncOk: boolean;
      ok: boolean;
    };
    assert.equal(checked.hasAudio, true);
    assert.equal(checked.hasVideo, true);
    assert.equal(checked.avSyncOk, true);
    assert.equal(checked.ok, true);
  });
});

describe("camera sync trim", () => {
  it("adds the measured offset to that camera and leaves mix audio", () => {
    assert.deepEqual(cameraTrimMs(1000, 2500, 333), { startMs: 1333, endMs: 2833 });
    const graph = buildRenderFilterComplex({
      clips: [clip({ startMs: 1000, endMs: 2500, camera: "B" })],
      indexByCamera: { A: 0, B: 1 },
      cameraOffsetsMs: { B: 333 },
      scale: scaleFilter("youtube-1080p"),
      loudnorm: true,
      loudnessFilter: loudnormFilter("youtube"),
    });
    assert.match(graph.filterComplex, /\[1:v\]trim=start=1\.333:end=2\.833/);
    assert.match(graph.filterComplex, /\[0:a\]atrim=start=1\.000:end=2\.500/);
  });

  it("fails instead of using input 0 when the camera file is missing", () => {
    assert.throws(
      () =>
        buildRenderFilterComplex({
          clips: [clip({ startMs: 0, endMs: 1000, camera: "WIDE" })],
          indexByCamera: { A: 0 },
          scale: scaleFilter("youtube-1080p"),
          loudnorm: true,
          loudnessFilter: loudnormFilter("youtube"),
        }),
      (error: unknown) => error instanceof MissingCameraError,
    );
  });

  it("burns captions from a server textfile", () => {
    const graph = buildRenderFilterComplex({
      clips: [
        clip({
          startMs: 0,
          endMs: 1000,
          burnIn: true,
          text: "a,b'c:d",
        }),
      ],
      indexByCamera: { A: 0 },
      captionDir: "/tmp/caps",
      scale: scaleFilter("youtube-1080p"),
      loudnorm: true,
      loudnessFilter: loudnormFilter("youtube"),
    });
    assert.match(graph.filterComplex, /textfile=/);
    assert.match(graph.filterComplex, /expansion=none/);
    assert.doesNotMatch(graph.filterComplex, /a,b/);
    assert.doesNotMatch(graph.filterComplex, /text='/);
  });

  it("opens user media without playlist demuxers", () => {
    const args = userMediaOpenArgs();
    assert.ok(args.includes(USER_MEDIA_PROTOCOL_WHITELIST));
    const formats = args[args.indexOf("-format_whitelist") + 1] ?? "";
    assert.equal(formats, USER_MEDIA_FORMAT_WHITELIST);
    assert.doesNotMatch(formats, /(?:^|,)(?:hls|concat|dash)(?:,|$)/);
    const ffmpeg = spawnSync("ffprobe", ["-version"], { encoding: "utf8" });
    if (ffmpeg.status !== 0) {
      return;
    }
    const dir = mkdtempSync(path.join(os.tmpdir(), "cutline-playlist-"));
    const side = path.join(dir, "side.mp4");
    const playlist = path.join(dir, "clip.m3u8");
    const made = spawnSync(
      "ffmpeg",
      [
        "-y",
        "-f",
        "lavfi",
        "-i",
        "color=c=0xc2410c:s=320x180:d=0.2",
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        side,
      ],
      { encoding: "utf8" },
    );
    assert.equal(made.status, 0, made.stderr);
    const body = `#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:1\n#EXTINF:0.2,\n${side}\n#EXT-X-ENDLIST\n`;
    writeFileSync(playlist, body, "utf8");
    const blocked = spawnSync(
      "ffprobe",
      [
        ...userMediaOpenArgs(),
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-of",
        "default=nw=1",
        playlist,
      ],
      { encoding: "utf8" },
    );
    assert.notEqual(blocked.status, 0);
    assert.doesNotMatch(`${blocked.stdout}`, /duration=/);
  });

  it("matches the python graph when a camera offset is applied", () => {
    const source: RenderGraphClip[] = [
      clip({ startMs: 1000, endMs: 3000, camera: "B" }),
    ];
    const ts = buildRenderFilterComplex({
      clips: toRenderGraphClips(withHandles(source, 24_000), source),
      indexByCamera: { A: 0, B: 1 },
      cameraOffsetsMs: { B: 400 },
      scale: scaleFilter("youtube-1080p"),
      loudnorm: true,
      loudnessFilter: loudnormFilter("youtube"),
    });
    const python = spawnSync("python3", [pythonWorkerPath()], {
      input: JSON.stringify({
        command: "graph",
        sourceDurationMs: 24_000,
        preset: "youtube-1080p",
        loudness: "youtube",
        cameraPaths: { B: "/tmp/cam-b.mp4" },
        cameraOffsetsMs: { B: 400 },
        clips: source,
      }),
      encoding: "utf8",
      timeout: 15_000,
    });
    assert.equal(python.status, 0, python.stderr);
    const parsed = JSON.parse(python.stdout) as { filterComplex: string };
    assert.equal(parsed.filterComplex, ts.filterComplex);
    assert.match(parsed.filterComplex, /trim=start=1\.320:end=3\.500/);
  });
});
