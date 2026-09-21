import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  cacheGet,
  cacheSet,
  promptVersion,
  resetPersist,
  saveJobRow,
  loadJobRow,
} from "./persist";
import { analyzeTopics } from "./topics";
import { runContinuityCheck } from "./continuity";
import { burnInFilter, escapeDrawtext, shouldBurnIn } from "./caption";
import { mockSignals } from "./sample";
import type { Job, ScoredClip } from "./types";

describe("analyzeTopics", () => {
  it("builds PASS 1 chapters with viewer value", () => {
    const topics = analyzeTopics({
      titles: ["開始時期", "役割分担", "転職"],
      durationMs: 24_000,
      cues: [
        { speaker: "A", text: "今年の2月から", startMs: 0, endMs: 6000 },
        { speaker: "A", text: "判断は Jev", startMs: 9000, endMs: 13000 },
        { speaker: "B", text: "会社辞めようと思ったことあります？", startMs: 18000, endMs: 19800 },
      ],
    });
    assert.equal(topics.length, 3);
    assert.equal(topics[0]?.id, "topic_01");
    assert.equal(topics[1]?.importance, "high");
    assert.ok((topics[1]?.viewerValue ?? 0) > 0.5);
  });
});

describe("runContinuityCheck", () => {
  it("flags a question without an answer", () => {
    const qa = runContinuityCheck([
      {
        id: "q",
        speaker: "B",
        text: "会社辞めようと思ったことあります？",
        startMs: 0,
        endMs: 2000,
        role: "content",
        signals: mockSignals({
          id: "q",
          speaker: "B",
          text: "会社辞めようと思ったことあります？",
          startMs: 0,
          endMs: 2000,
          role: "content",
        }),
        keepScore: 0.8,
        autoMarker: false,
        verdict: "keep",
        verdictSource: "code",
        reason: "content",
      },
    ]);
    assert.equal(qa.questionLostAnswer, true);
    assert.equal(qa.conversationMakesSense, false);
  });
});

describe("caption burn-in", () => {
  it("burns in high-importance keep text", () => {
    const clip: ScoredClip = {
      id: "c",
      speaker: "A",
      text: "今年の2月から始めました",
      startMs: 0,
      endMs: 2000,
      role: "content",
      signals: mockSignals({
        id: "c",
        speaker: "A",
        text: "今年の2月から始めました",
        startMs: 0,
        endMs: 2000,
        role: "content",
      }),
      keepScore: 0.8,
      autoMarker: false,
      verdict: "keep",
      verdictSource: "code",
      reason: "content",
      captionImportance: 0.82,
    };
    assert.equal(shouldBurnIn(clip), true);
    assert.match(escapeDrawtext("A:B"), /A\\:B/);
    const filter = burnInFilter("/tmp/cutline/caption-0.txt");
    assert.match(filter, /drawtext=/);
    assert.match(filter, /textfile=/);
    assert.match(filter, /expansion=none/);
    assert.doesNotMatch(filter, /text='/);
  });
});

describe("sqlite cache", () => {
  it("stores AI results by mediaHash and time range", () => {
    resetPersist();
    process.env.CUTLINE_DB_PATH = path.join(
      mkdtempSync(path.join(os.tmpdir(), "cutline-cache-")),
      "cutline.db",
    );
    const lookup = {
      mediaHash: "abc",
      timeRange: "0-1000",
      modelVersion: "jev:mock",
      promptVersion: promptVersion(),
      kind: "jev:eu_1",
    };
    cacheSet(lookup, { importance: 0.8 });
    assert.deepEqual(cacheGet(lookup), { importance: 0.8 });
    const job = {
      id: "job-1",
      createdAt: new Date().toISOString(),
      phase: "ready",
      brief: "",
      profile: "standard",
      targetDurationMs: 12_000,
      fileName: "a.mp4",
      sourceDurationMs: 24_000,
      cameras: [],
      transcript: [],
      clips: [],
      links: [],
      qwenMode: "mock",
      asrMode: "mock",
      jevProvider: "mock",
      notes: [],
      pass: 3,
      chapters: [],
      cacheHits: 1,
    } as Job;
    saveJobRow(job);
    assert.equal(loadJobRow("job-1")?.cacheHits, 1);
    resetPersist();
  });
});
