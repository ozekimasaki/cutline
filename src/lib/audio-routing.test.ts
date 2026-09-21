import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pythonWorkerPath } from "./engine";
import {
  CHANNEL_LAYOUT_STEREO,
  audioProcessFilter,
  audioTailFilter,
  buildRenderFilterComplex,
  loudnormFilter,
  planInputIndices,
  renderOutputDurationMs,
  resolveAudioRoute,
  scaleFilter,
  toRenderGraphClips,
  withHandles,
  type RenderGraphClip,
} from "./ffmpeg";

function clip(
  partial: Partial<RenderGraphClip> & Pick<RenderGraphClip, "startMs" | "endMs">,
): RenderGraphClip {
  return {
    camera: "A",
    role: "content",
    sourceStartMs: partial.sourceStartMs ?? partial.startMs,
    sourceEndMs: partial.sourceEndMs ?? partial.endMs,
    ...partial,
  };
}

describe("audio routing and §59 processing", () => {
  it("prefers discrete mics over the camera mix", () => {
    assert.deepEqual(resolveAudioRoute(), { kind: "input", inputIndex: 0 });
    assert.deepEqual(resolveAudioRoute({ mixInputIndex: 0 }), {
      kind: "input",
      inputIndex: 0,
    });
    assert.deepEqual(resolveAudioRoute({ micAInputIndex: 3 }), {
      kind: "input",
      inputIndex: 3,
    });
    assert.deepEqual(resolveAudioRoute({ micBInputIndex: 4 }), {
      kind: "input",
      inputIndex: 4,
    });
    assert.deepEqual(
      resolveAudioRoute({
        mixInputIndex: 0,
        micAInputIndex: 2,
        micBInputIndex: 3,
      }),
      { kind: "mics", micA: 2, micB: 3 },
    );
  });

  it("assigns mic inputs after camera extras", () => {
    const planned = planInputIndices({
      cameraPaths: { B: "/tmp/cam-b.mp4", WIDE: "/tmp/wide.mp4" },
      micPaths: { A: "/tmp/mic-a.wav", B: "/tmp/mic-b.wav" },
    });
    assert.deepEqual(planned.indexByCamera, { A: 0, B: 1, WIDE: 2 });
    assert.deepEqual(planned.audioRoute, {
      mixInputIndex: 0,
      micAInputIndex: 3,
      micBInputIndex: 4,
    });
    assert.deepEqual(planned.extras, [
      "/tmp/cam-b.mp4",
      "/tmp/wide.mp4",
      "/tmp/mic-a.wav",
      "/tmp/mic-b.wav",
    ]);
  });

  it("downmixes mix to stereo, then denoise, gate, loudnorm", () => {
    const clips = [
      clip({ startMs: 0, endMs: 1000 }),
      clip({ startMs: 2000, endMs: 3200, sourceStartMs: 2000, camera: "B" }),
    ];
    const graph = buildRenderFilterComplex({
      clips,
      indexByCamera: { A: 0, B: 1 },
      scale: scaleFilter("youtube-1080p"),
      loudnorm: true,
      loudnessFilter: loudnormFilter("youtube"),
    });
    assert.equal(graph.audioRoute.kind, "input");
    assert.match(
      graph.filterComplex,
      /\[0:a\]atrim=start=0\.000:end=1\.000,asetpts=PTS-STARTPTS,aformat=channel_layouts=stereo\[a0\]/,
    );
    assert.match(graph.filterComplex, /acrossfade=d=0\.120:c1=tri:c2=tri/);
    assert.match(graph.filterComplex, /xfade=transition=fade/);
    assert.match(graph.filterComplex, /highpass=f=80,afftdn=nr=12:nf=-25/);
    assert.match(
      graph.filterComplex,
      /agate=threshold=0\.025:ratio=8:attack=10:release=300/,
    );
    assert.match(
      graph.filterComplex,
      /highpass=f=80,afftdn=nr=12:nf=-25,agate=threshold=0\.025:ratio=8:attack=10:release=300,loudnorm=I=-14:TP=-1\.5:LRA=11\[a\]/,
    );
    assert.doesNotMatch(graph.filterComplex, /silenceremove/);
    assert.equal(graph.durationMs, renderOutputDurationMs(clips));
  });

  it("joins Mic A to FL and Mic B to FR", () => {
    const clips = [
      clip({ startMs: 0, endMs: 1000 }),
      clip({ startMs: 1000, endMs: 2200, role: "pause" }),
    ];
    const graph = buildRenderFilterComplex({
      clips,
      indexByCamera: { A: 0, B: 1 },
      audioRoute: { mixInputIndex: 0, micAInputIndex: 2, micBInputIndex: 3 },
      scale: scaleFilter("youtube-1080p"),
      loudnorm: true,
      loudnessFilter: loudnormFilter("youtube"),
    });
    assert.deepEqual(graph.audioRoute, { kind: "mics", micA: 2, micB: 3 });
    assert.match(
      graph.filterComplex,
      /\[2:a\]atrim=start=0\.000:end=1\.000,asetpts=PTS-STARTPTS,aformat=channel_layouts=mono\[ma0\]/,
    );
    assert.match(
      graph.filterComplex,
      /\[3:a\]atrim=start=0\.000:end=1\.000,asetpts=PTS-STARTPTS,aformat=channel_layouts=mono\[mb0\]/,
    );
    assert.match(
      graph.filterComplex,
      /\[ma0\]\[mb0\]join=inputs=2:channel_layout=stereo:map=0\.0-FL\|1\.0-FR\[a0\]/,
    );
    assert.match(graph.filterComplex, /acrossfade=d=0\.040:c1=tri:c2=tri/);
    assert.doesNotMatch(graph.filterComplex, /xfade=/);
    assert.match(graph.filterComplex, /loudnorm=I=-14/);
  });

  it("keeps loudnorm when denoise is off the mix fallback path", () => {
    assert.equal(
      audioTailFilter(true, loudnormFilter("podcast")),
      `${audioProcessFilter()},${loudnormFilter("podcast")}`,
    );
    assert.equal(audioTailFilter(false), audioProcessFilter());
    assert.match(CHANNEL_LAYOUT_STEREO, /stereo/);
  });
});

