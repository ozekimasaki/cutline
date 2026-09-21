import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { applyWatchFixes, mockWatchQa } from "./watch";
import { mockSignals } from "./sample";
import type { ScoredClip } from "./types";

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

describe("watch QA", () => {
  it("restores a cut answer after a kept question", () => {
    const clips = [
      clip("q", "会社辞めようと思ったことあります？", "keep", {
        startMs: 0,
        endMs: 2000,
      }),
      clip("a", "……あります。", "cut", { startMs: 5000, endMs: 6200 }),
    ];
    const watch = mockWatchQa({
      clips,
      continuity: {
        conversationMakesSense: false,
        missingReferences: false,
        pronounLostAntecedent: false,
        questionLostAnswer: true,
        unnecessaryRepetition: false,
        issues: [{ clipId: "q", issue: "質問のあとに答えが残っていない" }],
      },
    });
    assert.equal(watch.brokenConversations, true);
    assert.equal(watch.ok, false);
    const next = applyWatchFixes(clips, watch);
    assert.equal(next.find((item) => item.id === "a")?.verdict, "keep");
  });

  it("leaves a user cut answer cut", () => {
    const clips = [
      clip("q", "会社辞めようと思ったことあります？", "keep", {
        startMs: 0,
        endMs: 2000,
      }),
      clip("a", "……あります。", "cut", {
        startMs: 5000,
        endMs: 6200,
        verdictSource: "user",
      }),
    ];
    const watch = mockWatchQa({
      clips,
      continuity: {
        conversationMakesSense: false,
        missingReferences: false,
        pronounLostAntecedent: false,
        questionLostAnswer: true,
        unnecessaryRepetition: false,
        issues: [{ clipId: "q", issue: "質問のあとに答えが残っていない" }],
      },
    });
    assert.equal(
      watch.issues.some((item) => item.restoreClipId === "a"),
      true,
    );
    const next = applyWatchFixes(clips, watch);
    assert.equal(next.find((item) => item.id === "a")?.verdict, "cut");
    assert.equal(next.find((item) => item.id === "a")?.verdictSource, "user");
  });

  it("restores an obvious bad cut only when the next keep is the same speaker", () => {
    const clips = [
      clip("other", "別の話", "cut", { speaker: "B", startMs: 0, endMs: 1000 }),
      clip("kept-a", "残す", "keep", { speaker: "A", startMs: 1000, endMs: 2000 }),
      clip("same", "同じ話者", "cut", { speaker: "A", startMs: 3000, endMs: 4000 }),
      clip("kept-a2", "続き", "keep", { speaker: "A", startMs: 4000, endMs: 5000 }),
    ];
    const watch = mockWatchQa({ clips });
    assert.equal(watch.obviousBadCuts, true);
    assert.equal(
      watch.issues.find((item) => item.issue === "obvious bad cuts")?.restoreClipId,
      "same",
    );
    const next = applyWatchFixes(clips, watch);
    assert.equal(next.find((item) => item.id === "same")?.verdict, "keep");
    assert.equal(next.find((item) => item.id === "other")?.verdict, "cut");
  });

  it("does not restore a user cut that matches the speaker rule", () => {
    const clips = [
      clip("user", "人が切った", "cut", {
        speaker: "A",
        verdictSource: "user",
        startMs: 0,
        endMs: 1000,
      }),
      clip("kept", "残す", "keep", { speaker: "A", startMs: 1000, endMs: 2000 }),
    ];
    const watch = mockWatchQa({ clips });
    assert.equal(watch.obviousBadCuts, true);
    assert.equal(
      watch.issues.find((item) => item.issue === "obvious bad cuts")?.restoreClipId,
      "user",
    );
    const next = applyWatchFixes(clips, watch);
    assert.equal(next.find((item) => item.id === "user")?.verdict, "cut");
    assert.equal(next.find((item) => item.id === "user")?.verdictSource, "user");
  });
});
