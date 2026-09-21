import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  assignCameras,
  cameraSignals,
  FATIGUE_MS,
  speakerCameraOf,
} from "./camera";
import type { JevSignals, OmniUnitState, OmniVisualState, ScoredClip } from "./types";

function signals(partial: Partial<JevSignals> = {}): JevSignals {
  return {
    importance: 0.8,
    novelty: 0.5,
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
  speaker: string,
  startMs: number,
  endMs: number,
  extra: Partial<ScoredClip> = {},
): ScoredClip {
  return {
    id,
    speaker,
    text: extra.text ?? id,
    startMs,
    endMs,
    role: extra.role ?? "content",
    signals: extra.signals ?? signals(),
    keepScore: extra.keepScore ?? 0.8,
    autoMarker: false,
    verdict: extra.verdict ?? "keep",
    verdictSource: extra.verdictSource ?? "code",
    reason: extra.reason ?? "content",
    omni: extra.omni,
  };
}

function omniVisual(partial: Partial<OmniVisualState> = {}): OmniUnitState {
  return {
    edit: {
      target: { id: "x", speaker: "A", text: "", start: 0, end: 1 },
      semantic: { role: "content", contains_new_information: true },
      conversation: { previous: "", next: "" },
      visual: { speaker_camera: "cam_a", listener_reaction: "none" },
    },
    visual: {
      speaker: "A",
      camera_a: { subject: "A", usable: true, expression: "neutral" },
      camera_b: { subject: "B", usable: true, expression: "neutral" },
      wide: { usable: true },
      listener_reaction: { strength: 0.12 },
      ...partial,
    },
  };
}

describe("assignCameras", () => {
  it("maps speaker A to CAM A without asking Jev to pick a camera", () => {
    const next = assignCameras([clip("a", "A", 0, 2000)]);
    assert.equal(speakerCameraOf("A"), "A");
    assert.equal(next[0]?.camera, "A");
    assert.equal(next[0]?.cameraReason, "speaker camera");
  });

  it("uses the listener camera for a strong backchannel", () => {
    const next = assignCameras([
      clip("a", "A", 0, 2000),
      clip("b", "B", 2000, 3200, {
        role: "backchannel",
        text: "へえ",
        signals: signals({ reactionValue: 0.87 }),
      }),
    ]);
    assert.equal(next[1]?.camera, "B");
  });

  it("inserts a wide reset after speaker-cam fatigue", () => {
    const longA = FATIGUE_MS + 500;
    const next = assignCameras([
      clip("a1", "A", 0, longA),
      clip("a2", "A", longA, longA + 2500),
    ]);
    assert.equal(next[1]?.camera, "WIDE");
  });

  it("avoids a same-camera jump cut after a removal", () => {
    const next = assignCameras([
      clip("keep1", "A", 0, 2000),
      clip("cut", "A", 2000, 5000, { verdict: "cut" }),
      clip("keep2", "A", 5000, 7500),
    ]);
    assert.notEqual(next[2]?.camera, "A");
    assert.ok(next[2]?.camera === "WIDE" || next[2]?.camera === "B" || next[2]?.punchIn);
  });

  it("falls back to morph when reaction/wide/other camera cannot cover a jump", () => {
    const next = assignCameras([
      clip("keep1", "A", 0, 2000),
      clip("cut", "A", 2000, 5000, { verdict: "cut" }),
      clip("keep2", "A", 5000, 5600),
    ]);
    assert.equal(next[2]?.camera, "A");
    assert.equal(next[2]?.punchIn, true);
    assert.equal(next[2]?.morph, true);
  });

  it("reads Omni Visual State strength and expression, not a Jev camera pick", () => {
    const next = assignCameras([
      clip("talk", "A", 0, 2500, {
        omni: omniVisual({
          camera_b: { subject: "B", usable: true, expression: "surprised" },
          listener_reaction: { strength: 0.87 },
        }),
      }),
    ]);
    assert.equal(next[0]?.camera, "B");
    assert.equal(next[0]?.cameraReason, "listener reaction");
    const observed = cameraSignals(next[0]!, undefined, 0, false);
    assert.ok(observed.listenerReactionValue >= 0.7);
    assert.ok(observed.visualQuality > 0.72);
    assert.equal(observed.speakerCamera, "A");
  });

  it("does not stay on an unusable speaker camera", () => {
    const next = assignCameras([
      clip("talk", "A", 0, 2500, {
        omni: omniVisual({
          camera_a: { subject: "A", usable: false, expression: "neutral" },
          wide: { usable: true },
        }),
      }),
    ]);
    assert.notEqual(next[0]?.camera, "A");
  });
});
