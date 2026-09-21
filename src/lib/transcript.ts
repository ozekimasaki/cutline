import { computeKeepScore, decideVerdict } from "./decide";
import { jevEnv, omniModelId, qwenEnv } from "./env";
import { evaluateUnit } from "./jev";
import { asBoolean, asString, extractJsonObject } from "./json";
import { mockSignals } from "./sample";
import type {
  EditProfile,
  EditUnit,
  EditedTranscript,
  EditedTranscriptLine,
  JevSignals,
  ScoredClip,
  Verdict,
} from "./types";

const STAGE2_CUT_CONFIDENCE = 0.8;
const STAGE2_KEEP_UPGRADE_CONFIDENCE = 0.95;

export type EditedTranscriptReview = {
  source: "live" | "mock";
  conversationMakesSense: boolean;
  reviewClipIds: string[];
  notes: string[];
};

export type StageTwoDecide = {
  keepScore: number;
  verdict: Verdict;
  autoMarker: boolean;
};

export async function runEditedTranscriptRebuild(input: {
  clips: ScoredClip[];
  profile: EditProfile;
  evaluateUnit?: (unit: EditUnit) => Promise<JevSignals>;
  reviewConversation?: (
    lines: EditedTranscriptLine[],
  ) => Promise<EditedTranscriptReview>;
}): Promise<{
  clips: ScoredClip[];
  editedTranscript: EditedTranscript;
  notes: string[];
}> {
  const relinked = relinkEditedClips(input.clips);
  const toRescore = relinked.filter((clip) => clip.verdict !== "cut");
  const evaluate = input.evaluateUnit ?? evaluateEditedUnit;
  const scored: { clip: ScoredClip; signals: JevSignals; decide: StageTwoDecide }[] =
    [];
  for (const clip of toRescore) {
    const unit = unitFromClip(clip);
    const signals = await evaluate(unit);
    const keepScore = computeKeepScore(signals, input.profile);
    const decide = decideVerdict(signals, keepScore);
    scored.push({
      clip,
      signals,
      decide: {
        keepScore,
        verdict: decide.verdict,
        autoMarker: decide.autoMarker,
      },
    });
  }
  const byId = new Map(scored.map((item) => [item.clip.id, item]));
  let merged = relinked.map((clip) => {
    const stage2 = byId.get(clip.id);
    if (!stage2) {
      return clip;
    }
    return mergeStageTwoVerdict(clip, stage2.signals, stage2.decide);
  });

  const draftLines = editedLinesFromClips(merged);
  const review =
    (await input.reviewConversation?.(draftLines)) ??
    (await reviewEditedTranscript(draftLines));
  if (review.reviewClipIds.length > 0) {
    const flagged = new Set(review.reviewClipIds);
    merged = merged.map((clip) => {
      if (!flagged.has(clip.id) || clip.verdict === "cut") {
        return clip;
      }
      if (clip.verdict === "review") {
        return clip;
      }
      return {
        ...clip,
        verdict: "review" as const,
        autoMarker: false,
        reason: "stage2_review",
      };
    });
  }

  const editedTranscript = buildEditedTranscript(merged, {
    source: review.source,
    notes: review.notes,
    rescoreCount: scored.length,
  });
  const liveJev = scored.some((item) => item.signals.provider !== "mock");
  const notes = [
    `二段階編集: 編集済み台詞 ${editedTranscript.lines.length} 行を再構築 · Jev 再評価 ${scored.length}（${liveJev ? "live" : "mock"}）· Omni ${review.source}`,
    ...review.notes,
  ];
  return { clips: merged, editedTranscript, notes };
}

export function relinkEditedClips(clips: ScoredClip[]): ScoredClip[] {
  const kept = clips
    .filter((clip) => clip.verdict !== "cut")
    .sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
  return clips.map((clip) => {
    if (clip.verdict === "cut") {
      return clip;
    }
    const index = kept.findIndex((item) => item.id === clip.id);
    if (index < 0) {
      return clip;
    }
    const previous = kept[index - 1]?.text;
    const next = kept[index + 1]?.text;
    return { ...clip, previous, next };
  });
}

export function editedLinesFromClips(clips: ScoredClip[]): EditedTranscriptLine[] {
  return clips
    .filter((clip) => clip.verdict !== "cut")
    .sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs)
    .map((clip, index, kept) => ({
      clipId: clip.id,
      speaker: clip.speaker,
      text: clip.text,
      startMs: clip.startMs,
      endMs: clip.endMs,
      previous: kept[index - 1]?.text,
      next: kept[index + 1]?.text,
    }));
}

