import { decideVerdict } from "./decide";
import { openPersist } from "./persist";
import {
  CHANNEL_RULE_KEYS,
  DEFAULT_CHANNEL_PROFILE,
  parseChannelProfile,
  type ChannelProfile,
  type ChannelRuleKey,
  type ChannelRulePolicy,
  type ScoredClip,
  type SemanticRole,
  type Verdict,
} from "./types";

export type HumanVerdict = "keep" | "cut";

export type PreferenceOverride = {
  prefKey: string;
  unitText: string;
  speaker: string;
  roleKey: SemanticRole;
  aiVerdict: Verdict;
  humanVerdict: HumanVerdict;
  weight: number;
  updatedAt: string;
};

export type PreferenceContext = {
  overrides: PreferenceOverride[];
  profile: ChannelProfile;
};

const ACTIVE_PROFILE_META = "active_channel_profile";
const TECHNICAL_RE =
  /Qwen|Jev|keepScore|FFmpeg|ASR|Omni|API|TypeScript|実装|モデル|推論|エンコード|プロトコル|レイテンシ/;
const LAUGHTER_RE = /笑|ｗ{2,}|w{3,}|ははは|ふふ|うける|爆笑/i;

export {
  CHANNEL_POLICIES,
  CHANNEL_RULE_KEYS,
  DEFAULT_CHANNEL_PROFILE,
  parseChannelPolicy,
  parseChannelProfile,
} from "./types";

export function preferenceKey(input: {
  text: string;
  speaker: string;
  role: string;
}): string {
  return JSON.stringify([
    normalizeText(input.text),
    input.speaker,
    input.role,
  ]);
}

