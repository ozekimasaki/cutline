import { durationOf } from "./decide";
import type {
  ContinuityQa,
  FinalQa,
  HumanCorrectionTime,
  Job,
  JobMetrics,
  ScoredClip,
  TimelineIR,
  WatchQa,
} from "./types";

const JUMP_GAP_SEC = 0.08;
const ABRUPT_TOPIC_GAP_MS = 12_000;
const CRITICAL_IMPORTANCE = 0.6;
/** Spec §96: 60min source → 3h edit without AI. */
export const AI_NONE_EDIT_MULTIPLIER = 3;

export type MetricsInput = {
  clips: ScoredClip[];
  sourceDurationMs: number;
  timeline?: TimelineIR;
  qa?: FinalQa;
  watchQa?: WatchQa;
  continuity?: ContinuityQa;
  aiReviewMs?: number;
};

export function computeJobMetrics(input: MetricsInput): JobMetrics {
  const watch = deriveWatchFlags(input);
  const editing = editingMetrics(input);
  const semantic = semanticMetrics(input, watch);
  const keepRatio = keepRatioOf(input, editing.finalDurationMs);
  const humanTextureRetention = textureRetention(input.clips);
  const northStar = {
    meaningContinuity: meaningContinuityScore(input, watch, semantic),
    humanTexture: humanTextureRetention,
    watchability: watchabilityScore(input, watch, editing),
  };
  return {
    northStar: {
      meaningContinuity: round4(northStar.meaningContinuity),
      humanTexture: round4(northStar.humanTexture),
      watchability: round4(northStar.watchability),
    },
    semantic: {
      criticalDeletionRate: round4(semantic.criticalDeletionRate),
      falseCutRate: round4(semantic.falseCutRate),
      missedCutRate: round4(semantic.missedCutRate),
      continuityError: semantic.continuityError,
      meaningChangeRate: round4(semantic.meaningChangeRate),
    },
    editing,
    watch,
    keepRatio: round4(keepRatio),
    humanTextureRetention: round4(humanTextureRetention),
    humanCorrectionTime: buildHumanCorrectionTime({
      sourceDurationMs:
        input.sourceDurationMs > 0 ? input.sourceDurationMs : spanMs(input.clips),
      aiReviewMs: input.aiReviewMs ?? 0,
    }),
  };
}

export function buildHumanCorrectionTime(input: {
  sourceDurationMs: number;
  aiReviewMs: number;
}): HumanCorrectionTime {
  const sourceDurationMs = Math.max(0, Math.round(input.sourceDurationMs));
  const aiNoneEditMs = sourceDurationMs * AI_NONE_EDIT_MULTIPLIER;
  const aiReviewMs = Math.max(0, Math.round(input.aiReviewMs));
  return {
    sourceDurationMs,
    aiNoneEditMs,
    aiReviewMs,
    savedMs: Math.max(0, aiNoneEditMs - aiReviewMs),
  };
}

export function attachHumanCorrectionTime(
  metrics: JobMetrics,
  input: { sourceDurationMs: number; aiReviewMs: number },
): JobMetrics {
  return {
    ...metrics,
    humanCorrectionTime: buildHumanCorrectionTime(input),
  };
}

export function computeJobMetricsFromJob(
  job: Pick<
    Job,
    | "clips"
    | "sourceDurationMs"
    | "timeline"
    | "qa"
    | "watchQa"
    | "continuity"
    | "metrics"
  >,
): JobMetrics {
  return computeJobMetrics({
    clips: job.clips,
    sourceDurationMs: job.sourceDurationMs,
    timeline: job.timeline,
    qa: job.qa,
    watchQa: job.watchQa,
    continuity: job.continuity,
    aiReviewMs: job.metrics?.humanCorrectionTime?.aiReviewMs,
  });
}

