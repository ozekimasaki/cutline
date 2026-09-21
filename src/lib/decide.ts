import { optimizeDuration } from "./duration";
import type {
  EditProfile,
  JevSignals,
  OmniPauseLabel,
  PauseClass,
  ScoredClip,
  TimelineIR,
  Verdict,
} from "./types";

export type PauseKeepPolicy = "keep" | "compress";

export function computeKeepScore(
  signals: JevSignals,
  profile: EditProfile,
): number {
  const answerContribution = clamp01(
    1 - Math.max(signals.filler, signals.falseStart, signals.tangent),
  );
  let score =
    signals.importance * 0.3 +
    signals.novelty * 0.15 +
    signals.contextRequired * 0.25 +
    signals.humanTexture * 0.15 +
    answerContribution * 0.15 -
    signals.redundancy * 0.25 -
    signals.filler * 0.15 -
    signals.falseStart * 0.15 -
    signals.tangent * 0.2;

  switch (profile) {
    case "natural":
      score += signals.humanTexture * 0.12;
      score += signals.filler * 0.06;
      break;
    case "tight":
      score -= signals.filler * 0.12;
      score -= signals.redundancy * 0.08;
      break;
    case "short":
      score -= (1 - signals.importance) * 0.12;
      score -= signals.filler * 0.1;
      break;
    case "standard":
      break;
    default: {
      const _never: never = profile;
      return _never;
    }
  }

  return clamp01((score + 0.6) / 1.6);
}

export function decideVerdict(
  signals: JevSignals,
  keepScore: number,
): { verdict: Verdict; autoMarker: boolean } {
  if (signals.reviewRequired >= 0.5) {
    return { verdict: "review", autoMarker: false };
  }

  if (signals.confidence < 0.6) {
    return { verdict: "keep", autoMarker: false };
  }

  if (signals.confidence < 0.8) {
    return { verdict: "review", autoMarker: false };
  }

  const autoMarker = signals.confidence < 0.95;
  if (keepScore >= 0.45) {
    return { verdict: "keep", autoMarker };
  }
  return { verdict: "cut", autoMarker };
}

export function packToTargetDuration(
  clips: ScoredClip[],
  targetDurationMs: number,
): ScoredClip[] {
  return optimizeDuration(applyPauseKeepPolicy(clips), targetDurationMs);
}

export function buildTimelineIR(input: {
  timelineId: string;
  fileName: string;
  clips: ScoredClip[];
}): TimelineIR {
  const kept = keptClips(input.clips);
  let timelineIn = 0;
  const timelineClips = kept.map((clip) => {
    const item = {
      source: input.fileName,
      sourceIn: clip.startMs / 1000,
      sourceOut: clip.endMs / 1000,
      timelineIn,
      camera: clip.camera ?? "A",
      speaker: clip.speaker,
      decision: {
        reason: clip.reason,
        confidence: clip.signals.confidence,
      },
    };
    timelineIn += durationOf(clip) / 1000;
    return item;
  });

  const removals = input.clips
    .filter((clip) => clip.verdict === "cut")
    .map((clip) => ({
      type: "remove" as const,
      start: clip.startMs / 1000,
      end: clip.endMs / 1000,
      reason: clip.reason,
      confidence: clip.signals.confidence,
    }));

  return {
    timelineId: input.timelineId,
    clips: timelineClips,
    removals,
  };
}

export function keptClips(clips: ScoredClip[]): ScoredClip[] {
  return clips
    .filter((clip) => clip.verdict === "keep")
    .sort((a, b) => a.startMs - b.startMs);
}

export function durationOf(clip: { startMs: number; endMs: number }): number {
  return Math.max(0, clip.endMs - clip.startMs);
}

export function verdictLabel(verdict: Verdict): string {
  switch (verdict) {
    case "keep":
      return "KEEP";
    case "cut":
      return "CUT";
    case "review":
      return "REVIEW";
    default: {
      const _never: never = verdict;
      return _never;
    }
  }
}

export function profileLabel(profile: EditProfile): string {
  switch (profile) {
    case "natural":
      return "自然";
    case "standard":
      return "標準";
    case "tight":
      return "タイト";
    case "short":
      return "短め";
    default: {
      const _never: never = profile;
      return _never;
    }
  }
}

export function classifyPause(durationMs: number): PauseClass {
  if (durationMs < 250) {
    return "micro";
  }
  if (durationMs < 700) {
    return "normal";
  }
  if (durationMs < 1500) {
    return "thinking";
  }
  return "long";
}

/** Spec §35. dramatic/thinking keep texture; awkward/technical may compress. 迷ったら残す. */
export function pauseKeepPolicy(
  pauseLabel: OmniPauseLabel | undefined,
  pauseClass?: PauseClass,
  durationMs = 0,
): PauseKeepPolicy {
  switch (pauseLabel) {
    case "dramatic_pause":
    case "thinking_pause":
      return "keep";
    case "awkward_pause":
    case "technical_pause":
      return "compress";
    case undefined:
      break;
    default: {
      const _never: never = pauseLabel;
      return _never;
    }
  }
  const bucket = pauseClass ?? classifyPause(durationMs);
  switch (bucket) {
    case "thinking":
    case "long":
      return "keep";
    case "micro":
    case "normal":
      return "compress";
    default: {
      const _never: never = bucket;
      return _never;
    }
  }
}

export function applyPauseKeepPolicy(clips: ScoredClip[]): ScoredClip[] {
  return clips.map((clip) => applyPauseKeepToClip(clip));
}

function applyPauseKeepToClip(clip: ScoredClip): ScoredClip {
  if (clip.role !== "pause" || clip.verdictSource === "user") {
    return clip;
  }
  const policy = pauseKeepPolicy(
    clip.omni?.pauseLabel,
    clip.pauseClass,
    durationOf(clip),
  );
  switch (policy) {
    case "keep":
      return {
        ...clip,
        keepScore: Math.max(clip.keepScore, 0.55),
        verdict: "keep",
        reason:
          clip.verdict === "keep"
            ? clip.reason
            : `${clip.reason}（間の質感として残す）`,
      };
    case "compress":
      return {
        ...clip,
        keepScore: Math.min(clip.keepScore, 0.32),
      };
    default: {
      const _never: never = policy;
      return _never;
    }
  }
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}