export function recordHumanOverride(input: {
  text: string;
  speaker: string;
  role: SemanticRole;
  aiVerdict: Verdict;
  humanVerdict: HumanVerdict;
}): PreferenceOverride {
  const prefKey = preferenceKey({
    text: input.text,
    speaker: input.speaker,
    role: input.role,
  });
  const existing = openPersist()
    .prepare(
      "SELECT weight FROM preference_overrides WHERE pref_key = ?",
    )
    .get(prefKey) as { weight: number } | undefined;
  const row: PreferenceOverride = {
    prefKey,
    unitText: normalizeText(input.text),
    speaker: input.speaker,
    roleKey: input.role,
    aiVerdict: input.aiVerdict,
    humanVerdict: input.humanVerdict,
    weight: (existing?.weight ?? 0) + 1,
    updatedAt: new Date().toISOString(),
  };
  openPersist()
    .prepare(
      `INSERT OR REPLACE INTO preference_overrides
        (pref_key, unit_text, speaker, role_key, ai_verdict, human_verdict, weight, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      row.prefKey,
      row.unitText,
      row.speaker,
      row.roleKey,
      row.aiVerdict,
      row.humanVerdict,
      row.weight,
      row.updatedAt,
    );
  return row;
}

export function listHumanOverrides(): PreferenceOverride[] {
  const rows = openPersist()
    .prepare(
      `SELECT pref_key, unit_text, speaker, role_key, ai_verdict, human_verdict, weight, updated_at
       FROM preference_overrides
       ORDER BY updated_at DESC`,
    )
    .all() as Array<{
    pref_key: string;
    unit_text: string;
    speaker: string;
    role_key: string;
    ai_verdict: string;
    human_verdict: string;
    weight: number;
    updated_at: string;
  }>;
  return rows.flatMap((row) => {
    const roleKey = parseRole(row.role_key);
    const humanVerdict = parseHumanVerdict(row.human_verdict);
    const aiVerdict = parseStoredVerdict(row.ai_verdict);
    if (!roleKey || !humanVerdict || !aiVerdict) {
      return [];
    }
    return [
      {
        prefKey: row.pref_key,
        unitText: row.unit_text,
        speaker: row.speaker,
        roleKey,
        aiVerdict,
        humanVerdict,
        weight: row.weight,
        updatedAt: row.updated_at,
      },
    ];
  });
}

export function saveChannelProfile(profile: ChannelProfile): ChannelProfile {
  const parsed = parseChannelProfile(profile);
  const updatedAt = new Date().toISOString();
  const db = openPersist();
  db.prepare(
    "INSERT OR REPLACE INTO channel_profiles (id, json, updated_at) VALUES (?, ?, ?)",
  ).run(parsed.id, JSON.stringify(parsed), updatedAt);
  db.prepare(
    "INSERT OR REPLACE INTO preference_meta (key, value) VALUES (?, ?)",
  ).run(ACTIVE_PROFILE_META, parsed.id);
  return parsed;
}

export function getChannelProfile(): ChannelProfile {
  const db = openPersist();
  const active = db
    .prepare("SELECT value FROM preference_meta WHERE key = ?")
    .get(ACTIVE_PROFILE_META) as { value: string } | undefined;
  const id = active?.value ?? DEFAULT_CHANNEL_PROFILE.id;
  const row = db
    .prepare("SELECT json FROM channel_profiles WHERE id = ?")
    .get(id) as { json: string } | undefined;
  if (!row) {
    return saveChannelProfile(DEFAULT_CHANNEL_PROFILE);
  }
  try {
    return parseChannelProfile(JSON.parse(row.json));
  } catch {
    return DEFAULT_CHANNEL_PROFILE;
  }
}

export function loadPreferenceContext(): PreferenceContext {
  return {
    overrides: listHumanOverrides(),
    profile: getChannelProfile(),
  };
}

export function applyPreference(
  clip: ScoredClip,
  context: PreferenceContext = loadPreferenceContext(),
): ScoredClip {
  const exact = exactOverride(clip, context.overrides);
  if (exact) {
    if (clip.verdict === exact.humanVerdict && clip.verdictSource === "user") {
      return clip;
    }
    return {
      ...clip,
      verdict: exact.humanVerdict,
      verdictSource: "user",
    };
  }
  const delta =
    channelDelta(clip, context.profile) + overrideDelta(clip, context.overrides);
  if (delta === 0) {
    return clip;
  }
  const keepScore = clamp01(clip.keepScore + delta);
  const decision = decideVerdict(clip.signals, keepScore);
  if (keepScore === clip.keepScore && decision.verdict === clip.verdict) {
    return clip;
  }
  return {
    ...clip,
    keepScore,
    verdict: decision.verdict,
    autoMarker: decision.autoMarker,
    reason: `${clip.reason}（preference）`,
  };
}

function exactOverride(
  clip: ScoredClip,
  overrides: PreferenceOverride[],
): PreferenceOverride | undefined {
  const key = preferenceKey(clip);
  return overrides.find((item) => item.prefKey === key);
}

function overrideDelta(
  clip: ScoredClip,
  overrides: PreferenceOverride[],
): number {
  if (overrides.length === 0) {
    return 0;
  }
  const roleRows = overrides.filter((item) => item.roleKey === clip.role);
  if (roleRows.length === 0) {
    return 0;
  }
  let keepWeight = 0;
  let cutWeight = 0;
  for (const row of roleRows) {
    switch (row.humanVerdict) {
      case "keep":
        keepWeight += row.weight;
        break;
      case "cut":
        cutWeight += row.weight;
        break;
      default: {
        const _never: never = row.humanVerdict;
        return _never;
      }
    }
  }
  const total = keepWeight + cutWeight;
  if (total === 0) {
    return 0;
  }
  return ((keepWeight - cutWeight) / total) * 0.1;
}

function channelDelta(clip: ScoredClip, profile: ChannelProfile): number {
  let delta = 0;
  for (const key of CHANNEL_RULE_KEYS) {
    if (!matchesRule(clip, key)) {
      continue;
    }
    delta += policyDelta(profile.rules[key]);
    if (
      key === "沈黙" &&
      profile.rules[key] === "短くする" &&
      (clip.pauseClass === "long" || clip.pauseClass === "thinking")
    ) {
      delta -= 0.06;
    }
  }
  return delta;
}

function matchesRule(clip: ScoredClip, key: ChannelRuleKey): boolean {
  switch (key) {
    case "笑い":
      return LAUGHTER_RE.test(clip.text);
    case "沈黙":
      return clip.role === "pause";
    case "相槌":
      return clip.role === "backchannel";
    case "技術説明":
      return clip.role === "content" && TECHNICAL_RE.test(clip.text);
    case "脱線":
      return clip.signals.tangent >= 0.5;
    default: {
      const _never: never = key;
      return _never;
    }
  }
}

function policyDelta(policy: ChannelRulePolicy): number {
  switch (policy) {
    case "残す":
      return 0.16;
    case "短くする":
      return -0.12;
    case "少し残す":
      return 0.07;
    case "ほぼ削らない":
      return 0.24;
    case "積極削除":
      return -0.24;
    default: {
      const _never: never = policy;
      return _never;
    }
  }
}

function normalizeText(text: string): string {
  return text.normalize("NFKC").replace(/\s+/g, " ").trim();
}

function parseRole(value: string): SemanticRole | undefined {
  switch (value) {
    case "content":
    case "filler":
    case "false_start":
    case "self_correction":
    case "pause":
    case "backchannel":
      return value;
    default:
      return undefined;
  }
}

function parseHumanVerdict(value: string): HumanVerdict | undefined {
  switch (value) {
    case "keep":
    case "cut":
      return value;
    default:
      return undefined;
  }
}

function parseStoredVerdict(value: string): Verdict | undefined {
  switch (value) {
    case "keep":
    case "cut":
    case "review":
      return value;
    default:
      return undefined;
  }
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}
