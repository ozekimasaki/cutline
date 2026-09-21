import type { ContinuityQa, ScoredClip, WatchQa } from "./types";

export function mockWatchQa(input: {
  clips: ScoredClip[];
  continuity?: ContinuityQa;
}): WatchQa {
  const kept = input.clips.filter((clip) => clip.verdict === "keep");
  const issues: WatchQa["issues"] = [];
  const brokenConversations =
    input.continuity?.questionLostAnswer === true;
  if (brokenConversations) {
    const question = kept.find((clip) => /[？?]$/.test(clip.text.trim()));
    const restore = input.clips.find(
      (clip) =>
        clip.verdict === "cut" &&
        clip.role === "content" &&
        clip.startMs >= (question?.endMs ?? 0),
    );
    issues.push({
      atMs: question?.startMs,
      issue: "broken conversations",
      restoreClipId: restore?.id,
    });
  }
  const missingContext = (input.continuity?.issues.length ?? 0) > 0;
  if (missingContext && !brokenConversations) {
    const restore = input.clips.find(
      (clip) => clip.verdict === "cut" && clip.role === "content",
    );
    issues.push({
      issue: "missing context",
      restoreClipId: restore?.id,
    });
  }
  const abruptTopicChanges = kept.some((clip, index) => {
    if (index === 0) {
      return false;
    }
    const previous = kept[index - 1];
    return Boolean(previous && clip.startMs - previous.endMs > 12_000);
  });
  if (abruptTopicChanges) {
    issues.push({ issue: "abrupt topic changes" });
  }
  const obviousBadCuts = input.clips.some(
    (clip, index) =>
      clip.verdict === "cut" &&
      clip.role === "content" &&
      input.clips[index + 1]?.verdict === "keep" &&
      input.clips[index + 1]?.speaker === clip.speaker,
  );
  if (obviousBadCuts) {
    const restore = input.clips.find(
      (clip, index) =>
        clip.verdict === "cut" &&
        clip.role === "content" &&
        input.clips[index + 1]?.verdict === "keep" &&
        input.clips[index + 1]?.speaker === clip.speaker,
    );
    issues.push({
      issue: "obvious bad cuts",
      restoreClipId: restore?.id,
    });
  }
  const awkwardCameraSwitching =
    kept.filter((clip, index) => index > 0 && clip.camera !== kept[index - 1]?.camera)
      .length >= Math.max(3, kept.length - 1);
  if (awkwardCameraSwitching) {
    issues.push({ issue: "awkward camera switching" });
  }
  const flags = {
    brokenConversations,
    abruptTopicChanges,
    obviousBadCuts,
    audioDiscontinuities: false,
    missingContext,
    awkwardCameraSwitching,
  };
  return {
    source: "mock",
    iterations: 1,
    ...flags,
    issues,
    ok: issues.length === 0,
  };
}

export function applyWatchFixes(
  clips: ScoredClip[],
  watch: WatchQa,
): ScoredClip[] {
  const restore = new Set(
    watch.issues
      .map((issue) => issue.restoreClipId)
      .filter((id): id is string => Boolean(id)),
  );
  if (restore.size === 0) {
    return clips;
  }
  return clips.map((clip) =>
    restore.has(clip.id) && clip.verdictSource !== "user"
      ? {
          ...clip,
          verdict: "keep" as const,
          reason: "watch QA restore",
        }
      : clip,
  );
}

export function watchQuestionsPrompt(): string {
  return [
    "You are watching the EDITED CutLine video, not the source.",
    "Return JSON only.",
    "Questions:",
    JSON.stringify({
      brokenConversations: false,
      abruptTopicChanges: false,
      obviousBadCuts: false,
      audioDiscontinuities: false,
      missingContext: false,
      awkwardCameraSwitching: false,
      issues: [{ atMs: 0, issue: "string", restoreClipId: "optional clip id" }],
    }),
    "Do not propose new generative footage. Only report problems in the edit.",
  ].join("\n");
}