describe("python worker audio graph matches TypeScript", () => {
  it("matches mix routing, denoise, gate, and loudnorm", () => {
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
      audioRoute: { kind: string; inputIndex?: number };
    };
    assert.equal(parsed.ok, true);
    assert.equal(parsed.filterComplex, ts.filterComplex);
    assert.equal(parsed.durationMs, ts.durationMs);
    assert.equal(parsed.audioRoute.kind, "input");
    assert.equal(parsed.audioRoute.inputIndex, 0);
  });

  it("matches dual-mic join after camera B", () => {
    const source: RenderGraphClip[] = [
      clip({ startMs: 0, endMs: 1200, camera: "A" }),
      clip({
        startMs: 2000,
        endMs: 3400,
        camera: "B",
        sourceStartMs: 2000,
        sourceEndMs: 3400,
      }),
    ];
    const planned = planInputIndices({
      cameraPaths: { B: "/tmp/cam-b.mp4" },
      micPaths: { A: "/tmp/mic-a.wav", B: "/tmp/mic-b.wav" },
    });
    const handled = withHandles(source, 24_000);
    const ts = buildRenderFilterComplex({
      clips: toRenderGraphClips(handled, source),
      indexByCamera: planned.indexByCamera,
      audioRoute: planned.audioRoute,
      scale: scaleFilter("youtube-1080p"),
      loudnorm: true,
      loudnessFilter: loudnormFilter("podcast"),
    });
    const python = spawnSync("python3", [pythonWorkerPath()], {
      input: JSON.stringify({
        command: "graph",
        sourceDurationMs: 24_000,
        preset: "podcast-video",
        loudness: "podcast",
        cameraPaths: { B: "/tmp/cam-b.mp4" },
        micPaths: { A: "/tmp/mic-a.wav", B: "/tmp/mic-b.wav" },
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
      audioRoute: { kind: string; micA?: number; micB?: number };
    };
    assert.equal(parsed.ok, true);
    assert.deepEqual(planned.audioRoute, {
      mixInputIndex: 0,
      micAInputIndex: 2,
      micBInputIndex: 3,
    });
    assert.equal(parsed.filterComplex, ts.filterComplex);
    assert.equal(parsed.durationMs, ts.durationMs);
    assert.equal(parsed.audioRoute.kind, "mics");
    assert.equal(parsed.audioRoute.micA, 2);
    assert.equal(parsed.audioRoute.micB, 3);
    assert.match(ts.filterComplex, /join=inputs=2:channel_layout=stereo/);
    assert.match(ts.filterComplex, /loudnorm=I=-16/);
    assert.match(ts.filterComplex, /acrossfade=/);
  });
});

describe("ffmpeg mic routing smoke", () => {
  it("renders dual mics without A/V desync", (t) => {
    const ffmpeg = spawnSync("ffmpeg", ["-version"], { encoding: "utf8" });
    if (ffmpeg.status !== 0) {
      t.skip("ffmpeg がありません");
      return;
    }
    const dir = mkdtempSync(path.join(os.tmpdir(), "cutline-mics-"));
    const cam = path.join(dir, "cam.mp4");
    const micA = path.join(dir, "mic-a.wav");
    const micB = path.join(dir, "mic-b.wav");
    const output = path.join(dir, "out.mp4");
    const makeCam = spawnSync(
      "ffmpeg",
      [
        "-y",
        "-f",
        "lavfi",
        "-i",
        "color=c=0xc2410c:s=1280x720:d=2",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=110:duration=2",
        "-shortest",
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        cam,
      ],
      { encoding: "utf8" },
    );
    assert.equal(makeCam.status, 0, makeCam.stderr);
    for (const [file, hz] of [
      [micA, "440"],
      [micB, "660"],
    ] as const) {
      const make = spawnSync(
        "ffmpeg",
        [
          "-y",
          "-f",
          "lavfi",
          "-i",
          `sine=frequency=${hz}:duration=2`,
          "-c:a",
          "pcm_s16le",
          file,
        ],
        { encoding: "utf8" },
      );
      assert.equal(make.status, 0, make.stderr);
    }
    const clips = [
      { startMs: 0, endMs: 800, camera: "A", role: "content" },
      { startMs: 800, endMs: 1600, camera: "A", role: "content" },
    ];
    const render = spawnSync("python3", [pythonWorkerPath()], {
      input: JSON.stringify({
        command: "render",
        sourcePath: cam,
        outputPath: output,
        sourceDurationMs: 2000,
        preset: "youtube-1080p",
        loudness: "youtube",
        micPaths: { A: micA, B: micB },
        clips,
      }),
      encoding: "utf8",
      timeout: 120_000,
      maxBuffer: 20 * 1024 * 1024,
    });
    assert.equal(render.status, 0, render.stderr);
    const rendered = JSON.parse(render.stdout) as { ok: boolean };
    assert.equal(rendered.ok, true);
    const handled = toRenderGraphClips(withHandles(clips, 2000), clips);
    const validate = spawnSync("python3", [pythonWorkerPath()], {
      input: JSON.stringify({
        command: "validate",
        filePath: output,
        expectedDurationMs: renderOutputDurationMs(handled),
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
