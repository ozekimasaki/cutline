import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { resetPersist } from "./persist";
import {
  applyManualVerdict,
  patchContinuity,
  publicSpeakers,
  reviewBlockMessage,
} from "./pipeline";
import { mockSignals } from "./sample";
import { createJob } from "./store";
import type { ContinuityQa, ExportValidation, Job, ScoredClip } from "./types";

describe("publicSpeakers", () => {
  it("keeps SpeakerAssignment.filePath on the Job", () => {
    const speakers = publicSpeakers([
      {
        id: "A",
        source: "mic",
        fileName: "MIC_A.wav",
        filePath: "/tmp/MIC_A.wav",
        micIndex: 0,
      },
      {
        id: "B",
        source: "mic",
        fileName: "MIC_B.wav",
        filePath: "/tmp/MIC_B.wav",
        micIndex: 1,
      },
    ]);
    assert.equal(speakers[0]?.filePath, "/tmp/MIC_A.wav");
    assert.equal(speakers[1]?.filePath, "/tmp/MIC_B.wav");
    assert.deepEqual(
      speakers.map((speaker) => speaker.id),
      ["A", "B"],
    );
  });

  it("still publishes mix speakers without a filePath", () => {
    const speakers = publicSpeakers([
      { id: "A", source: "mix" },
      { id: "B", source: "diarization" },
    ]);
    assert.equal(speakers[0]?.filePath, undefined);
    assert.equal(speakers[1]?.source, "diarization");
  });
});

function clip(
  id: string,
  text: string,
  verdict: ScoredClip["verdict"],
  extra: Partial<ScoredClip> = {},
): ScoredClip {
  const unit = {
    id,
    speaker: extra.speaker ?? "A",
    text,
    startMs: extra.startMs ?? 0,
    endMs: extra.endMs ?? 2000,
    role: extra.role ?? "content",
  };
  return {
    ...unit,
    signals: mockSignals(unit),
    keepScore: 0.8,
    autoMarker: false,
    verdict,
    verdictSource: "code",
    reason: "content",
    ...extra,
  };
}

function continuity(partial: Partial<ContinuityQa> = {}): ContinuityQa {
  return {
    conversationMakesSense: partial.issues ? partial.issues.length === 0 : true,
    missingReferences: false,
    pronounLostAntecedent: false,
    questionLostAnswer: false,
    unnecessaryRepetition: false,
    issues: [],
    ...partial,
  };
}

function passedQa(): ExportValidation {
  return {
    durationMs: 2000,
    expectedDurationMs: 2000,
    hasAudio: true,
    hasVideo: true,
    blackFrames: false,
    frozenFrames: false,
    silenceAnomaly: false,
    avSyncOk: true,
    ok: true,
    notes: [],
  };
}

function readyJob(id: string, clips: ScoredClip[], partial: Partial<Job> = {}): Job {
  return {
    id,
    createdAt: "2026-09-21T00:00:00.000Z",
    phase: "ready",
    brief: "",
    profile: "standard",
    targetDurationMs: 12_000,
    fileName: "talk.mp4",
    sourceDurationMs: 60_000,
    cameras: [],
    transcript: [],
    clips,
    links: [{ type: "contrast", fromId: "none", toId: "none" }],
    qwenMode: "mock",
    asrMode: "mock",
    jevProvider: "mock",
    notes: [],
    pass: 3,
    chapters: [],
    cacheHits: 0,
    renderPath: `/tmp/${id}-edited.mp4`,
    renderQa: passedQa(),
    continuity: continuity({ questionLostAnswer: false }),
    ...partial,
  };
}

