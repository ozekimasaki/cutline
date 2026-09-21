import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  clipDurationMs,
  editorialValue,
  optimizeDuration,
  rankDeletionCandidates,
} from "./duration";
import { packToTargetDuration } from "./decide";
import type { JevSignals, ScoredClip } from "./types";

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
    pauseClass: extra.pauseClass,
    previous: extra.previous,
    next: extra.next,
    signals: extra.signals ?? signals(),
    keepScore: extra.keepScore ?? 0.8,
    autoMarker: extra.autoMarker ?? false,
    verdict: extra.verdict ?? "keep",
    verdictSource: extra.verdictSource ?? "code",
    reason: extra.reason ?? id,
  };
}

function keepIds(clips: ScoredClip[]): string[] {
  return clips.filter((item) => item.verdict === "keep").map((item) => item.id);
}

function autoKeepDuration(clips: ScoredClip[]): number {
  return clips
    .filter((item) => item.verdict === "keep" && item.verdictSource === "code")
    .reduce((sum, item) => sum + clipDurationMs(item), 0);
}

describe("editorialValue", () => {
  it("ranks important content above filler", () => {
    const content = clip("content", 0, 2000, {
      keepScore: 0.9,
      signals: signals({ importance: 0.92, filler: 0.02, novelty: 0.7 }),
    });
    const filler = clip("filler", 0, 2000, {
      role: "filler",
      keepScore: 0.35,
      signals: signals({ importance: 0.08, filler: 0.94, novelty: 0.05 }),
    });
    assert.ok(editorialValue(content) > editorialValue(filler));
  });
});

describe("optimizeDuration", () => {
  it("maximizes editorialValue under the duration cap instead of greedy keepScore", () => {
    const clips = [
      clip("long", 0, 9000, {
        keepScore: 0.9,
        signals: signals({ importance: 0.9, novelty: 0.4 }),
      }),
      clip("a", 9000, 13_000, {
        keepScore: 0.8,
        signals: signals({ importance: 0.82, novelty: 0.7 }),
      }),
      clip("b", 13_000, 17_000, {
        keepScore: 0.8,
        signals: signals({ importance: 0.82, novelty: 0.7 }),
      }),
    ];
    const packed = optimizeDuration(clips, 8000);
    assert.deepEqual(keepIds(packed).sort(), ["a", "b"]);
    assert.ok(autoKeepDuration(packed) <= 8000);
    assert.equal(packed.find((item) => item.id === "long")?.verdict, "review");
  });

  it("does not split a question and its answer", () => {
    const clips = [
      clip("q", 0, 2000, {
        text: "会社辞めようと思ったことあります？",
        keepScore: 0.3,
        signals: signals({ importance: 0.25, contextRequired: 0.8 }),
      }),
      clip("a", 2000, 4000, {
        text: "あります。",
        keepScore: 0.9,
        signals: signals({ importance: 0.92 }),
      }),
      clip("other", 4000, 7000, {
        text: "今日の天気の話",
        keepScore: 0.85,
        signals: signals({ importance: 0.86, novelty: 0.6 }),
      }),
    ];
    const packed = optimizeDuration(clips, 3000);
    const kept = keepIds(packed);
    assert.equal(kept.includes("q"), kept.includes("a"));
    assert.deepEqual(kept, ["other"]);
  });

  it("does not split a correction pair", () => {
    const clips = [
      clip("other", 0, 2500, {
        text: "別の話題です",
        keepScore: 0.7,
      }),
      clip("false", 2500, 4000, {
        role: "false_start",
        text: "去年",
        keepScore: 0.2,
      }),
      clip("fix", 4000, 6500, {
        role: "self_correction",
        text: "いや、おととしです",
        keepScore: 0.88,
        signals: signals({ importance: 0.8, selfCorrection: 0.9 }),
      }),
    ];
    const packed = optimizeDuration(clips, 2500);
    const kept = keepIds(packed);
    assert.equal(kept.includes("false"), kept.includes("fix"));
    assert.deepEqual(kept, ["other"]);
  });

  it("does not keep only one half of a contrast", () => {
    const clips = [
      clip("setup", 0, 5000, {
        text: "これはダメだと思ったんですけど",
        keepScore: 0.35,
        signals: signals({ importance: 0.3, contextRequired: 0.85 }),
      }),
      clip("end", 5000, 7000, {
        text: "実際使ったらすごく良かった",
        keepScore: 0.95,
        signals: signals({ importance: 0.95 }),
      }),
      clip("other", 7000, 9500, {
        text: "別件の話",
        keepScore: 0.7,
      }),
    ];
    const packed = optimizeDuration(clips, 3000);
    const kept = keepIds(packed);
    assert.equal(kept.includes("setup"), kept.includes("end"));
    assert.deepEqual(kept, ["other"]);
  });

  it("keeps a thinking pause that semantic safety already protects", () => {
    const clips = [
      clip("q", 0, 1000, {
        text: "会社辞めようと思ったことあります？",
        keepScore: 0.5,
      }),
      clip("pause", 1000, 2200, {
        role: "pause",
        pauseClass: "thinking",
        text: "",
        keepScore: 0.05,
        signals: signals({ importance: 0.02, humanTexture: 0.8, filler: 0.01 }),
      }),
      clip("a", 2200, 3200, {
        text: "あります。",
        keepScore: 0.5,
      }),
      clip("filler", 3200, 5200, {
        role: "filler",
        text: "えー",
        keepScore: 0.4,
        signals: signals({ importance: 0.05, filler: 0.9 }),
      }),
    ];
    const packed = optimizeDuration(clips, 2000);
    assert.equal(packed.find((item) => item.id === "pause")?.verdict, "keep");
    assert.ok(autoKeepDuration(packed) <= 2000);
  });

  it("leaves clips unchanged when already under the target", () => {
    const clips = [
      clip("a", 0, 2000, { keepScore: 0.9 }),
      clip("b", 2000, 3500, { keepScore: 0.4 }),
    ];
    const packed = optimizeDuration(clips, 10_000);
    assert.equal(packed.find((item) => item.id === "b")?.verdict, "keep");
    assert.deepEqual(keepIds(packed), ["a", "b"]);
  });

  it("does not demote a user keep", () => {
    const clips = [
      clip("user", 0, 4000, { keepScore: 0.2, verdictSource: "user" }),
      clip("auto", 4000, 9000, { keepScore: 0.95 }),
    ];
    const packed = optimizeDuration(clips, 3000);
    assert.equal(packed.find((item) => item.id === "user")?.verdict, "keep");
    assert.equal(packed.find((item) => item.id === "auto")?.verdict, "review");
  });
});