function deriveWatchFlags(input: MetricsInput): JobMetrics["watch"] {
  if (input.watchQa) {
    return {
      brokenConversations: input.watchQa.brokenConversations,
      abruptTopicChanges: input.watchQa.abruptTopicChanges,
      obviousBadCuts: input.watchQa.obviousBadCuts,
      audioDiscontinuities: input.watchQa.audioDiscontinuities,
      missingContext: input.watchQa.missingContext,
    };
  }
  const kept = input.clips.filter((clip) => clip.verdict === "keep");
  const continuity = input.continuity;
  const brokenConversations = continuity?.questionLostAnswer === true;
  const missingContext =
    continuity?.missingReferences === true ||
    continuity?.pronounLostAntecedent === true ||
    (continuity?.issues.length ?? 0) > 0;
  const abruptTopicChanges = kept.some((clip, index) => {
    if (index === 0) {
      return false;
    }
    const previous = kept[index - 1];
    return Boolean(previous && clip.startMs - previous.endMs > ABRUPT_TOPIC_GAP_MS);
  });
  const obviousBadCuts = input.clips.some((clip, index) => {
    const next = input.clips[index + 1];
    return (
      clip.verdict === "cut" &&
      clip.role === "content" &&
      next?.verdict === "keep" &&
      next.speaker === clip.speaker
    );
  });
  return {
    brokenConversations,
    abruptTopicChanges,
    obviousBadCuts,
    audioDiscontinuities: false,
    missingContext,
  };
}

function editingMetrics(input: MetricsInput): JobMetrics["editing"] {
  const fromTimeline = timelineEditing(input.timeline);
  const qa = input.qa;
  const kept = input.clips.filter((clip) => clip.verdict === "keep");
  const cutCount =
    qa?.cutCount ??
    fromTimeline?.cutCount ??
    input.clips.filter((clip) => clip.verdict === "cut").length;
  const finalDurationMs =
    qa?.finalDurationMs ??
    fromTimeline?.finalDurationMs ??
    kept.reduce((sum, clip) => sum + durationOf(clip), 0);
  const keepCount = qa?.keepCount ?? fromTimeline?.keepCount ?? kept.length;
  const averageShotLengthMs =
    qa?.averageShotLengthMs ??
    fromTimeline?.averageShotLengthMs ??
    (keepCount === 0 ? 0 : Math.round(finalDurationMs / keepCount));
  const cameraSwitchRate =
    qa?.cameraSwitchRate ?? fromTimeline?.cameraSwitchRate ?? 0;
  const jumpCutCount = Math.max(
    qa?.jumpCutCount ?? 0,
    fromTimeline?.jumpCutCount ?? clipJumpCuts(kept),
  );
  const humanCorrections =
    qa?.humanCorrections ??
    input.clips.filter((clip) => clip.verdictSource === "user").length;
  return {
    finalDurationMs,
    cutCount,
    averageShotLengthMs,
    cameraSwitchRate,
    jumpCutCount,
    humanCorrections,
  };
}

function timelineEditing(timeline: TimelineIR | undefined):
  | {
      finalDurationMs: number;
      cutCount: number;
      keepCount: number;
      averageShotLengthMs: number;
      cameraSwitchRate: number;
      jumpCutCount: number;
    }
  | undefined {
  if (!timeline) {
    return undefined;
  }
  const clips = timeline.clips;
  const last = clips[clips.length - 1];
  const finalDurationMs = last
    ? Math.round((last.timelineIn + (last.sourceOut - last.sourceIn)) * 1000)
    : 0;
  const keepCount = clips.length;
  let cameraSwitchCount = 0;
  let jumpCutCount = 0;
  for (let index = 1; index < clips.length; index += 1) {
    const previous = clips[index - 1];
    const clip = clips[index];
    if (!previous || !clip) {
      continue;
    }
    if (clip.camera !== previous.camera) {
      cameraSwitchCount += 1;
    } else if (clip.sourceIn - previous.sourceOut > JUMP_GAP_SEC) {
      jumpCutCount += 1;
    }
  }
  const minutes = finalDurationMs / 60_000;
  return {
    finalDurationMs,
    cutCount: timeline.removals.length,
    keepCount,
    averageShotLengthMs:
      keepCount === 0 ? 0 : Math.round(finalDurationMs / keepCount),
    cameraSwitchRate: minutes > 0 ? cameraSwitchCount / minutes : 0,
    jumpCutCount,
  };
}

function clipJumpCuts(kept: ScoredClip[]): number {
  return kept.reduce((count, clip, index) => {
    if (index === 0) {
      return count;
    }
    const previous = kept[index - 1];
    if (!previous) {
      return count;
    }
    const sameCamera =
      (clip.camera ?? "A") === (previous.camera ?? "A");
    const gap = clip.startMs - previous.endMs > JUMP_GAP_SEC * 1000;
    const punched = clip.punchIn === true;
    return count + (sameCamera && (gap || punched) ? 1 : 0);
  }, 0);
}