export function buildEditedTranscript(
  clips: ScoredClip[],
  extra: {
    source?: EditedTranscript["source"];
    notes?: string[];
    rescoreCount?: number;
  } = {},
): EditedTranscript {
  return {
    source: extra.source ?? "mock",
    lines: editedLinesFromClips(clips),
    notes: extra.notes ?? [],
    rescoreCount: extra.rescoreCount ?? 0,
  };
}

export function mergeStageTwoVerdict(
  stage1: ScoredClip,
  signals: JevSignals,
  decide: StageTwoDecide,
): ScoredClip {
  if (stage1.verdict === "cut") {
    return stage1;
  }
  const verdict = pickStageTwoVerdict(stage1.verdict, signals, decide);
  const reason =
    verdict === stage1.verdict
      ? stage1.reason
      : verdict === "cut"
        ? "stage2_context"
        : verdict === "review"
          ? "stage2_review"
          : stage1.reason;
  return {
    ...stage1,
    signals,
    keepScore: decide.keepScore,
    autoMarker: decide.autoMarker,
    verdict,
    reason,
  };
}

export async function evaluateEditedUnit(unit: EditUnit): Promise<JevSignals> {
  if (!jevEnv().live) {
    return mockSignalsForEditedContext(unit);
  }
  try {
    return await evaluateUnit(unit);
  } catch {
    return mockSignalsForEditedContext(unit);
  }
}

export function mockSignalsForEditedContext(unit: EditUnit): JevSignals {
  const base = mockSignals(unit);
  if (unit.previous && sameUtterance(unit.previous, unit.text)) {
    return {
      ...base,
      importance: Math.min(base.importance, 0.12),
      novelty: Math.min(base.novelty, 0.06),
      contextRequired: Math.min(base.contextRequired, 0.08),
      redundancy: Math.max(base.redundancy, 0.92),
      removalNatural: Math.max(base.removalNatural, 0.9),
      confidence: Math.max(base.confidence, 0.93),
    };
  }
  if (unit.previous && isQuestion(unit.previous) && unit.role === "content") {
    return {
      ...base,
      contextRequired: Math.max(base.contextRequired, 0.88),
      importance: Math.max(base.importance, 0.78),
      removalNatural: Math.min(base.removalNatural, 0.18),
      confidence: Math.max(base.confidence, 0.9),
    };
  }
  return base;
}

export async function reviewEditedTranscript(
  lines: EditedTranscriptLine[],
): Promise<EditedTranscriptReview> {
  const fallback = mockReviewEditedTranscript(lines);
  const env = qwenEnv();
  if (!env.live) {
    return fallback;
  }
  try {
    const raw = await fetchOmniText(env.baseUrl, env.apiKey, editedTranscriptPrompt(lines));
    return parseEditedTranscriptReview(raw, lines);
  } catch (error) {
    return {
      ...fallback,
      notes: [
        ...fallback.notes,
        `キーはあるが Omni 再評価に失敗したためモックです: ${error instanceof Error ? error.message : String(error)}`,
      ],
    };
  }
}

export function mockReviewEditedTranscript(
  lines: EditedTranscriptLine[],
): EditedTranscriptReview {
  const reviewClipIds: string[] = [];
  const notes: string[] = ["キーが無いため編集済み台詞の Omni 再評価はモックです。"];
  const questions = lines.filter((line) => isQuestion(line.text));
  for (const question of questions) {
    const hasAnswer = lines.some(
      (line) => line.startMs >= question.endMs && line.text.trim().length > 0,
    );
    if (!hasAnswer) {
      reviewClipIds.push(question.clipId);
      notes.push("編集済み台詞で質問のあとに答えが残っていない");
    }
  }
  const pronouns = lines.filter((line) =>
    /^(それ|あれ|これ)(は|が|を|も)/.test(line.text.trim()),
  );
  for (const line of pronouns) {
    const prior = lines.some(
      (other) => other.endMs <= line.startMs && other.text.trim().length >= 4,
    );
    if (!prior) {
      reviewClipIds.push(line.clipId);
      notes.push("編集済み台詞で指示語の先行詞が残っていない");
    }
  }
  const seen = new Map<string, string>();
  for (const line of lines) {
    const key = normalizeUtterance(line.text);
    if (key.length < 8) {
      continue;
    }
    const previous = seen.get(key);
    if (previous) {
      reviewClipIds.push(line.clipId);
      notes.push("編集済み台詞で同じ発話が重複している");
    } else {
      seen.set(key, line.clipId);
    }
  }
  const unique = [...new Set(reviewClipIds)];
  return {
    source: "mock",
    conversationMakesSense: unique.length === 0,
    reviewClipIds: unique,
    notes,
  };
}

