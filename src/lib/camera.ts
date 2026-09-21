import { durationOf } from "./decide";
import type {
  CameraId,
  OmniCameraVisual,
  OmniVisualState,
  ScoredClip,
} from "./types";

export const CAMERA_IDS: CameraId[] = ["A", "B", "WIDE"];

export const HYSTERESIS = 0.15;
export const FATIGUE_MS = 4_000;
export const MIN_NORMAL_MS = 1_500;
export const MIN_REACTION_MS = 800;
export const MIN_WIDE_MS = 2_000;

const DEFAULT_VISUAL_QUALITY = 0.72;
const UNUSABLE_PENALTY = 1;

export type CameraSignals = {
  speakerCamera: CameraId;
  speakerValue: number;
  listenerReactionValue: number;
  wideResetValue: number;
  shotFatigue: number;
  cameraContinuity: number;
  visualQuality: number;
  cutMotivation: number;
};

export function speakerCameraOf(speaker: string): CameraId {
  return speaker.trim().toUpperCase() === "B" ? "B" : "A";
}

export function cameraSignals(
  clip: ScoredClip,
  previous: CameraId | undefined,
  sameCameraMs: number,
  jump: boolean,
): CameraSignals {
  const visual = clip.omni?.visual;
  const speakerCamera = speakerCameraOf(clip.speaker);
  const reactionStrength =
    visual?.listener_reaction.strength ?? clip.signals.reactionValue;
  const expressionBoost = reactiveExpressionBoost(visual, speakerCamera);
  const reaction =
    clip.role === "backchannel" || reactionStrength >= 0.5
      ? Math.max(0.7, reactionStrength + expressionBoost)
      : 0.16;
  return {
    speakerCamera,
    speakerValue: clip.role === "content" ? 0.84 : 0.62,
    listenerReactionValue: reaction,
    wideResetValue: wideReset,
    shotFatigue: Math.min(1, sameCameraMs / FATIGUE_MS),
    cameraContinuity: previous ? 0.36 : 0,
    visualQuality: visualQualityOf(visual, speakerCamera),
    cutMotivation: jump ? 0.84 : 0.18,
  };
}

export function shotScore(
  camera: CameraId,
  signals: CameraSignals,
  previous: CameraId | undefined,
  clip: ScoredClip,
): number {
  const visual = clip.omni?.visual;
  const fatigue = previous === camera ? signals.shotFatigue * 0.5 : 0;
  const continuity = previous === camera ? signals.cameraContinuity : 0;
  const qualityDelta = visualQualityOf(visual, camera) - DEFAULT_VISUAL_QUALITY;
  const usableBoost = isCameraUsable(visual, camera) ? qualityDelta : -UNUSABLE_PENALTY;
  switch (camera) {
    case "A":
    case "B": {
      if (camera === signals.speakerCamera) {
        return (
          signals.speakerValue +
          (clip.role === "backchannel" ? 0.22 : 0) +
          continuity -
          fatigue +
          usableBoost
        );
      }
      const reaction =
        clip.role === "backchannel" ? 0.12 : signals.listenerReactionValue;
      return reaction + continuity - fatigue + usableBoost;
    }
    case "WIDE":
      return (
        signals.wideResetValue +
        (previous === "WIDE" ? continuity : 0) +
        signals.shotFatigue * 0.2 -
        (previous === "WIDE" ? fatigue : 0) +
        usableBoost
      );
    default: {
      const _never: never = camera;
      return _never;
    }
  }
}

export function assignCameras(clips: ScoredClip[]): ScoredClip[] {
  const ordered = [...clips].sort((a, b) => a.startMs - b.startMs);
  const assigned = new Map<string, ScoredClip>();
  let previousKeep: ScoredClip | undefined;
  let current: CameraId | undefined;
  let sameCameraMs = 0;

  for (const clip of ordered) {
    if (clip.verdict !== "keep") {
      assigned.set(clip.id, clip);
      continue;
    }
    const jump = Boolean(
      previousKeep && clip.startMs - previousKeep.endMs >= 250,
    );
    const choice = pickCamera({
      clip,
      previous: current,
      sameCameraMs,
      jump,
    });
    assigned.set(clip.id, {
      ...clip,
      camera: choice.camera,
      punchIn: choice.punchIn,
      morph: choice.morph,
      cameraReason: choice.reason,
    });
    sameCameraMs =
      current === choice.camera
        ? sameCameraMs + durationOf(clip)
        : durationOf(clip);
    current = choice.camera;
    previousKeep = clip;
  }

  return clips.map((clip) => assigned.get(clip.id) ?? clip);
}