function semanticMetrics(
  input: MetricsInput,
  watch: JobMetrics["watch"],
): JobMetrics["semantic"] {
  const clips = input.clips;
  const critical = clips.filter(
    (clip) =>
      clip.role === "content" &&
      (clip.signals.importance >= CRITICAL_IMPORTANCE ||
        clip.signals.contextRequired >= CRITICAL_IMPORTANCE),
  );
  const criticalCut = critical.filter((clip) => clip.verdict === "cut").length;
  const criticalDeletionRate =
    critical.length === 0 ? 0 : criticalCut / critical.length;

  const cuts = clips.filter((clip) => clip.verdict === "cut");
  let falseCuts = 0;
  for (let index = 0; index < clips.length; index += 1) {
    const clip = clips[index];
    const next = clips[index + 1];
    const previous = clips[index - 1];
    if (!clip || clip.verdict !== "cut" || clip.role !== "content") {
      continue;
    }
    const adjacentKeepSameSpeaker =
      (next?.verdict === "keep" && next.speaker === clip.speaker) ||
      (previous?.verdict === "keep" && previous.speaker === clip.speaker);
    if (adjacentKeepSameSpeaker) {
      falseCuts += 1;
    }
  }
  if (watch.obviousBadCuts && falseCuts === 0 && cuts.length > 0) {
    falseCuts = 1;
  }
  const falseCutRate = cuts.length === 0 ? 0 : falseCuts / cuts.length;

  const cuttable = clips.filter(
    (clip) =>
      clip.role === "filler" ||
      clip.role === "false_start" ||
      clip.role === "self_correction",
  );
  const missed = cuttable.filter((clip) => clip.verdict === "keep").length;
  const missedCutRate = cuttable.length === 0 ? 0 : missed / cuttable.length;

  const continuityError = input.continuity?.issues.length ?? 0;
  const keepCount =
    input.qa?.keepCount ??
    clips.filter((clip) => clip.verdict === "keep").length;
  const meaningRisks = input.qa?.meaningRisks.length ?? 0;
  const meaningChangeRate =
    keepCount === 0 ? (meaningRisks > 0 ? 1 : 0) : meaningRisks / keepCount;

  return {
    criticalDeletionRate,
    falseCutRate,
    missedCutRate,
    continuityError,
    meaningChangeRate,
  };
}

function keepRatioOf(input: MetricsInput, finalDurationMs: number): number {
  const source =
    input.sourceDurationMs > 0
      ? input.sourceDurationMs
      : spanMs(input.clips);
  if (source <= 0) {
    return 0;
  }
  return clamp01(finalDurationMs / source);
}

function textureRetention(clips: ScoredClip[]): number {
  let all = 0;
  let kept = 0;
  for (const clip of clips) {
    const mass = clip.signals.humanTexture * durationOf(clip);
    all += mass;
    if (clip.verdict === "keep") {
      kept += mass;
    }
  }
  if (all <= 0) {
    return 1;
  }
  return clamp01(kept / all);
}

function meaningContinuityScore(
  input: MetricsInput,
  watch: JobMetrics["watch"],
  semantic: JobMetrics["semantic"],
): number {
  let score = 1;
  if (watch.brokenConversations) {
    score -= 0.4;
  }
  if (watch.missingContext) {
    score -= 0.2;
  }
  if (input.continuity && !input.continuity.conversationMakesSense) {
    score -= 0.15;
  }
  score -= 0.25 * semantic.meaningChangeRate;
  score -= 0.05 * Math.min(semantic.continuityError, 5);
  return clamp01(score);
}

function watchabilityScore(
  input: MetricsInput,
  watch: JobMetrics["watch"],
  editing: JobMetrics["editing"],
): number {
  let score = 1;
  if (watch.brokenConversations) {
    score -= 0.25;
  }
  if (watch.abruptTopicChanges) {
    score -= 0.15;
  }
  if (watch.obviousBadCuts) {
    score -= 0.2;
  }
  if (watch.audioDiscontinuities) {
    score -= 0.2;
  }
  if (watch.missingContext) {
    score -= 0.15;
  }
  if (input.watchQa?.awkwardCameraSwitching) {
    score -= 0.1;
  }
  const minutes = editing.finalDurationMs / 60_000;
  if (minutes > 0 && editing.jumpCutCount / minutes > 2) {
    score -= 0.1;
  }
  return clamp01(score);
}

function spanMs(clips: ScoredClip[]): number {
  if (clips.length === 0) {
    return 0;
  }
  const start = Math.min(...clips.map((clip) => clip.startMs));
  const end = Math.max(...clips.map((clip) => clip.endMs));
  return Math.max(0, end - start);
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}
