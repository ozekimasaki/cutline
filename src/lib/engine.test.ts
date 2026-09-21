import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { assignCameras as assignCamerasTs } from "./camera";
import {
  computeKeepScore,
  decideVerdict,
} from "./decide";
import {
  assignCameras,
  decideUnits,
  lastDecideBackendUsed,
  loudnessSettings,
  pythonRenderPayload,
  pythonWorkerAvailable,
  pythonWorkerPath,
  rustEngineAvailable,
} from "./engine";
import {
  loudnormFilter,
  parseExportPreset,
  presetSize,
  targetLufs,
} from "./ffmpeg";
import type { JevSignals, OmniUnitState, OmniVisualState, ScoredClip } from "./types";

function signals(partial: Partial<JevSignals> = {}): JevSignals {
  return {
    importance: 0.5,
    novelty: 0.4,
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
    ...partial,
  };
}

function clip(
  id: string,
  speaker: string,
  startMs: number,
  endMs: number,
  extra: Partial<ScoredClip> = {},
): ScoredClip {
  return {
    id,
    speaker,
    text: extra.text ?? id,
    startMs,
    endMs,
    role: extra.role ?? "content",
    signals: extra.signals ?? signals(),
    keepScore: extra.keepScore ?? 0.8,
    autoMarker: false,
    verdict: extra.verdict ?? "keep",
    verdictSource: extra.verdictSource ?? "code",
    reason: extra.reason ?? "content",
    omni: extra.omni,
  };
}

function omniVisual(partial: Partial<OmniVisualState> = {}): OmniUnitState {
  return {
    edit: {
      target: { id: "x", speaker: "A", text: "", start: 0, end: 1 },
      semantic: { role: "content", contains_new_information: true },
      conversation: { previous: "", next: "" },
      visual: { speaker_camera: "cam_a", listener_reaction: "none" },
    },
    visual: {
      speaker: "A",
      camera_a: { subject: "A", usable: true, expression: "neutral" },
      camera_b: { subject: "B", usable: true, expression: "neutral" },
      wide: { usable: true },
      listener_reaction: { strength: 0.12 },
      ...partial,
    },
  };
}

const fixtures: { id: string; profile: "natural" | "standard" | "tight" | "short"; signals: JevSignals }[] =
  [
    {
      id: "keep-high",
      profile: "standard",
      signals: signals({ confidence: 0.97, importance: 0.9, filler: 0.02 }),
    },
    {
      id: "cut-tight",
      profile: "tight",
      signals: signals({
        confidence: 0.97,
        importance: 0.04,
        filler: 0.96,
        falseStart: 0.02,
        tangent: 0.02,
      }),
    },
    {
      id: "keep-low-conf",
      profile: "standard",
      signals: signals({ confidence: 0.4, filler: 0.99 }),
    },
    {
      id: "review-mid",
      profile: "standard",
      signals: signals({ confidence: 0.7, importance: 0.9 }),
    },
    {
      id: "review-flag",
      profile: "natural",
      signals: signals({ reviewRequired: 0.8, confidence: 0.99, importance: 0.9 }),
    },
    {
      id: "short-fill",
      profile: "short",
      signals: signals({ importance: 0.2, filler: 0.8, humanTexture: 0.4 }),
    },
  ];

describe("engine decide vs TypeScript", () => {
  it("matches keepScore and verdict for all profiles", (t) => {
    if (!rustEngineAvailable()) {
      t.skip("cutline-engine がありません。npm run engine:build");
      return;
    }
    for (const profile of ["natural", "standard", "tight", "short"] as const) {
      const units = fixtures.map((item) => ({
        id: `${item.id}-${profile}`,
        signals: item.signals,
      }));
      const rust = decideUnits(units, profile);
      assert.equal(lastDecideBackendUsed(), "rust");
      rust.forEach((row, index) => {
        const unit = units[index];
        assert.ok(unit);
        const keepScore = computeKeepScore(unit.signals, profile);
        const decided = decideVerdict(unit.signals, keepScore);
        assert.equal(row.keepScore, keepScore);
        assert.equal(row.verdict, decided.verdict);
        assert.equal(row.autoMarker, decided.autoMarker);
      });
    }
  });
});

