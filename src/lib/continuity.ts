import type { ContinuityQa, ScoredClip } from "./types";

export function runContinuityCheck(clips: ScoredClip[]): ContinuityQa {
  const kept = clips.filter((clip) => clip.verdict === "keep");
  const issues: ContinuityQa["issues"] = [];

  const questions = kept.filter((clip) => /[？?]$/.test(clip.text.trim()));
  for (const question of questions) {
    const hasAnswer = kept.some(
      (clip) => clip.startMs >= question.endMs && clip.role === "content",
    );
    if (!hasAnswer) {
      issues.push({
        clipId: question.id,
        issue: "質問のあとに答えが残っていない",
      });
    }
  }

  const pronouns = kept.filter((clip) =>
    /^(それ|あれ|これ)(は|が|を|も)/.test(clip.text.trim()),
  );
  for (const clip of pronouns) {
    const prior = kept.some(
      (other) => other.endMs <= clip.startMs && other.role === "content",
    );
    if (!prior) {
      issues.push({
        clipId: clip.id,
        issue: "指示語の先行詞が残っていない",
      });
    }
  }

  const seen = new Map<string, string>();
  for (const clip of kept) {
    const normalized = clip.text.trim();
    if (normalized.length < 8) {
      continue;
    }
    const previous = seen.get(normalized);
    if (previous) {
      issues.push({
        clipId: clip.id,
        issue: "同じ発話が重複して残っている",
      });
    } else {
      seen.set(normalized, clip.id);
    }
  }

  const questionLostAnswer = issues.some((item) =>
    item.issue.includes("答え"),
  );
  const pronounLostAntecedent = issues.some((item) =>
    item.issue.includes("先行詞"),
  );
  const unnecessaryRepetition = issues.some((item) =>
    item.issue.includes("重複"),
  );
  return {
    conversationMakesSense: issues.length === 0,
    missingReferences: pronounLostAntecedent,
    pronounLostAntecedent,
    questionLostAnswer,
    unnecessaryRepetition,
    issues,
  };
}
