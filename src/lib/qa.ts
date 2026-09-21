import { durationOf } from "./decide";
import type { FinalQa, ScoredClip } from "./types";

export function runFinalQa(clips: ScoredClip[]): FinalQa {
  const meaningRisks: FinalQa["meaningRisks"] = [];
  const kept = clips.filter((clip) => clip.verdict === "keep");
  const keptText = kept
    .map((clip) => clip.text.trim())
    .filter(Boolean)
    .join("\n");

  const questions = kept.filter((clip) => /[？?]$/.test(clip.text.trim()));
  for (const question of questions) {
    const hasAnswer = kept.some(
      (clip) => clip.startMs >= question.endMs && clip.role === "content",
    );
    if (!hasAnswer) {
      meaningRisks.push({
        clipId: question.id,
        issue: "質問のあとに答えが残っていない",
      });
    }
  }

  if (/ダメだと思った/.test(keptText) && !/良かった|よかった/.test(keptText)) {
    const clip = kept.find((item) => /ダメだと思った/.test(item.text));
    if (clip) {
      meaningRisks.push({
        clipId: clip.id,
        issue: "否定だけが残り、意味が反転している可能性",
      });
    }
  }

  const keepCount = kept.length;
  const finalDurationMs = kept.reduce((sum, clip) => sum + durationOf(clip), 0);
  const cameraSwitchCount = kept.reduce((count, clip, index) => {
    if (index === 0) {
      return 0;
    }
    return count + (clip.camera && clip.camera !== kept[index - 1]?.camera ? 1 : 0);
  }, 0);
  const minutes = finalDurationMs / 60_000;

  return {
    meaningRisks,
    cutCount: clips.filter((clip) => clip.verdict === "cut").length,
    keepCount,
    reviewCount: clips.filter((clip) => clip.verdict === "review").length,
    finalDurationMs,
    humanCorrections: clips.filter((clip) => clip.verdictSource === "user").length,
    cameraSwitchCount,
    averageShotLengthMs: keepCount === 0 ? 0 : Math.round(finalDurationMs / keepCount),
    jumpCutCount: kept.filter(
      (clip) =>
        clip.punchIn === true ||
        (clip.cameraReason ?? "").toLowerCase().includes("jump"),
    ).length,
    cameraSwitchRate: minutes > 0 ? cameraSwitchCount / minutes : 0,
  };
}
