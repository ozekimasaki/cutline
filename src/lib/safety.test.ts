import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { applySemanticSafety, buildMeaningLinks } from "./safety";
import { runFinalQa } from "./qa";
import { buildEditUnits } from "./units";
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

function scored(
  unit: ReturnType<typeof buildEditUnits>[number],
  verdict: ScoredClip["verdict"],
): ScoredClip {
  return {
    ...unit,
    signals: signals(),
    keepScore: 0.5,
    autoMarker: false,
    verdict,
    verdictSource: "code",
    reason: unit.role,
  };
}

function clip(id: string, extra: Partial<ScoredClip> = {}): ScoredClip {
  return {
    id,
    speaker: extra.speaker ?? "A",
    text: extra.text ?? id,
    startMs: extra.startMs ?? 0,
    endMs: extra.endMs ?? 1000,
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

describe("semantic safety", () => {
  it("links a question to the following answer", () => {
    const units = buildEditUnits([
      { speaker: "B", text: "会社辞めようと思ったことあります？", startMs: 0, endMs: 2000 },
      { speaker: "A", text: "……あります。", startMs: 5000, endMs: 6200 },
    ]);
    const links = buildMeaningLinks(units);
    assert.equal(links.some((link) => link.type === "question_answer"), true);
  });

  it("does not leave an answer without its question", () => {
    const units = buildEditUnits([
      { speaker: "B", text: "会社辞めようと思ったことあります？", startMs: 0, endMs: 2000 },
      { speaker: "A", text: "……あります。", startMs: 5000, endMs: 6200 },
    ]);
    const clips = units.map((unit) =>
      scored(unit, unit.role === "content" && unit.text.includes("あります？") ? "cut" : "keep"),
    );
    const next = applySemanticSafety(clips, buildMeaningLinks(units), "standard");
    const question = next.find((clip) => clip.text.includes("あります？"));
    assert.equal(question?.verdict, "review");
  });

  it("keeps a long pause between question and answer", () => {
    const units = buildEditUnits([
      { speaker: "B", text: "会社辞めようと思ったことあります？", startMs: 0, endMs: 2000 },
      { speaker: "A", text: "……あります。", startMs: 5000, endMs: 6200 },
    ]);
    const clips = units.map((unit) =>
      scored(unit, unit.role === "pause" ? "cut" : "keep"),
    );
    const next = applySemanticSafety(clips, buildMeaningLinks(units), "standard");
    const pause = next.find((clip) => clip.role === "pause");
    assert.equal(pause?.verdict, "keep");
  });

  it("flags a meaning reversal in final QA", () => {
    const qa = runFinalQa([
      scored(
        {
          id: "eu_1",
          speaker: "A",
          text: "これはダメだと思った",
          startMs: 0,
          endMs: 2000,
          role: "content",
        },
        "keep",
      ),
    ]);
    assert.equal(qa.meaningRisks.length > 0, true);
    assert.equal(qa.keepCount, 1);
    assert.equal(qa.averageShotLengthMs, 2000);
    assert.equal(qa.jumpCutCount, 0);
  });

  it("counts punch-in as a jump cut metric", () => {
    const qa = runFinalQa([
      {
        id: "a",
        speaker: "A",
        text: "今日は",
        startMs: 0,
        endMs: 2000,
        role: "content",
        signals: signals(),
        keepScore: 0.8,
        autoMarker: false,
        verdict: "keep",
        verdictSource: "code",
        reason: "content",
        camera: "A",
      },
      {
        id: "b",
        speaker: "A",
        text: "続き",
        startMs: 4000,
        endMs: 5000,
        role: "content",
        signals: signals(),
        keepScore: 0.8,
        autoMarker: false,
        verdict: "keep",
        verdictSource: "code",
        reason: "content",
        camera: "A",
        punchIn: true,
        cameraReason: "jump cut を punch-in で隠す",
      },
    ]);
    assert.equal(qa.jumpCutCount, 1);
    assert.equal(qa.keepCount, 2);
    assert.equal(qa.averageShotLengthMs, 1500);
  });

  it("constructs setup_punchline from setup to punchline", () => {
    const units = buildEditUnits([
      { speaker: "A", text: "これはダメだと思ったんですけど", startMs: 0, endMs: 2000 },
      { speaker: "A", text: "実際使ったらすごく良かった。", startMs: 2100, endMs: 4000 },
    ]);
    const links = buildMeaningLinks(units);
    const setup = units.find((unit) => unit.text.includes("ダメ"));
    const punchline = units.find((unit) => unit.text.includes("良かった"));
    assert.ok(setup);
    assert.ok(punchline);
    assert.equal(
      links.some(
        (link) =>
          link.type === "setup_punchline" &&
          link.fromId === setup?.id &&
          link.toId === punchline?.id,
      ),
      true,
    );
  });

  it("constructs claim_reason from claim to reason", () => {
    const units = buildEditUnits([
      { speaker: "A", text: "この機能は残すべきだと思います。", startMs: 0, endMs: 2000 },
      { speaker: "A", text: "なぜなら視聴者が迷うからです。", startMs: 2100, endMs: 4500 },
    ]);
    const links = buildMeaningLinks(units);
    const claim = units.find((unit) => unit.text.includes("残すべき"));
    const reason = units.find((unit) => unit.text.includes("なぜなら"));
    assert.ok(claim);
    assert.ok(reason);
    assert.equal(
      links.some(
        (link) =>
          link.type === "claim_reason" &&
          link.fromId === claim?.id &&
          link.toId === reason?.id,
      ),
      true,
    );
  });

  it("re-scores children when a parent is deleted instead of only flipping CUT/REVIEW", () => {
    const parent = clip("claim", {
      text: "この機能は残すべきだと思います。",
      verdict: "cut",
      keepScore: 0.2,
    });
    const child = clip("reason", {
      text: "なぜなら視聴者が迷うからです。",
      startMs: 2000,
      endMs: 4000,
      verdict: "keep",
      keepScore: 0.9,
      signals: signals({ importance: 0.95, confidence: 0.97 }),
    });
    const next = applySemanticSafety(
      [parent, child],
      [{ type: "claim_reason", fromId: parent.id, toId: child.id }],
      "standard",
    );
    const reason = next.find((item) => item.id === "reason");
    assert.ok(reason);
    assert.notEqual(reason?.keepScore, 0.9);
    assert.match(reason?.reason ?? "", /親削除のため再評価/);
    assert.notEqual(reason?.verdict, "cut");
  });

  it("walks grandchildren after a re-scored child is cut", () => {
    const parent = clip("setup", {
      text: "ダメだと思ったんですけど",
      verdict: "cut",
      keepScore: 0.1,
    });
    const child = clip("punchline", {
      text: "実際使ったらすごく良かった。",
      startMs: 2000,
      endMs: 3500,
      verdict: "keep",
      keepScore: 0.88,
      signals: signals({
        importance: 0.04,
        filler: 0.96,
        falseStart: 0.02,
        tangent: 0.02,
        confidence: 0.97,
      }),
    });
    const grandchild = clip("follow", {
      text: "だから残しています。",
      startMs: 3600,
      endMs: 5000,
      verdict: "keep",
      keepScore: 0.77,
      signals: signals({
        importance: 0.04,
        filler: 0.96,
        falseStart: 0.02,
        tangent: 0.02,
        confidence: 0.97,
      }),
    });
    const next = applySemanticSafety(
      [parent, child, grandchild],
      [
        { type: "setup_punchline", fromId: parent.id, toId: child.id },
        { type: "claim_reason", fromId: child.id, toId: grandchild.id },
      ],
      "standard",
    );
    assert.equal(next.find((item) => item.id === "punchline")?.verdict, "cut");
    const follow = next.find((item) => item.id === "follow");
    assert.equal(follow?.verdict, "cut");
    assert.notEqual(follow?.keepScore, 0.77);
    assert.match(follow?.reason ?? "", /親削除のため再評価/);
  });

  it("keeps an unsure orphan instead of auto-cutting it", () => {
    const parent = clip("claim", {
      text: "この機能は残すべきだと思います。",
      verdict: "cut",
    });
    const child = clip("reason", {
      text: "なぜなら視聴者が迷うからです。",
      startMs: 2000,
      endMs: 4000,
      verdict: "keep",
      keepScore: 0.2,
      signals: signals({
        importance: 0.04,
        filler: 0.96,
        falseStart: 0.02,
        tangent: 0.02,
        confidence: 0.85,
      }),
    });
    const next = applySemanticSafety(
      [parent, child],
      [{ type: "claim_reason", fromId: parent.id, toId: child.id }],
      "standard",
    );
    assert.equal(next.find((item) => item.id === "reason")?.verdict, "review");
  });

  it("does not overwrite a user verdict on a child", () => {
    const parent = clip("claim", { verdict: "cut" });
    const child = clip("reason", {
      verdict: "keep",
      verdictSource: "user",
      keepScore: 0.91,
      reason: "human",
    });
    const next = applySemanticSafety(
      [parent, child],
      [{ type: "claim_reason", fromId: parent.id, toId: child.id }],
      "standard",
    );
    const reason = next.find((item) => item.id === "reason");
    assert.equal(reason?.verdict, "keep");
    assert.equal(reason?.verdictSource, "user");
    assert.equal(reason?.keepScore, 0.91);
    assert.equal(reason?.reason, "human");
  });
});