function pickStageTwoVerdict(
  stage1: Exclude<Verdict, "cut">,
  signals: JevSignals,
  decide: StageTwoDecide,
): Verdict {
  switch (decide.verdict) {
    case "review":
      return "review";
    case "keep":
      if (stage1 === "review") {
        return signals.confidence >= STAGE2_KEEP_UPGRADE_CONFIDENCE
          ? "keep"
          : "review";
      }
      return "keep";
    case "cut":
      if (stage1 === "review") {
        return "review";
      }
      if (signals.confidence < STAGE2_CUT_CONFIDENCE) {
        return "keep";
      }
      return "cut";
    default: {
      const _never: never = decide.verdict;
      return _never;
    }
  }
}

function unitFromClip(clip: ScoredClip): EditUnit {
  return {
    id: clip.id,
    speaker: clip.speaker,
    text: clip.text,
    startMs: clip.startMs,
    endMs: clip.endMs,
    role: clip.role,
    pauseClass: clip.pauseClass,
    previous: clip.previous,
    next: clip.next,
  };
}

function sameUtterance(left: string, right: string): boolean {
  const a = normalizeUtterance(left);
  const b = normalizeUtterance(right);
  return a.length >= 8 && a === b;
}

function normalizeUtterance(text: string): string {
  return text.trim().replace(/\s+/g, "");
}

function isQuestion(text: string): boolean {
  return /[？?]$/.test(text.trim());
}

function editedTranscriptPrompt(lines: EditedTranscriptLine[]): string {
  const body = lines
    .map(
      (line) =>
        `${line.clipId} ${line.speaker} ${line.startMs}-${line.endMs} ${line.text}`,
    )
    .join("\n");
  return [
    "You are CutLine. This is the edited transcript after a first KEEP/CUT pass.",
    "Do not propose cut points. Return JSON only.",
    "Schema:",
    JSON.stringify({
      conversationMakesSense: true,
      reviewClipIds: ["clip-id"],
      notes: ["short Japanese note"],
    }),
    "Questions:",
    "Does this conversation still make sense?",
    "Are references missing?",
    "Did a pronoun lose its antecedent?",
    "Did a question lose its answer?",
    "Is there unnecessary repetition?",
    "If unsure, put the clip id in reviewClipIds. Never mark CUT.",
    "Edited transcript:",
    body || "(empty)",
  ].join("\n");
}

async function fetchOmniText(
  baseUrl: string,
  apiKey: string,
  prompt: string,
): Promise<string> {
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: omniModelId(),
      messages: [{ role: "user", content: prompt }],
      stream: false,
    }),
    signal: AbortSignal.timeout(60_000),
  });
  const payload = (await response.json()) as unknown;
  if (!response.ok) {
    throw new Error(`Omni transcript ${response.status}`);
  }
  const text = textFromChat(payload);
  if (!text) {
    throw new Error("Omni のテキストが空です");
  }
  return text;
}

function textFromChat(payload: unknown): string {
  if (!payload || typeof payload !== "object") {
    return "";
  }
  const record = payload as Record<string, unknown>;
  const choices = record.choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    return "";
  }
  const message = (choices[0] as { message?: { content?: unknown } }).message;
  const content = message?.content;
  if (typeof content === "string") {
    return content;
  }
  return "";
}

function parseEditedTranscriptReview(
  raw: string,
  lines: EditedTranscriptLine[],
): EditedTranscriptReview {
  const known = new Set(lines.map((line) => line.clipId));
  const record = extractJsonObject(raw) as Record<string, unknown>;
  const reviewClipIds = Array.isArray(record.reviewClipIds)
    ? record.reviewClipIds
        .map((item) => asString(item, ""))
        .filter((id) => known.has(id))
    : [];
  const notes = Array.isArray(record.notes)
    ? record.notes.map((item) => asString(item, "")).filter((item) => item.length > 0)
    : [];
  return {
    source: "live",
    conversationMakesSense: asBoolean(
      record.conversationMakesSense,
      reviewClipIds.length === 0,
    ),
    reviewClipIds,
    notes: notes.length > 0 ? notes : ["編集済み台詞を Omni で再評価した"],
  };
}

export { STAGE2_CUT_CONFIDENCE, STAGE2_KEEP_UPGRADE_CONFIDENCE };