describe("patchContinuity", () => {
  it("restores only the next content cut after each flagged question", () => {
    const clips = [
      clip("q", "会社辞めようと思ったことあります？", "keep", {
        startMs: 0,
        endMs: 1000,
      }),
      clip("filler", "えー", "cut", {
        role: "filler",
        startMs: 1000,
        endMs: 1400,
      }),
      clip("a", "あります。", "cut", { startMs: 2000, endMs: 3000 }),
      clip("b", "そのあとも話しました。", "cut", { startMs: 4000, endMs: 5500 }),
      clip("q2", "本当ですか？", "keep", { startMs: 6000, endMs: 7000 }),
      clip("c", "本当です。", "cut", { startMs: 8000, endMs: 9000 }),
      clip("d", "別の話です。", "cut", { startMs: 10_000, endMs: 11_000 }),
    ];
    const next = patchContinuity(
      clips,
      continuity({
        questionLostAnswer: true,
        conversationMakesSense: false,
        issues: [
          { clipId: "q", issue: "質問のあとに答えが残っていない" },
          { clipId: "q2", issue: "質問のあとに答えが残っていない" },
        ],
      }),
    );
    assert.equal(next.find((item) => item.id === "a")?.verdict, "keep");
    assert.equal(next.find((item) => item.id === "b")?.verdict, "cut");
    assert.equal(next.find((item) => item.id === "filler")?.verdict, "cut");
    assert.equal(next.find((item) => item.id === "c")?.verdict, "keep");
    assert.equal(next.find((item) => item.id === "d")?.verdict, "cut");
    assert.equal(next.find((item) => item.id === "q")?.verdict, "keep");
  });
});

describe("reviewBlockMessage", () => {
  it("blocks review during render with a message the editor can show", () => {
    assert.equal(reviewBlockMessage("ready"), undefined);
    for (const phase of ["rendering_proxy", "watching", "final_render"] as const) {
      const message = reviewBlockMessage(phase);
      assert.equal(message, "書き出し中は判定を変えられません。");
    }
    assert.equal(
      reviewBlockMessage("queued"),
      "判定が終わるまで確認できません。",
    );
    assert.equal(
      reviewBlockMessage("error"),
      "判定が終わるまで確認できません。",
    );
  });
});

describe("applyManualVerdict", { concurrency: false }, () => {
  before(() => {
    resetPersist();
    process.env.CUTLINE_DB_PATH = path.join(
      mkdtempSync(path.join(os.tmpdir(), "cutline-pipeline-")),
      "cutline.db",
    );
  });

  it("recomputes continuity and drops the previous mp4 after KEEP", () => {
    const id = "manual-keep";
    createJob(
      readyJob(
        id,
        [
          clip("q", "会社辞めようと思ったことあります？", "keep", {
            startMs: 0,
            endMs: 2000,
          }),
          clip("a", "あります。", "cut", { startMs: 4000, endMs: 5200 }),
          clip("b", "別の話です。", "cut", { startMs: 8000, endMs: 9000 }),
        ],
        {
          continuity: continuity({
            questionLostAnswer: true,
            conversationMakesSense: false,
            issues: [{ clipId: "q", issue: "質問のあとに答えが残っていない" }],
          }),
        },
      ),
    );
    const next = applyManualVerdict(id, "a", "keep");
    assert.ok(next);
    assert.equal(next.clips.find((item) => item.id === "a")?.verdict, "keep");
    assert.equal(next.clips.find((item) => item.id === "a")?.verdictSource, "user");
    assert.equal(next.clips.find((item) => item.id === "b")?.verdict, "cut");
    assert.equal(next.continuity?.questionLostAnswer, false);
    assert.equal(next.renderPath, undefined);
    assert.equal(next.renderQa, undefined);
  });

  it("recomputes continuity and drops the previous mp4 after CUT", () => {
    const id = "manual-cut";
    createJob(
      readyJob(
        id,
        [
          clip("q", "会社辞めようと思ったことあります？", "keep", {
            startMs: 0,
            endMs: 2000,
          }),
          clip("a", "あります。", "cut", { startMs: 4000, endMs: 5200 }),
          clip("note", "メモです。", "keep", { startMs: 6000, endMs: 7000 }),
        ],
        {
          continuity: continuity({ questionLostAnswer: false, issues: [] }),
        },
      ),
    );
    const next = applyManualVerdict(id, "note", "cut");
    assert.ok(next);
    assert.equal(next.clips.find((item) => item.id === "note")?.verdict, "cut");
    assert.equal(next.clips.find((item) => item.id === "note")?.verdictSource, "user");
    assert.equal(next.clips.find((item) => item.id === "a")?.verdict, "cut");
    assert.equal(next.continuity?.questionLostAnswer, true);
    assert.equal(next.renderPath, undefined);
    assert.equal(next.renderQa, undefined);
  });
});
