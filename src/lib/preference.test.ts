import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { applyPauseKeepPolicy, computeKeepScore, decideVerdict } from "./decide";
import { resetPersist } from "./persist";
import {
  applyPreference,
  getChannelProfile,
  listHumanOverrides,
  preferenceKey,
  recordHumanOverride,
  saveChannelProfile,
} from "./preference";
import { mockSignals } from "./sample";
import {
  DEFAULT_CHANNEL_PROFILE,
  parseChannelProfile,
  type ChannelProfile,
  type JevSignals,
  type ScoredClip,
  type SemanticRole,
} from "./types";

function isolateDb(): void {
  resetPersist();
  process.env.CUTLINE_DB_PATH = path.join(
    mkdtempSync(path.join(os.tmpdir(), "cutline-pref-")),
    "cutline.db",
  );
}

function clip(extra: Partial<ScoredClip> & { id: string; role?: SemanticRole }): ScoredClip {
  const role = extra.role ?? "content";
  const unit = {
    id: extra.id,
    speaker: extra.speaker ?? "A",
    text: extra.text ?? extra.id,
    startMs: extra.startMs ?? 0,
    endMs: extra.endMs ?? 1000,
    role,
    pauseClass: extra.pauseClass,
  };
  const signals = extra.signals ?? mockSignals(unit);
  const keepScore = extra.keepScore ?? computeKeepScore(signals, "standard");
  const decided = extra.verdict
    ? {
        verdict: extra.verdict,
        autoMarker: extra.autoMarker ?? false,
      }
    : decideVerdict(signals, keepScore);
  return {
    ...unit,
    signals,
    keepScore,
    autoMarker: extra.autoMarker ?? decided.autoMarker,
    verdict: extra.verdict ?? decided.verdict,
    verdictSource: extra.verdictSource ?? "code",
    reason: extra.reason ?? role,
  };
}

function tangentSignals(): JevSignals {
  return {
    ...mockSignals({
      id: "t",
      speaker: "A",
      text: "余談ですが昨日の話で",
      startMs: 0,
      endMs: 2000,
      role: "content",
    }),
    tangent: 0.92,
    importance: 0.2,
    confidence: 0.96,
    reviewRequired: 0.05,
  };
}

describe("channel profile data", () => {
  it("defaults match spec examples", () => {
    assert.equal(DEFAULT_CHANNEL_PROFILE.rules["笑い"], "残す");
    assert.equal(DEFAULT_CHANNEL_PROFILE.rules["沈黙"], "短くする");
    assert.equal(DEFAULT_CHANNEL_PROFILE.rules["相槌"], "少し残す");
    assert.equal(DEFAULT_CHANNEL_PROFILE.rules["技術説明"], "ほぼ削らない");
    assert.equal(DEFAULT_CHANNEL_PROFILE.rules["脱線"], "積極削除");
  });

  it("parses partial JSON onto defaults", () => {
    const parsed = parseChannelProfile({
      rules: { 脱線: "残す", unknown: "x" },
    });
    assert.equal(parsed.rules["脱線"], "残す");
    assert.equal(parsed.rules["笑い"], "残す");
  });
});

describe("preference sqlite", () => {
  it("stores human CUT→KEEP by text / speaker / role", () => {
    isolateDb();
    recordHumanOverride({
      text: "  えー  ",
      speaker: "A",
      role: "filler",
      aiVerdict: "cut",
      humanVerdict: "keep",
    });
    const rows = listHumanOverrides();
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.unitText, "えー");
    assert.equal(rows[0]?.speaker, "A");
    assert.equal(rows[0]?.roleKey, "filler");
    assert.equal(rows[0]?.humanVerdict, "keep");
    assert.equal(
      rows[0]?.prefKey,
      preferenceKey({ text: "えー", speaker: "A", role: "filler" }),
    );
    recordHumanOverride({
      text: "えー",
      speaker: "A",
      role: "filler",
      aiVerdict: "cut",
      humanVerdict: "keep",
    });
    assert.equal(listHumanOverrides()[0]?.weight, 2);
    resetPersist();
  });

  it("persists channel profile JSON", () => {
    isolateDb();
    const saved = saveChannelProfile({
      ...DEFAULT_CHANNEL_PROFILE,
      name: "配信",
      rules: { ...DEFAULT_CHANNEL_PROFILE.rules, 相槌: "積極削除" },
    });
    assert.equal(saved.rules["相槌"], "積極削除");
    assert.equal(getChannelProfile().name, "配信");
    resetPersist();
  });
});

