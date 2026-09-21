import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { computeKeepScore, decideVerdict, packToTargetDuration } from "./decide";
import {
  buildEditedTranscript,
  editedLinesFromClips,
  evaluateEditedUnit,
  mergeStageTwoVerdict,
  mockReviewEditedTranscript,
  mockSignalsForEditedContext,
  relinkEditedClips,
  runEditedTranscriptRebuild,
} from "./transcript";
import { mockSignals } from "./sample";
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
    omni: extra.omni,
  };
}

describe("edited transcript rebuild", () => {
  it("drops CUT lines and keeps speaker ids past A/B", () => {
    const lines = editedLinesFromClips([
      clip("keep-a", 0, 1000, { speaker: "A", text: "今年の2月から始めました" }),
      clip("cut-b", 1000, 1600, {
        speaker: "B",
        text: "えー",
        verdict: "cut",
        role: "filler",
      }),
      clip("keep-c", 1600, 2800, {
        speaker: "C",
        text: "判断は Jev です",
      }),
    ]);
    assert.deepEqual(
      lines.map((line) => line.speaker),
      ["A", "C"],
    );
    assert.equal(lines[1]?.previous, "今年の2月から始めました");
    assert.equal(lines[0]?.next, "判断は Jev です");
  });

  it("relinks previous/next to the edited neighbors", () => {
    const relinked = relinkEditedClips([
      clip("a", 0, 800, { text: "えー", verdict: "cut", next: "去年" }),
      clip("b", 800, 1600, {
        text: "今年の2月から始めました",
        previous: "えー",
        next: "いや去年じゃないですね",
      }),
      clip("c", 1600, 2400, {
        text: "いや去年じゃないですね",
        verdict: "cut",
        previous: "今年の2月から始めました",
      }),
      clip("d", 2400, 4000, {
        text: "役割は分けています",
        previous: "いや去年じゃないですね",
      }),
    ]);
    const kept = relinked.filter((item) => item.verdict !== "cut");
    assert.equal(kept[0]?.previous, undefined);
    assert.equal(kept[0]?.next, "役割は分けています");
    assert.equal(kept[1]?.previous, "今年の2月から始めました");
  });

  it("keeps Omni Edit/Visual State on clips through stage two", async () => {
    const omni = {
      edit: {
        target: {
          id: "keep-omni",
          speaker: "A",
          text: "今年の2月から始めました",
          start: 0,
          end: 2,
        },
        semantic: {
          role: "content" as const,
          contains_new_information: true,
        },
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
    };
    const result = await runEditedTranscriptRebuild({
      clips: [
        clip("keep-omni", 0, 2000, {
          text: "今年の2月から始めました",
          omni,
        }),
      ],
      profile: "standard",
    });
    assert.equal(result.clips[0]?.omni?.edit.visual.speaker_camera, "cam_a");
    assert.equal(result.clips[0]?.omni?.visual.listener_reaction.strength, 0.2);
  });

  it("cuts a duplicate after the first pass with mock context", async () => {
    const result = await runEditedTranscriptRebuild({
      clips: [
        clip("first", 0, 2000, {
          text: "今年の2月から始めました",
          keepScore: 0.8,
        }),
        clip("again", 4000, 6000, {
          text: "今年の2月から始めました",
          keepScore: 0.8,
        }),
      ],
      profile: "standard",
    });
    const again = result.clips.find((item) => item.id === "again");
    assert.equal(again?.verdict, "cut");
    assert.equal(again?.reason, "stage2_context");
    assert.equal(result.editedTranscript.lines.length, 1);
    assert.equal(result.editedTranscript.source, "mock");
    assert.equal(result.editedTranscript.rescoreCount, 2);
  });

  it("does not auto-cut a REVIEW clip in stage two", async () => {
    const result = await runEditedTranscriptRebuild({
      clips: [
        clip("q", 0, 1500, {
          speaker: "B",
          text: "会社辞めようと思ったことあります？",
        }),
        clip("dup", 2000, 3500, {
          text: "会社辞めようと思ったことあります？",
          verdict: "review",
        }),
      ],
      profile: "standard",
    });
    assert.equal(result.clips.find((item) => item.id === "dup")?.verdict, "review");
  });

  it("keeps a low-confidence stage-two cut", () => {
    const stage1 = clip("soft", 0, 1000, {
      text: "なるほど",
      verdict: "keep",
    });
    const weak = signals({
      importance: 0.1,
      redundancy: 0.9,
      removalNatural: 0.9,
      confidence: 0.5,
    });
    const keepScore = computeKeepScore(weak, "standard");
    const decide = decideVerdict(weak, keepScore);
    const merged = mergeStageTwoVerdict(stage1, weak, {
      keepScore,
      verdict: "cut",
      autoMarker: decide.autoMarker,
    });
    assert.equal(merged.verdict, "keep");
  });

  it("protects an answer that follows a kept question", async () => {
    const result = await runEditedTranscriptRebuild({
      clips: [
        clip("q", 0, 2000, {
          speaker: "B",
          text: "会社辞めようと思ったことあります？",
        }),
        clip("a", 5000, 7000, {
          speaker: "A",
          text: "……あります。",
        }),
      ],
      profile: "standard",
    });
    const answer = result.clips.find((item) => item.id === "a");
    assert.equal(answer?.verdict, "keep");
    assert.ok((answer?.signals.contextRequired ?? 0) >= 0.88);
  });

  it("uses mock Omni review when keys are missing", async () => {
    delete process.env.DASHSCOPE_API_KEY;
    delete process.env.AI_GATEWAY_API_KEY;
    delete process.env.CLOUDFLARE_API_TOKEN;
    const result = await runEditedTranscriptRebuild({
      clips: [
        clip("only-q", 0, 2000, {
          speaker: "B",
          text: "会社辞めようと思ったことあります？",
        }),
      ],
      profile: "standard",
    });
    assert.equal(result.editedTranscript.source, "mock");
    assert.equal(result.clips[0]?.verdict, "review");
    assert.match(result.notes.join("\n"), /モック/);
  });

  it("lets an injected Omni review mark REVIEW without cutting", async () => {
    const result = await runEditedTranscriptRebuild({
      clips: [
        clip("keep-me", 0, 1800, { text: "今年の2月から始めました" }),
        clip("flag-me", 2000, 3600, { text: "それは別の話です" }),
      ],
      profile: "standard",
      reviewConversation: async () => ({
        source: "live",
        conversationMakesSense: false,
        reviewClipIds: ["flag-me"],
        notes: ["指示語を確認"],
      }),
    });
    assert.equal(result.clips.find((item) => item.id === "flag-me")?.verdict, "review");
    assert.equal(result.clips.find((item) => item.id === "keep-me")?.verdict, "keep");
    assert.equal(result.editedTranscript.source, "live");
  });

  it("keeps duration packing after stage two", async () => {
    const rebuilt = await runEditedTranscriptRebuild({
      clips: [
        clip("a", 0, 4000, {
          text: "重要な説明をしています",
          keepScore: 0.9,
          signals: signals({ importance: 0.9, confidence: 0.96 }),
        }),
        clip("b", 4000, 8000, {
          text: "脱線しています",
          keepScore: 0.2,
          verdict: "review",
          signals: signals({
            importance: 0.1,
            tangent: 0.9,
            confidence: 0.7,
            reviewRequired: 0.6,
          }),
        }),
      ],
      profile: "short",
    });
    const packed = packToTargetDuration(rebuilt.clips, 4000);
    const keptMs = packed
      .filter((item) => item.verdict === "keep")
      .reduce((sum, item) => sum + (item.endMs - item.startMs), 0);
    assert.ok(keptMs <= 4000);
  });

  it("builds a document from current clips without a second Jev pass", () => {
    const document = buildEditedTranscript(
      [
        clip("keep", 0, 1000, { speaker: "B", text: "へえ" }),
        clip("gone", 1000, 1600, { verdict: "cut", text: "えーっと" }),
      ],
      { source: "live", rescoreCount: 4 },
    );
    assert.equal(document.lines.length, 1);
    assert.equal(document.lines[0]?.speaker, "B");
    assert.equal(document.source, "live");
    assert.equal(document.rescoreCount, 4);
  });
});

describe("mockSignalsForEditedContext", () => {
  it("raises redundancy when the previous kept line repeats", () => {
    const repeated = mockSignalsForEditedContext({
      id: "dup",
      speaker: "A",
      text: "今年の2月から始めました",
      startMs: 4000,
      endMs: 6000,
      role: "content",
      previous: "今年の2月から始めました",
    });
    const fresh = mockSignals({
      id: "dup",
      speaker: "A",
      text: "今年の2月から始めました",
      startMs: 4000,
      endMs: 6000,
      role: "content",
    });
    assert.ok(repeated.redundancy > fresh.redundancy);
  });
});

describe("mockReviewEditedTranscript", () => {
  it("flags a question with no following line", () => {
    const review = mockReviewEditedTranscript([
      {
        clipId: "q",
        speaker: "B",
        text: "会社辞めようと思ったことあります？",
        startMs: 0,
        endMs: 2000,
      },
    ]);
    assert.equal(review.source, "mock");
    assert.deepEqual(review.reviewClipIds, ["q"]);
    assert.equal(review.conversationMakesSense, false);
  });
});

describe("evaluateEditedUnit", () => {
  it("returns mock signals when Jev keys are missing", async () => {
    delete process.env.AI_GATEWAY_API_KEY;
    delete process.env.VERCEL_OIDC_TOKEN;
    delete process.env.CLOUDFLARE_API_TOKEN;
    const signalsOut = await evaluateEditedUnit({
      id: "u",
      speaker: "A",
      text: "えー",
      startMs: 0,
      endMs: 400,
      role: "filler",
    });
    assert.equal(signalsOut.provider, "mock");
    assert.ok(signalsOut.filler > 0.8);
  });
});
