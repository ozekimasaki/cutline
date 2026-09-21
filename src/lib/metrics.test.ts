import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildTimelineIR } from "./decide";
import { computeJobMetrics, computeJobMetricsFromJob } from "./metrics";
import { mockSignals } from "./sample";
import type { ContinuityQa, ScoredClip, WatchQa } from "./types";

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
    signals: extra.signals ?? mockSignals(unit),
    keepScore: 0.8,
    autoMarker: false,
    verdict,
    verdictSource: extra.verdictSource ?? "code",
    reason: extra.reason ?? "content",
    ...extra,
  };
}

const cleanContinuity: ContinuityQa = {
  conversationMakesSense: true,
  missingReferences: false,
  pronounLostAntecedent: false,
  questionLostAnswer: false,
  unnecessaryRepetition: false,
  issues: [],
};

describe("computeJobMetrics", () => {
  it("scores a clean keep from Timeline IR without using auto-edit-rate", () => {
    const clips = [
      clip("a", "今年の2月から始めました", "keep", {
        startMs: 0,
        endMs: 4000,
        camera: "A",
      }),
      clip("b", "判断は Jev です", "keep", {
        startMs: 4000,
        endMs: 8000,
        camera: "A",
      }),
    ];
    const timeline = buildTimelineIR({
      timelineId: "t1",
      fileName: "talk.mp4",
      clips,
    });
    const metrics = computeJobMetrics({
      clips,
      sourceDurationMs: 8000,
      timeline,
      continuity: cleanContinuity,
      qa: {
        meaningRisks: [],
        cutCount: 0,
        keepCount: 2,
        reviewCount: 0,
        finalDurationMs: 8000,
        humanCorrections: 0,
        cameraSwitchCount: 0,
        averageShotLengthMs: 4000,
        jumpCutCount: 0,
        cameraSwitchRate: 0,
      },
    });
    assert.equal(metrics.keepRatio, 1);
    assert.equal(metrics.editing.finalDurationMs, 8000);
    assert.equal(metrics.editing.cutCount, 0);
    assert.equal(metrics.editing.jumpCutCount, 0);
    assert.ok(metrics.northStar.meaningContinuity >= 0.9);
    assert.ok(metrics.northStar.watchability >= 0.9);
    assert.ok(metrics.humanTextureRetention >= 0.9);
    assert.equal("autoEditRate" in metrics, false);
    assert.equal("automaticEditRate" in metrics.northStar, false);
  });

  it("counts same-camera source gaps as jump cuts", () => {
    const clips = [
      clip("a", "今日は", "keep", {
        startMs: 0,
        endMs: 2000,
        camera: "A",
      }),
      clip("gap", "えー", "cut", {
        startMs: 2000,
        endMs: 4000,
        role: "filler",
        camera: "A",
      }),
      clip("b", "続きです", "keep", {
        startMs: 4000,
        endMs: 6000,
        camera: "A",
      }),
    ];
    const timeline = buildTimelineIR({
      timelineId: "jump",
      fileName: "talk.mp4",
      clips,
    });
    const metrics = computeJobMetrics({
      clips,
      sourceDurationMs: 6000,
      timeline,
      continuity: cleanContinuity,
    });
    assert.equal(metrics.editing.jumpCutCount, 1);
    assert.ok(metrics.keepRatio < 0.8);
    assert.ok(metrics.keepRatio > 0.5);
  });

  it("drops human texture when a thinking pause is cut", () => {
    const pause = clip("p", "", "cut", {
      startMs: 2000,
      endMs: 5000,
      role: "pause",
      pauseClass: "thinking",
      signals: {
        ...mockSignals({
          id: "p",
          speaker: "A",
          text: "",
          startMs: 2000,
          endMs: 5000,
          role: "pause",
          pauseClass: "thinking",
        }),
        humanTexture: 0.9,
      },
    });
    const kept = clip("c", "あります", "keep", {
      startMs: 0,
      endMs: 2000,
      signals: {
        ...mockSignals({
          id: "c",
          speaker: "A",
          text: "あります",
          startMs: 0,
          endMs: 2000,
          role: "content",
        }),
        humanTexture: 0.2,
      },
    });
    const metrics = computeJobMetrics({
      clips: [kept, pause],
      sourceDurationMs: 5000,
      continuity: cleanContinuity,
    });
    assert.ok(metrics.humanTextureRetention < 0.4);
    assert.equal(metrics.northStar.humanTexture, metrics.humanTextureRetention);
  });

  it("lowers meaning continuity for a broken conversation", () => {
    const clips = [
      clip("q", "会社辞めようと思ったことあります？", "keep", {
        startMs: 0,
        endMs: 2000,
        speaker: "B",
      }),
      clip("a", "……あります。", "cut", {
        startMs: 5000,
        endMs: 6200,
      }),
    ];
    const continuity: ContinuityQa = {
      conversationMakesSense: false,
      missingReferences: false,
      pronounLostAntecedent: false,
      questionLostAnswer: true,
      unnecessaryRepetition: false,
      issues: [{ clipId: "q", issue: "質問のあとに答えが残っていない" }],
    };
    const metrics = computeJobMetrics({
      clips,
      sourceDurationMs: 6200,
      continuity,
    });
    assert.equal(metrics.watch.brokenConversations, true);
    assert.ok(metrics.northStar.meaningContinuity < 0.6);
    assert.equal(metrics.semantic.continuityError, 1);
  });

  it("records watch QA flags including audio and missing context", () => {
    const clips = [
      clip("a", "前置き", "keep", { startMs: 0, endMs: 2000 }),
      clip("b", "本題", "keep", { startMs: 20_000, endMs: 22_000 }),
    ];
    const watchQa: WatchQa = {
      source: "mock",
      iterations: 1,
      brokenConversations: false,
      abruptTopicChanges: true,
      obviousBadCuts: true,
      audioDiscontinuities: true,
      missingContext: true,
      awkwardCameraSwitching: false,
      issues: [{ issue: "audio gap" }],
      ok: false,
    };
    const metrics = computeJobMetrics({
      clips,
      sourceDurationMs: 22_000,
      watchQa,
      continuity: cleanContinuity,
    });
    assert.equal(metrics.watch.abruptTopicChanges, true);
    assert.equal(metrics.watch.obviousBadCuts, true);
    assert.equal(metrics.watch.audioDiscontinuities, true);
    assert.equal(metrics.watch.missingContext, true);
    assert.ok(metrics.northStar.watchability < 0.5);
  });

  it("treats filler kept as missed cuts and content cuts as critical deletions", () => {
    const clips = [
      clip("fill", "えー", "keep", {
        startMs: 0,
        endMs: 700,
        role: "filler",
      }),
      clip("key", "今年の2月から始めました", "cut", {
        startMs: 3500,
        endMs: 6200,
        signals: {
          ...mockSignals({
            id: "key",
            speaker: "A",
            text: "今年の2月から始めました",
            startMs: 3500,
            endMs: 6200,
            role: "content",
          }),
          importance: 0.9,
          contextRequired: 0.8,
        },
      }),
    ];
    const metrics = computeJobMetrics({
      clips,
      sourceDurationMs: 6200,
      continuity: cleanContinuity,
    });
    assert.equal(metrics.semantic.missedCutRate, 1);
    assert.equal(metrics.semantic.criticalDeletionRate, 1);
  });

  it("reads the same numbers from a Job via computeJobMetricsFromJob", () => {
    const clips = [
      clip("a", "残す", "keep", {
        startMs: 0,
        endMs: 3000,
        verdictSource: "user",
      }),
    ];
    const metrics = computeJobMetricsFromJob({
      clips,
      sourceDurationMs: 3000,
      qa: {
        meaningRisks: [],
        cutCount: 0,
        keepCount: 1,
        reviewCount: 0,
        finalDurationMs: 3000,
        humanCorrections: 1,
        cameraSwitchCount: 0,
        averageShotLengthMs: 3000,
        jumpCutCount: 0,
        cameraSwitchRate: 0,
      },
      continuity: cleanContinuity,
    });
    assert.equal(metrics.editing.humanCorrections, 1);
    assert.equal(metrics.keepRatio, 1);
  });

  it("attaches Human Correction Time without changing north-star scores", () => {
    const clips = [
      clip("a", "今年の2月から始めました", "keep", {
        startMs: 0,
        endMs: 4_000,
      }),
    ];
    const scored = computeJobMetrics({
      clips,
      sourceDurationMs: 60 * 60 * 1000,
      continuity: cleanContinuity,
    });
    const withReview = computeJobMetrics({
      clips,
      sourceDurationMs: 60 * 60 * 1000,
      continuity: cleanContinuity,
      aiReviewMs: 20 * 60 * 1000,
    });
    assert.deepEqual(scored.northStar, withReview.northStar);
    assert.deepEqual(scored.editing, withReview.editing);
    assert.equal(withReview.humanCorrectionTime?.sourceDurationMs, 3_600_000);
    assert.equal(withReview.humanCorrectionTime?.aiNoneEditMs, 10_800_000);
    assert.equal(withReview.humanCorrectionTime?.aiReviewMs, 1_200_000);
    assert.equal(withReview.humanCorrectionTime?.savedMs, 9_600_000);
    assert.equal(scored.humanCorrectionTime?.aiReviewMs, 0);
  });

  it("preserves HCT when recomputing from a Job", () => {
    const clips = [
      clip("a", "残す", "keep", { startMs: 0, endMs: 3000 }),
    ];
    const metrics = computeJobMetricsFromJob({
      clips,
      sourceDurationMs: 3000,
      metrics: {
        northStar: { meaningContinuity: 1, humanTexture: 1, watchability: 1 },
        semantic: {
          criticalDeletionRate: 0,
          falseCutRate: 0,
          missedCutRate: 0,
          continuityError: 0,
          meaningChangeRate: 0,
        },
        editing: {
          finalDurationMs: 3000,
          cutCount: 0,
          averageShotLengthMs: 3000,
          cameraSwitchRate: 0,
          jumpCutCount: 0,
          humanCorrections: 0,
        },
        watch: {
          brokenConversations: false,
          abruptTopicChanges: false,
          obviousBadCuts: false,
          audioDiscontinuities: false,
          missingContext: false,
        },
        keepRatio: 1,
        humanTextureRetention: 1,
        humanCorrectionTime: {
          sourceDurationMs: 3000,
          aiNoneEditMs: 9000,
          aiReviewMs: 1500,
          savedMs: 7500,
        },
      },
    });
    assert.equal(metrics.humanCorrectionTime?.aiReviewMs, 1500);
    assert.equal(metrics.humanCorrectionTime?.aiNoneEditMs, 9000);
  });
});