describe("engine cameras vs TypeScript", () => {
  it("matches speaker / reaction / fatigue / jump-cut assignment", (t) => {
    if (!rustEngineAvailable()) {
      t.skip("cutline-engine がありません。npm run engine:build");
      return;
    }
    const cases: ScoredClip[][] = [
      [clip("a", "A", 0, 2000)],
      [
        clip("a", "A", 0, 2000),
        clip("b", "B", 2000, 3200, {
          role: "backchannel",
          text: "へえ",
          signals: signals({ reactionValue: 0.87 }),
        }),
      ],
      [
        clip("a1", "A", 0, 4500),
        clip("a2", "A", 4500, 7000),
      ],
      [
        clip("keep1", "A", 0, 2000),
        clip("cut", "A", 2000, 5000, { verdict: "cut" }),
        clip("keep2", "A", 5000, 7500),
      ],
      [
        clip("keep1", "A", 0, 2000),
        clip("cut", "A", 2000, 5000, { verdict: "cut" }),
        clip("keep2", "A", 5000, 5600),
      ],
    ];
    for (const input of cases) {
      const rust = assignCameras(input);
      const ts = assignCamerasTs(input);
      assert.equal(lastDecideBackendUsed(), "rust");
      rust.forEach((row, index) => {
        assert.equal(row.camera, ts[index]?.camera);
        assert.equal(row.punchIn, ts[index]?.punchIn);
        assert.equal(row.morph, ts[index]?.morph);
        assert.equal(row.cameraReason, ts[index]?.cameraReason);
      });
    }
  });

  it("uses Omni usable / expression / listener_reaction, not a Jev camera pick", (t) => {
    if (!rustEngineAvailable()) {
      t.skip("cutline-engine がありません。npm run engine:build");
      return;
    }
    const cases: ScoredClip[][] = [
      [
        clip("talk", "A", 0, 2500, {
          signals: signals({ reactionValue: 0.1 }),
          omni: omniVisual({
            camera_b: { subject: "B", usable: true, expression: "surprised" },
            listener_reaction: { strength: 0.87 },
          }),
        }),
      ],
      [
        clip("talk", "A", 0, 2500, {
          omni: omniVisual({
            camera_a: { subject: "A", usable: false, expression: "neutral" },
            wide: { usable: true },
          }),
        }),
      ],
      [
        clip("keep1", "A", 0, 2000, {
          omni: omniVisual({
            camera_a: { subject: "A", usable: false, expression: "neutral" },
            wide: { usable: true },
          }),
        }),
        clip("keep2", "A", 2000, 2800, {
          omni: omniVisual({
            camera_a: { subject: "A", usable: false, expression: "neutral" },
            wide: { usable: true },
          }),
        }),
      ],
    ];
    for (const input of cases) {
      const rust = assignCameras(input);
      const ts = assignCamerasTs(input);
      assert.equal(lastDecideBackendUsed(), "rust");
      rust.forEach((row, index) => {
        assert.equal(row.camera, ts[index]?.camera);
        assert.equal(row.punchIn, ts[index]?.punchIn);
        assert.equal(row.morph, ts[index]?.morph);
        assert.equal(row.cameraReason, ts[index]?.cameraReason);
      });
    }
    assert.equal(assignCameras(cases[0] ?? [])[0]?.camera, "B");
    assert.equal(assignCameras(cases[0] ?? [])[0]?.cameraReason, "listener reaction");
    assert.notEqual(assignCameras(cases[1] ?? [])[0]?.camera, "A");
  });
});

describe("export presets and loudness", () => {
  it("maps spec §64 sizes and LUFS", () => {
    assert.deepEqual(presetSize(parseExportPreset("youtube-1080p")), {
      width: 1920,
      height: 1080,
    });
    assert.deepEqual(presetSize(parseExportPreset("youtube-4k")), {
      width: 3840,
      height: 2160,
    });
    assert.deepEqual(presetSize(parseExportPreset("shorts")), {
      width: 1080,
      height: 1920,
    });
    assert.deepEqual(presetSize(parseExportPreset("archive-prores")), {
      width: 1920,
      height: 1080,
    });
    assert.equal(targetLufs("youtube"), -14);
    assert.equal(targetLufs("podcast"), -16);
    assert.equal(loudnormFilter("youtube"), "loudnorm=I=-14:TP=-1.5:LRA=11");
    assert.equal(loudnormFilter("podcast"), "loudnorm=I=-16:TP=-1.5:LRA=11");
  });
});