describe("rankDeletionCandidates", () => {
  it("ranks long low-value clips ahead of short high-value clips", () => {
    const clips = [
      clip("precious", 0, 1000, {
        keepScore: 0.95,
        signals: signals({ importance: 0.95, novelty: 0.8, removalNatural: 0.2 }),
      }),
      clip("long-filler", 1000, 7000, {
        role: "filler",
        text: "えー",
        keepScore: 0.2,
        signals: signals({
          importance: 0.05,
          filler: 0.95,
          redundancy: 0.8,
          removalNatural: 0.9,
          contextRequired: 0.05,
        }),
      }),
    ];
    const ranked = rankDeletionCandidates(clips);
    assert.equal(ranked[0]?.clipId, "long-filler");
    assert.ok((ranked[0]?.dropScore ?? 0) > (ranked[1]?.dropScore ?? 0));
    assert.ok((ranked[0]?.value ?? 1) < (ranked[1]?.value ?? 0));
    assert.ok((ranked[0]?.durationMs ?? 0) > (ranked[1]?.durationMs ?? 0));
  });

  it("ranks linked Q/A below unlinked filler because of dependency", () => {
    const clips = [
      clip("q", 0, 2000, {
        text: "会社辞めようと思ったことあります？",
        keepScore: 0.45,
      }),
      clip("a", 2000, 4000, {
        text: "あります。",
        keepScore: 0.45,
      }),
      clip("filler", 4000, 6000, {
        role: "filler",
        text: "えー",
        keepScore: 0.45,
        signals: signals({ filler: 0.9, removalNatural: 0.9, contextRequired: 0.05 }),
      }),
    ];
    const ranked = rankDeletionCandidates(clips);
    const filler = ranked.find((item) => item.clipId === "filler");
    const question = ranked.find((item) => item.clipId === "q");
    assert.ok(filler);
    assert.ok(question);
    assert.ok((filler?.dependency ?? 1) < (question?.dependency ?? 0));
    assert.ok((filler?.dropScore ?? 0) > (question?.dropScore ?? 0));
  });
});

describe("packToTargetDuration", () => {
  it("delegates to the duration optimizer", () => {
    const clips = [
      clip("long", 0, 9000, { keepScore: 0.9 }),
      clip("a", 9000, 13_000, { keepScore: 0.8 }),
      clip("b", 13_000, 17_000, { keepScore: 0.8 }),
    ];
    const packed = packToTargetDuration(clips, 8000);
    assert.deepEqual(keepIds(packed).sort(), ["a", "b"]);
  });
});