function pickCamera(input: {
  clip: ScoredClip;
  previous: CameraId | undefined;
  sameCameraMs: number;
  jump: boolean;
}): { camera: CameraId; punchIn: boolean; morph: boolean; reason: string } {
  const signals = cameraSignals(
    input.clip,
    input.previous,
    input.sameCameraMs,
    input.jump,
  );
  const ranked = CAMERA_IDS.map((id) => ({
    id,
    score: shotScore(id, signals, input.previous, input.clip),
  })).sort((a, b) => b.score - a.score);
  let candidate = ranked[0] ?? { id: "A" as const, score: 0 };
  const visual = input.clip.omni?.visual;
  const previousUsable = isCameraUsable(visual, input.previous);

  if (input.previous && previousUsable) {
    const currentScore =
      ranked.find((item) => item.id === input.previous)?.score ?? 0;
    if (
      candidate.id !== input.previous &&
      candidate.score < currentScore + HYSTERESIS
    ) {
      candidate = { id: input.previous, score: currentScore };
    }
    const minMs = minShotMs(candidate.id, signals.listenerReactionValue >= 0.6);
    if (candidate.id !== input.previous && durationOf(input.clip) < minMs) {
      candidate = { id: input.previous, score: currentScore };
    }
  }

  let punchIn = false;
  if (input.jump && input.previous && candidate.id === input.previous) {
    const wide = ranked.find((item) => item.id === "WIDE");
    const reaction = ranked.find(
      (item) => item.id !== input.previous && item.id !== "WIDE",
    );
    if (wide && durationOf(input.clip) >= MIN_WIDE_MS) {
      candidate = wide;
    } else if (reaction && durationOf(input.clip) >= MIN_REACTION_MS) {
      candidate = reaction;
    } else {
      punchIn = true;
    }
  }

  const morph = Boolean(
    input.jump && input.previous && candidate.id === input.previous,
  );

  return {
    camera: candidate.id,
    punchIn,
    morph,
    reason: reasonOf(candidate.id, signals, punchIn, morph, input.jump),
  };
}

function minShotMs(camera: CameraId, reaction: boolean): number {
  if (camera === "WIDE") {
    return MIN_WIDE_MS;
  }
  return reaction ? MIN_REACTION_MS : MIN_NORMAL_MS;
}

function reasonOf(
  camera: CameraId,
  signals: CameraSignals,
  punchIn: boolean,
  morph: boolean,
  jump: boolean,
): string {
  if (punchIn) {
    return "jump cut を punch-in で隠す";
  }
  if (morph) {
    return "jump cut を morph で隠す";
  }
  if (camera === "WIDE") {
    return jump || signals.shotFatigue >= 0.8 ? "wide reset" : "wide";
  }
  if (camera !== signals.speakerCamera) {
    return "listener reaction";
  }
  return "speaker camera";
}

export function cameraSwitchCount(clips: ScoredClip[]): number {
  const kept = clips
    .filter((clip) => clip.verdict === "keep")
    .sort((a, b) => a.startMs - b.startMs);
  let switches = 0;
  for (let index = 1; index < kept.length; index += 1) {
    if (kept[index]?.camera && kept[index]?.camera !== kept[index - 1]?.camera) {
      switches += 1;
    }
  }
  return switches;
}

export function isCameraUsable(
  visual: OmniVisualState | undefined,
  camera: CameraId | undefined,
): boolean {
  if (!camera) {
    return true;
  }
  return cameraVisualOf(visual, camera)?.usable ?? true;
}

function cameraVisualOf(
  visual: OmniVisualState | undefined,
  camera: CameraId,
): OmniCameraVisual | undefined {
  if (!visual) {
    return undefined;
  }
  switch (camera) {
    case "A":
      return visual.camera_a;
    case "B":
      return visual.camera_b;
    case "WIDE":
      return visual.wide;
    default: {
      const _never: never = camera;
      return _never;
    }
  }
}

function visualQualityOf(
  visual: OmniVisualState | undefined,
  camera: CameraId,
): number {
  const shot = cameraVisualOf(visual, camera);
  if (!shot) {
    return DEFAULT_VISUAL_QUALITY;
  }
  return shot.usable ? 0.82 : 0.12;
}

function reactiveExpressionBoost(
  visual: OmniVisualState | undefined,
  speakerCamera: CameraId,
): number {
  const listener = speakerCamera === "A" ? "B" : "A";
  const expression = cameraVisualOf(visual, listener)?.expression;
  return isReactiveExpression(expression) ? 0.12 : 0;
}

function isReactiveExpression(expression: string | undefined): boolean {
  if (!expression) {
    return false;
  }
  return /surpris|smile|laugh|nod|react|shock|amuse|frown|think|listen|cry|wow|delight/i.test(
    expression,
  );
}