describe("python render payload", () => {
  it("forwards micPaths for §59 channel routing", () => {
    const payload = pythonRenderPayload({
      sourcePath: "/tmp/in.mp4",
      outputPath: "/tmp/out.mp4",
      clips: [{ startMs: 0, endMs: 400, camera: "A" }],
      sourceDurationMs: 1000,
      cameraPaths: { B: "/tmp/cam-b.mp4" },
      micPaths: { A: "/tmp/mic-a.wav", B: "/tmp/mic-b.wav" },
      preset: "youtube-1080p",
      loudness: "youtube",
    });
    assert.equal(payload.command, "render");
    assert.deepEqual(payload.micPaths, {
      A: "/tmp/mic-a.wav",
      B: "/tmp/mic-b.wav",
    });
    assert.deepEqual(payload.cameraPaths, { B: "/tmp/cam-b.mp4" });
    assert.match(JSON.stringify(payload), /"micPaths"/);
  });

  it("sends an empty micPaths object when omitted", () => {
    const payload = pythonRenderPayload({
      sourcePath: "/tmp/in.mp4",
      outputPath: "/tmp/out.mp4",
      clips: [{ startMs: 0, endMs: 400 }],
    });
    assert.deepEqual(payload.micPaths, {});
  });
});

describe("python worker", () => {
  it("returns YouTube −14 and Podcast −16", async () => {
    assert.equal(pythonWorkerAvailable(), true);
    const youtube = await loudnessSettings("youtube");
    const podcast = await loudnessSettings("podcast");
    assert.equal(youtube.backend, "python");
    assert.equal(youtube.targetLufs, -14);
    assert.equal(podcast.targetLufs, -16);
    assert.match(podcast.filter, /I=-16/);
  });

  it("smokes render/validate when ffmpeg is present", (t) => {
    const ffmpeg = spawnSync("ffmpeg", ["-version"], { encoding: "utf8" });
    if (ffmpeg.status !== 0) {
      t.skip("ffmpeg がありません");
      return;
    }
    const dir = mkdtempSync(path.join(os.tmpdir(), "cutline-worker-"));
    const source = path.join(dir, "in.mp4");
    const output = path.join(dir, "out.mp4");
    const make = spawnSync(
      "ffmpeg",
      [
        "-y",
        "-f",
        "lavfi",
        "-i",
        "color=c=0xc2410c:s=1280x720:d=1",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=220:duration=1",
        "-shortest",
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        source,
      ],
      { encoding: "utf8" },
    );
    assert.equal(make.status, 0, make.stderr);
    const payload = {
      command: "render",
      sourcePath: source,
      outputPath: output,
      clips: [{ startMs: 0, endMs: 400, camera: "A" }],
      sourceDurationMs: 1000,
      preset: "youtube-1080p",
      loudness: "youtube",
    };
    const render = spawnSync("python3", [pythonWorkerPath()], {
      input: JSON.stringify(payload),
      encoding: "utf8",
      timeout: 120_000,
      maxBuffer: 20 * 1024 * 1024,
    });
    assert.equal(render.status, 0, render.stderr);
    const rendered = JSON.parse(render.stdout) as { ok: boolean; preset: string };
    assert.equal(rendered.ok, true);
    assert.equal(rendered.preset, "youtube-1080p");
    const validate = spawnSync("python3", [pythonWorkerPath()], {
      input: JSON.stringify({
        command: "validate",
        filePath: output,
        expectedDurationMs: 560,
      }),
      encoding: "utf8",
      timeout: 60_000,
    });
    assert.equal(validate.status, 0, validate.stderr);
    const checked = JSON.parse(validate.stdout) as { hasAudio: boolean; hasVideo: boolean };
    assert.equal(checked.hasAudio, true);
    assert.equal(checked.hasVideo, true);
  });
});