describe("applyPreference", () => {
  it("does not rewrite the keepScore formula", () => {
    const filler = mockSignals({
      id: "f",
      speaker: "A",
      text: "えー",
      startMs: 0,
      endMs: 700,
      role: "filler",
    });
    const formula = computeKeepScore(filler, "standard");
    const scored = clip({
      id: "f",
      text: "えー",
      role: "filler",
      signals: filler,
      keepScore: formula,
    });
    applyPreference(scored, {
      overrides: [],
      profile: DEFAULT_CHANNEL_PROFILE,
    });
    assert.equal(computeKeepScore(filler, "standard"), formula);
    assert.equal(scored.keepScore, formula);
  });

  it("biases later jobs after human CUT→KEEP", () => {
    const filler = mockSignals({
      id: "f",
      speaker: "A",
      text: "えー",
      startMs: 0,
      endMs: 700,
      role: "filler",
    });
    const baseScore = computeKeepScore(filler, "standard");
    const decided = decideVerdict(filler, baseScore);
    assert.equal(decided.verdict, "cut");
    const scored = clip({
      id: "f",
      text: "えー",
      role: "filler",
      signals: filler,
      keepScore: baseScore,
      verdict: decided.verdict,
    });
    const next = applyPreference(scored, {
      profile: DEFAULT_CHANNEL_PROFILE,
      overrides: [
        {
          prefKey: preferenceKey(scored),
          unitText: "えー",
          speaker: "A",
          roleKey: "filler",
          aiVerdict: "cut",
          humanVerdict: "keep",
          weight: 1,
          updatedAt: new Date().toISOString(),
        },
      ],
    });
    assert.equal(next.keepScore, scored.keepScore);
    assert.equal(next.verdict, "keep");
    assert.equal(next.verdictSource, "user");
  });

  it("keeps an exact remembered CUT and pause policy does not restore it", () => {
    const pause = clip({
      id: "gap",
      text: "",
      role: "pause",
      pauseClass: "long",
      keepScore: 0.8,
      verdict: "keep",
      signals: {
        ...mockSignals({
          id: "gap",
          speaker: "A",
          text: "",
          startMs: 0,
          endMs: 2000,
          role: "pause",
          pauseClass: "long",
        }),
        confidence: 0.96,
        reviewRequired: 0.04,
      },
    });
    const next = applyPreference(pause, {
      profile: DEFAULT_CHANNEL_PROFILE,
      overrides: [
        {
          prefKey: preferenceKey(pause),
          unitText: "",
          speaker: "A",
          roleKey: "pause",
          aiVerdict: "keep",
          humanVerdict: "cut",
          weight: 3,
          updatedAt: new Date().toISOString(),
        },
      ],
    });
    assert.equal(next.keepScore, pause.keepScore);
    assert.equal(next.verdict, "cut");
    assert.equal(next.verdictSource, "user");
    const restored = applyPauseKeepPolicy([next])[0];
    assert.equal(restored?.verdict, "cut");
    assert.equal(restored?.verdictSource, "user");
    assert.equal(restored?.keepScore, pause.keepScore);
  });

  it("cuts tangents when the channel says 積極削除", () => {
    const signals = tangentSignals();
    const baseScore = computeKeepScore(signals, "standard");
    const scored = clip({
      id: "tan",
      text: "余談ですが昨日の話で",
      role: "content",
      signals,
      keepScore: baseScore,
      verdict: "keep",
    });
    const next = applyPreference(scored, {
      overrides: [],
      profile: DEFAULT_CHANNEL_PROFILE,
    });
    assert.ok(next.keepScore < scored.keepScore);
    assert.equal(next.verdict, "cut");
  });

  it("keeps technical explanation when ほぼ削らない", () => {
    const signals = {
      ...mockSignals({
        id: "tech",
        speaker: "A",
        text: "知覚は Qwen、判断は Jev に分けています",
        startMs: 0,
        endMs: 3000,
        role: "content",
      }),
      tangent: 0.4,
      confidence: 0.96,
      reviewRequired: 0.04,
      importance: 0.35,
    };
    const lowScore = 0.3;
    const scored = clip({
      id: "tech",
      text: "知覚は Qwen、判断は Jev に分けています",
      role: "content",
      signals,
      keepScore: lowScore,
      verdict: "cut",
    });
    const next = applyPreference(scored, {
      overrides: [],
      profile: DEFAULT_CHANNEL_PROFILE,
    });
    assert.ok(next.keepScore > lowScore);
    assert.equal(next.verdict, "keep");
  });

  it("shortens long silence via channel profile data", () => {
    const profile: ChannelProfile = DEFAULT_CHANNEL_PROFILE;
    const pause = clip({
      id: "p",
      text: "",
      role: "pause",
      pauseClass: "long",
      keepScore: 0.5,
      verdict: "keep",
      signals: {
        ...mockSignals({
          id: "p",
          speaker: "A",
          text: "",
          startMs: 0,
          endMs: 2000,
          role: "pause",
          pauseClass: "long",
        }),
        confidence: 0.96,
        reviewRequired: 0.04,
      },
    });
    const next = applyPreference(pause, { overrides: [], profile });
    assert.ok(next.keepScore < pause.keepScore);
  });
});
