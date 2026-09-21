import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_WINDOW_MS,
  MIN_WINDOW_MS,
  PREFERRED_WINDOW_MS,
  WINDOW_CONTEXT_MS,
  mockConversationWindow,
  sliceConversationWindows,
  windowTranscriptSections,
} from "./windows";
import type { TranscriptCue } from "./types";

describe("sliceConversationWindows", () => {
  it("returns no windows for empty media", () => {
    assert.deepEqual(sliceConversationWindows({ durationMs: 0 }), []);
  });

  it("keeps a sub-30s clip as a single window with clamped context", () => {
    const windows = sliceConversationWindows({ durationMs: 24_000 });
    assert.equal(windows.length, 1);
    assert.equal(windows[0]?.id, "win_01");
    assert.equal(windows[0]?.targetStartMs, 0);
    assert.equal(windows[0]?.targetEndMs, 24_000);
    assert.equal(windows[0]?.contextStartMs, 0);
    assert.equal(windows[0]?.contextEndMs, 24_000);
  });

  it("covers 3 minutes with 30–90s targets and ±30s context", () => {
    const durationMs = 180_000;
    const windows = sliceConversationWindows({ durationMs });
    assert.ok(windows.length >= 2);
    assert.equal(windows[0]?.targetStartMs, 0);
    assert.equal(windows.at(-1)?.targetEndMs, durationMs);
    for (let index = 0; index < windows.length; index += 1) {
      const window = windows[index];
      const targetMs = window.targetEndMs - window.targetStartMs;
      assert.ok(targetMs >= MIN_WINDOW_MS);
      assert.ok(targetMs <= MAX_WINDOW_MS);
      assert.equal(
        window.contextStartMs,
        Math.max(0, window.targetStartMs - WINDOW_CONTEXT_MS),
      );
      assert.equal(
        window.contextEndMs,
        Math.min(durationMs, window.targetEndMs + WINDOW_CONTEXT_MS),
      );
      if (index > 0) {
        assert.equal(window.targetStartMs, windows[index - 1]?.targetEndMs);
      }
    }
    const middle = windows[1];
    assert.ok(middle);
    assert.equal(middle.contextStartMs, middle.targetStartMs - WINDOW_CONTEXT_MS);
    assert.equal(middle.contextEndMs, middle.targetEndMs + WINDOW_CONTEXT_MS);
  });

  it("avoids a short tail by splitting evenly under 2× max", () => {
    const windows = sliceConversationWindows({ durationMs: 100_000 });
    assert.equal(windows.length, 2);
    for (const window of windows) {
      const targetMs = window.targetEndMs - window.targetStartMs;
      assert.ok(targetMs >= MIN_WINDOW_MS);
      assert.ok(targetMs <= MAX_WINDOW_MS);
    }
    assert.equal(windows[0]?.targetStartMs, 0);
    assert.equal(windows.at(-1)?.targetEndMs, 100_000);
  });

  it("snaps splits to cue and speaker-change boundaries", () => {
    const cues: TranscriptCue[] = [
      { speaker: "A", text: "導入", startMs: 0, endMs: 58_000 },
      { speaker: "B", text: "質問です", startMs: 58_000, endMs: 62_000 },
      { speaker: "A", text: "答えます", startMs: 62_000, endMs: 180_000 },
    ];
    const windows = sliceConversationWindows({
      durationMs: 180_000,
      cues,
    });
    const edges = new Set(windows.flatMap((window) => [window.targetStartMs, window.targetEndMs]));
    assert.ok(edges.has(58_000) || edges.has(62_000));
    for (const window of windows) {
      const targetMs = window.targetEndMs - window.targetStartMs;
      assert.ok(targetMs >= MIN_WINDOW_MS);
      assert.ok(targetMs <= MAX_WINDOW_MS);
    }
  });

  it("splits a 120s topic and merges 20s topics", () => {
    const split = sliceConversationWindows({
      durationMs: 120_000,
      topics: [{ id: "topic_01", startMs: 0, endMs: 120_000 }],
    });
    assert.ok(split.length >= 2);
    assert.equal(split.every((window) => window.topicId === "topic_01"), true);
    for (const window of split) {
      const targetMs = window.targetEndMs - window.targetStartMs;
      assert.ok(targetMs >= MIN_WINDOW_MS);
      assert.ok(targetMs <= MAX_WINDOW_MS);
    }

    const merged = sliceConversationWindows({
      durationMs: 40_000,
      topics: [
        { id: "topic_01", startMs: 0, endMs: 20_000 },
        { id: "topic_02", startMs: 20_000, endMs: 40_000 },
      ],
    });
    assert.equal(merged.length, 1);
    assert.equal(merged[0]?.targetStartMs, 0);
    assert.equal(merged[0]?.targetEndMs, 40_000);
    assert.equal(merged[0]?.topicId, "topic_01");
  });

  it("prefers about 60s when there are no cues", () => {
    const windows = sliceConversationWindows({ durationMs: 240_000 });
    assert.equal(windows[0]?.targetEndMs, PREFERRED_WINDOW_MS);
    assert.equal(
      windows.at(-1)!.targetEndMs - windows.at(-1)!.targetStartMs,
      60_000,
    );
  });
});

describe("window transcript context", () => {
  it("labels before / target / after around ±30s", () => {
    const cues: TranscriptCue[] = [
      { speaker: "A", text: "前", startMs: 35_000, endMs: 42_000 },
      { speaker: "B", text: "本編", startMs: 70_000, endMs: 85_000 },
      { speaker: "A", text: "後", startMs: 130_000, endMs: 145_000 },
    ];
    const windows = sliceConversationWindows({
      durationMs: 180_000,
      cues,
    });
    const middle =
      windows.find(
        (window) =>
          window.targetStartMs <= 70_000 && window.targetEndMs >= 85_000,
      ) ?? windows[1];
    assert.ok(middle);
    const sections = windowTranscriptSections(cues, middle);
    assert.deepEqual(
      sections.target.map((cue) => cue.text),
      ["本編"],
    );
    assert.ok(sections.before.some((cue) => cue.text === "前"));
    assert.ok(sections.after.some((cue) => cue.text === "後"));
    assert.equal(
      middle.contextStartMs,
      Math.max(0, middle.targetStartMs - WINDOW_CONTEXT_MS),
    );
    assert.equal(
      middle.contextEndMs,
      Math.min(180_000, middle.targetEndMs + WINDOW_CONTEXT_MS),
    );
  });

  it("builds a mock Omni analysis from TARGET cues", () => {
    const window = sliceConversationWindows({ durationMs: 24_000 })[0];
    assert.ok(window);
    const analysis = mockConversationWindow({
      window,
      cues: [
        { speaker: "A", text: "えー", startMs: 0, endMs: 700 },
        { speaker: "A", text: "今年の2月から始めました", startMs: 3500, endMs: 6200 },
      ],
    });
    assert.equal(analysis.source, "mock");
    assert.deepEqual(analysis.speakers, ["A"]);
    assert.match(analysis.summary, /今年の2月から始めました/);
    assert.equal(analysis.turns.length, 2);
  });
});
