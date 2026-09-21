import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  applyPauseKeepPolicy,
  classifyPause,
  computeKeepScore,
  decideVerdict,
  packToTargetDuration,
  pauseKeepPolicy,
  verdictLabel,
} from "./decide";
import type { JevSignals, OmniPauseLabel, OmniUnitState, ScoredClip } from "./types";

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
    omni: extra.omni,
  };
}

function pauseOmni(pauseLabel: OmniPauseLabel): OmniUnitState {
  return {
    edit: {
      target: { id: "p", speaker: "A", text: "", start: 0, end: 3 },
      semantic: { role: "pause", contains_new_information: false },
      conversation: { previous: "", next: "" },
      visual: { speaker_camera: "cam_a", listener_reaction: "none" },
    },
    visual: {
      speaker: "A",
      camera_a: { usable: true, expression: "neutral" },
      camera_b: { usable: true, expression: "neutral" },
      wide: { usable: true },
      listener_reaction: { strength: 0.2 },
    },
    pauseLabel,
  };
}

describe("computeKeepScore", () => {
  it("penalizes filler and false starts", () => {
    const content = computeKeepScore(signals({ importance: 0.9, filler: 0.02 }), "standard");
    const filler = computeKeepScore(
      signals({ importance: 0.04, filler: 0.96, falseStart: 0.02 }),
      "standard",
    );
    assert.ok(content > filler);
  });

  it("tight profile cuts filler harder than natural", () => {
    const filler = signals({ filler: 0.9, humanTexture: 0.4, importance: 0.2 });
    assert.ok(computeKeepScore(filler, "natural") > computeKeepScore(filler, "tight"));
  });
});

describe("decideVerdict", () => {
  it("keeps high-confidence high-score clips", () => {
    const sig = signals({ confidence: 0.97, importance: 0.9, filler: 0.02 });
    const decided = decideVerdict(sig, computeKeepScore(sig, "standard"));
    assert.equal(decided.verdict, "keep");
    assert.equal(decided.autoMarker, false);
  });

  it("cuts high-confidence low-score clips", () => {
    const sig = signals({
      confidence: 0.97,
      importance: 0.04,
      filler: 0.96,
      falseStart: 0.02,
      tangent: 0.02,
    });
    const decided = decideVerdict(sig, computeKeepScore(sig, "tight"));
    assert.equal(decided.verdict, "cut");
  });

  it("keeps when confidence is below 0.60", () => {
    const decided = decideVerdict(signals({ confidence: 0.4, filler: 0.99 }), 0.05);
    assert.equal(decided.verdict, "keep");
  });

  it("sends 0.60–0.80 confidence to review", () => {
    const decided = decideVerdict(signals({ confidence: 0.7, importance: 0.9 }), 0.8);
    assert.equal(decided.verdict, "review");
  });

  it("honors reviewRequired", () => {
    const decided = decideVerdict(
      signals({ reviewRequired: 0.8, confidence: 0.99, importance: 0.9 }),
      0.9,
    );
    assert.equal(decided.verdict, "review");
  });
});

describe("packToTargetDuration", () => {
  it("demotes extra keeps to review when over length", () => {
    const clips = [
      clip("a", 0, 4000, { keepScore: 0.9 }),
      clip("b", 4000, 8000, { keepScore: 0.5 }),
      clip("c", 8000, 12000, { keepScore: 0.4 }),
    ];
    const packed = packToTargetDuration(clips, 5000);
    assert.deepEqual(
      packed.filter((item) => item.verdict === "keep").map((item) => item.id),
      ["a"],
    );
    assert.equal(packed.find((item) => item.id === "b")?.verdict, "review");
  });
});

describe("classifyPause", () => {
  it("buckets pause length", () => {
    assert.equal(classifyPause(120), "micro");
    assert.equal(classifyPause(400), "normal");
    assert.equal(classifyPause(1200), "thinking");
    assert.equal(classifyPause(1800), "long");
  });
});

describe("pauseKeepPolicy", () => {
  it("keeps dramatic and thinking texture and may compress awkward/technical", () => {
    assert.equal(pauseKeepPolicy("dramatic_pause", "long"), "keep");
    assert.equal(pauseKeepPolicy("thinking_pause", "normal"), "keep");
    assert.equal(pauseKeepPolicy("awkward_pause", "long"), "compress");
    assert.equal(pauseKeepPolicy("technical_pause", "thinking"), "compress");
  });

  it("keeps unlabeled thinking/long pauses (迷ったら残す)", () => {
    assert.equal(pauseKeepPolicy(undefined, "thinking"), "keep");
    assert.equal(pauseKeepPolicy(undefined, "long", 1800), "keep");
    assert.equal(pauseKeepPolicy(undefined, "micro"), "compress");
    assert.equal(pauseKeepPolicy(undefined, "normal"), "compress");
  });
});

describe("applyPauseKeepPolicy", () => {
  it("promotes a dramatic pause to KEEP instead of packing it away", () => {
    const next = applyPauseKeepPolicy([
      clip("pause", 0, 3000, {
        role: "pause",
        pauseClass: "long",
        keepScore: 0.12,
        verdict: "cut",
        omni: pauseOmni("dramatic_pause"),
      }),
    ]);
    assert.equal(next[0]?.verdict, "keep");
    assert.ok((next[0]?.keepScore ?? 0) >= 0.55);
    assert.match(next[0]?.reason ?? "", /間の質感として残す/);
  });

  it("lowers keepScore for awkward/technical but does not auto-cut", () => {
    const next = applyPauseKeepPolicy([
      clip("pause", 0, 3000, {
        role: "pause",
        pauseClass: "long",
        keepScore: 0.8,
        verdict: "keep",
        omni: pauseOmni("awkward_pause"),
      }),
    ]);
    assert.equal(next[0]?.verdict, "keep");
    assert.ok((next[0]?.keepScore ?? 1) <= 0.32);
  });

  it("does not overwrite a user verdict", () => {
    const next = applyPauseKeepPolicy([
      clip("pause", 0, 3000, {
        role: "pause",
        pauseClass: "long",
        keepScore: 0.1,
        verdict: "cut",
        verdictSource: "user",
        omni: pauseOmni("dramatic_pause"),
      }),
    ]);
    assert.equal(next[0]?.verdict, "cut");
    assert.equal(next[0]?.keepScore, 0.1);
  });
});

describe("packToTargetDuration pause labels", () => {
  it("keeps a dramatic pause and may drop an awkward pause when over length", () => {
    const packed = packToTargetDuration(
      [
        clip("talk", 0, 4000, { keepScore: 0.95 }),
        clip("dramatic", 4000, 7000, {
          role: "pause",
          pauseClass: "long",
          keepScore: 0.2,
          verdict: "cut",
          omni: pauseOmni("dramatic_pause"),
        }),
        clip("awkward", 7000, 10_000, {
          role: "pause",
          pauseClass: "long",
          keepScore: 0.8,
          omni: pauseOmni("awkward_pause"),
        }),
      ],
      7000,
    );
    assert.equal(packed.find((item) => item.id === "dramatic")?.verdict, "keep");
    assert.equal(packed.find((item) => item.id === "awkward")?.verdict, "review");
  });
});

describe("verdictLabel", () => {
  it("uses KEEP/CUT/REVIEW", () => {
    assert.equal(verdictLabel("keep"), "KEEP");
    assert.equal(verdictLabel("cut"), "CUT");
    assert.equal(verdictLabel("review"), "REVIEW");
  });
});
