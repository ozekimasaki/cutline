import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { resetPersist } from "./persist";
import { micPathsFromSpeakers, renderJob, type RenderJobDeps } from "./render-job";
import { mockSignals } from "./sample";
import { createJob, getJob, registerMediaPath } from "./store";
import type {
  ExportValidation,
  Job,
  ScoredClip,
  SpeakerAssignment,
  WatchQa,
} from "./types";

function speaker(
  partial: Pick<SpeakerAssignment, "id"> & Partial<SpeakerAssignment>,
): SpeakerAssignment {
  return {
    source: partial.source ?? "mic",
    ...partial,
  };
}

describe("micPathsFromSpeakers", () => {
  it("builds A/B micPaths from Job speakers for §59 routing", () => {
    assert.deepEqual(
      micPathsFromSpeakers([
        speaker({ id: "A", filePath: "/tmp/MIC_A.wav", fileName: "MIC_A.wav", micIndex: 0 }),
        speaker({ id: "B", filePath: "/tmp/MIC_B.wav", fileName: "MIC_B.wav", micIndex: 1 }),
        speaker({ id: "C", filePath: "/tmp/MIC_C.wav", micIndex: 2 }),
      ]),
      { A: "/tmp/MIC_A.wav", B: "/tmp/MIC_B.wav" },
    );
  });

  it("keeps a single mic and skips mix speakers without a path", () => {
    assert.deepEqual(
      micPathsFromSpeakers([
        speaker({ id: "A", filePath: " /tmp/mic-a.wav ", source: "mic" }),
        speaker({ id: "B", source: "diarization" }),
      ]),
      { A: "/tmp/mic-a.wav" },
    );
  });

  it("returns an empty object when speakers are missing", () => {
    assert.deepEqual(micPathsFromSpeakers(undefined), {});
    assert.deepEqual(micPathsFromSpeakers([]), {});
    assert.deepEqual(
      micPathsFromSpeakers([speaker({ id: "A", filePath: "   " })]),
      {},
    );
  });
});

function clip(id: string, text: string, verdict: ScoredClip["verdict"]): ScoredClip {
  const unit = {
    id,
    speaker: "A",
    text,
    startMs: 0,
    endMs: 2000,
    role: "content" as const,
  };
  return {
    ...unit,
    signals: mockSignals(unit),
    keepScore: 0.8,
    autoMarker: false,
    verdict,
    verdictSource: "code",
    reason: "content",
  };
}

function validation(ok: boolean, notes: string[] = []): ExportValidation {
  return {
    durationMs: ok ? 2000 : 10,
    expectedDurationMs: 2000,
    hasAudio: ok,
    hasVideo: ok,
    blackFrames: !ok,
    frozenFrames: false,
    silenceAnomaly: false,
    avSyncOk: ok,
    ok,
    notes,
  };
}

function watchOk(): { watch: WatchQa; notes: string[] } {
  return {
    notes: [],
    watch: {
      source: "mock",
      iterations: 1,
      brokenConversations: false,
      abruptTopicChanges: false,
      obviousBadCuts: false,
      audioDiscontinuities: false,
      missingContext: false,
      awkwardCameraSwitching: false,
      issues: [],
      ok: true,
    },
  };
}

function readyJob(id: string): Job {
  return {
    id,
    createdAt: "2026-09-21T00:00:00.000Z",
    phase: "ready",
    brief: "",
    profile: "standard",
    targetDurationMs: 12_000,
    mediaId: `${id}-media`,
    fileName: "talk.mp4",
    sourceDurationMs: 24_000,
    cameras: [],
    transcript: [],
    clips: [clip("keep", "残す発言です。", "keep")],
    links: [],
    qwenMode: "mock",
    asrMode: "mock",
    jevProvider: "mock",
    notes: [],
    pass: 3,
    chapters: [],
    cacheHits: 0,
    renderPath: `/tmp/${id}-old-edited.mp4`,
    renderQa: validation(true),
  };
}

function renderDeps(partial: RenderJobDeps = {}): RenderJobDeps {
  return {
    detectVideoEncoder: async () => "libx264",
    renderKeptClips: async () => {},
    validateRender: async () => validation(true),
    watchEditedVideo: async () => watchOk(),
    lastWorkerBackendUsed: () => "ts",
    ...partial,
  };
}

describe("renderJob", { concurrency: false }, () => {
  before(() => {
    resetPersist();
    process.env.CUTLINE_DB_PATH = path.join(
      mkdtempSync(path.join(os.tmpdir(), "cutline-render-")),
      "cutline.db",
    );
  });

  it("leaves phase away from ready and drops renderPath while rendering", async () => {
    const id = "render-inflight";
    const job = readyJob(id);
    createJob(job);
    registerMediaPath(job.mediaId!, "/tmp/source.mp4");
    let seen = false;
    const result = await renderJob(
      { jobId: id },
      renderDeps({
        renderKeptClips: async () => {
          const mid = getJob(id);
          assert.notEqual(mid?.phase, "ready");
          assert.equal(mid?.renderPath, undefined);
          seen = true;
        },
      }),
    );
    assert.equal(seen, true);
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.validation?.ok, true);
      assert.ok(result.renderPath);
    }
    const saved = getJob(id);
    assert.equal(saved?.phase, "ready");
    assert.equal(saved?.renderQa?.ok, true);
    assert.ok(saved?.renderPath);
  });

  it("does not stay ready or keep a path when validation fails", async () => {
    const id = "render-invalid";
    const job = readyJob(id);
    createJob(job);
    registerMediaPath(job.mediaId!, "/tmp/source.mp4");
    let watched = false;
    const result = await renderJob(
      { jobId: id },
      renderDeps({
        validateRender: async () => validation(false, ["映像ストリームがありません"]),
        watchEditedVideo: async () => {
          watched = true;
          return watchOk();
        },
      }),
    );
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.status, 500);
      assert.match(result.error, /検証に失敗/);
    }
    assert.equal(watched, false);
    const saved = getJob(id);
    assert.equal(saved?.phase, "error");
    assert.equal(saved?.renderPath, undefined);
    assert.equal(saved?.renderQa?.ok, false);
    assert.equal(Boolean(saved?.renderPath), false);
  });

  it("does not stay ready or keep a path when rendering throws", async () => {
    const id = "render-throw";
    const job = readyJob(id);
    createJob(job);
    registerMediaPath(job.mediaId!, "/tmp/source.mp4");
    const result = await renderJob(
      { jobId: id },
      renderDeps({
        renderKeptClips: async () => {
          throw new Error("ffmpeg failed");
        },
      }),
    );
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error, "ffmpeg failed");
      assert.equal(result.status, 500);
    }
    const saved = getJob(id);
    assert.equal(saved?.phase, "error");
    assert.equal(saved?.error, "ffmpeg failed");
    assert.equal(saved?.renderPath, undefined);
    assert.equal(saved?.renderQa, undefined);
    assert.equal(Boolean(saved?.renderPath), false);
  });
});
