import { computeKeepScore, decideVerdict, durationOf } from "./decide";
import type {
  EditProfile,
  JevSignals,
  MeaningLink,
  MeaningLinkType,
  ScoredClip,
  SemanticRole,
  Verdict,
} from "./types";

export function buildMeaningLinks(
  units: Array<{
    id: string;
    text: string;
    role: SemanticRole;
    startMs: number;
  }>,
): MeaningLink[] {
  const links: MeaningLink[] = [];
  for (let index = 0; index < units.length; index += 1) {
    const unit = units[index];
    const nextSpoken = units
      .slice(index + 1)
      .find((item) => item.role !== "pause" && item.role !== "filler");
    if (!nextSpoken) {
      continue;
    }
    if (isQuestion(unit.text)) {
      pushLink(links, "question_answer", unit.id, nextSpoken.id);
    }
    if (unit.role === "false_start" && nextSpoken.role === "self_correction") {
      pushLink(links, "correction", unit.id, nextSpoken.id);
    }
    if (hasContrast(unit.text) || unit.role === "self_correction") {
      const conclusion = units
        .slice(index + 1)
        .find((item) => item.role === "content");
      if (conclusion) {
        pushLink(links, "contrast", unit.id, conclusion.id);
      }
    }
    if (canBeSetup(unit.role) && !isQuestion(unit.text) && isSetup(unit.text)) {
      pushLink(links, "setup_punchline", unit.id, nextSpoken.id);
    }
    if (
      canBeClaim(unit.role) &&
      !isQuestion(unit.text) &&
      nextSpoken.role !== "self_correction" &&
      isReason(nextSpoken.text)
    ) {
      pushLink(links, "claim_reason", unit.id, nextSpoken.id);
    }
  }
  return links;
}

export function applySemanticSafety(
  clips: ScoredClip[],
  links: MeaningLink[],
  profile: EditProfile,
): ScoredClip[] {
  let next = rescoreChildrenOfDeletedParents(
    clips.map((clip) => ({ ...clip })),
    links,
    profile,
  );
  const byId = new Map(next.map((clip) => [clip.id, clip]));

  const setReview = (id: string, issue: string) => {
    next = next.map((clip) => {
      if (clip.id !== id || clip.verdictSource === "user") {
        return clip;
      }
      if (clip.verdict === "keep") {
        return clip;
      }
      return {
        ...clip,
        verdict: "review" as const,
        reason: `${clip.reason}（${issue}）`,
      };
    });
  };

  const setKeep = (id: string, issue: string) => {
    next = next.map((clip) => {
      if (clip.id !== id || clip.verdictSource === "user") {
        return clip;
      }
      if (clip.verdict === "keep") {
        return clip;
      }
      return {
        ...clip,
        verdict: profile === "tight" || profile === "short" ? ("review" as const) : ("keep" as const),
        reason: `${clip.reason}（${issue}）`,
      };
    });
  };

  for (const link of links) {
    const from = byId.get(link.fromId);
    const to = byId.get(link.toId);
    if (!from || !to) {
      continue;
    }
    const fromVerdict = next.find((clip) => clip.id === from.id)?.verdict;
    const toVerdict = next.find((clip) => clip.id === to.id)?.verdict;
    if (!fromVerdict || !toVerdict) {
      continue;
    }

    switch (link.type) {
      case "question_answer":
        if (fromVerdict === "cut" && toVerdict !== "cut") {
          setReview(from.id, "答えを残すなら質問を確認");
        }
        if (fromVerdict !== "cut" && toVerdict === "cut") {
          setReview(to.id, "質問を残すなら答えを確認");
        }
        protectPauseBetween(next, from.id, to.id, setKeep);
        break;
      case "correction":
        if (fromVerdict !== "cut" && toVerdict === "cut") {
          setReview(to.id, "言い直し後を落とすと意味が残る");
        }
        break;
      case "contrast":
      case "setup_punchline":
        if (fromVerdict !== "cut" && toVerdict === "cut") {
          setReview(to.id, "対比・結論が欠ける");
        }
        if (fromVerdict === "cut" && toVerdict !== "cut") {
          setReview(from.id, "結論だけ残すと意味が反転しうる");
        }
        break;
      case "claim_reason":
        if (fromVerdict !== "cut" && toVerdict === "cut") {
          setReview(to.id, "主張を残すなら理由を確認");
        }
        if (fromVerdict === "cut" && toVerdict !== "cut") {
          setReview(from.id, "理由だけ残すと根拠が欠ける");
        }
        break;
      default: {
        const _never: never = link.type;
        return _never;
      }
    }
  }

  return next;
}

function rescoreChildrenOfDeletedParents(
  clips: ScoredClip[],
  links: MeaningLink[],
  profile: EditProfile,
): ScoredClip[] {
  const next = clips.map((clip) => ({ ...clip, signals: { ...clip.signals } }));
  const indexById = new Map(next.map((clip, index) => [clip.id, index]));
  const childrenByParent = new Map<string, string[]>();
  for (const link of links) {
    const children = childrenByParent.get(link.fromId) ?? [];
    if (!children.includes(link.toId)) {
      children.push(link.toId);
    }
    childrenByParent.set(link.fromId, children);
  }

  const queue: string[] = [];
  const seen = new Set<string>();
  for (const clip of next) {
    if (clip.verdict !== "cut") {
      continue;
    }
    for (const childId of childrenByParent.get(clip.id) ?? []) {
      queue.push(childId);
    }
  }

  while (queue.length > 0) {
    const id = queue.shift();
    if (!id || seen.has(id)) {
      continue;
    }
    seen.add(id);
    const at = indexById.get(id);
    if (at === undefined) {
      continue;
    }
    const clip = next[at];
    const descendants = childrenByParent.get(id) ?? [];

    if (clip.verdictSource === "user") {
      if (clip.verdict === "cut") {
        queue.push(...descendants);
      }
      continue;
    }

    if (clip.verdict === "cut") {
      queue.push(...descendants);
      continue;
    }

    const rescored = rescoreAfterParentCut(clip, profile);
    next[at] = rescored;
    if (rescored.verdict === "cut") {
      queue.push(...descendants);
    }
  }

  return next;
}

function rescoreAfterParentCut(clip: ScoredClip, profile: EditProfile): ScoredClip {
  const signals: JevSignals = {
    ...clip.signals,
    importance: clamp01(clip.signals.importance * 0.7),
    contextRequired: clamp01(Math.max(clip.signals.contextRequired, 0.55)),
  };
  const keepScore = computeKeepScore(signals, profile);
  const decided = decideVerdict(signals, keepScore);
  const verdict = preferKeepWhenUnsure(decided.verdict, signals.confidence);
  return {
    ...clip,
    signals,
    keepScore,
    autoMarker: decided.autoMarker,
    verdict,
    reason: `${clip.reason}（親削除のため再評価）`,
  };
}

function preferKeepWhenUnsure(verdict: Verdict, confidence: number): Verdict {
  if (verdict !== "cut") {
    return verdict;
  }
  if (confidence >= 0.95) {
    return "cut";
  }
  if (confidence < 0.6) {
    return "keep";
  }
  return "review";
}

function protectPauseBetween(
  clips: ScoredClip[],
  fromId: string,
  toId: string,
  setKeep: (id: string, issue: string) => void,
) {
  const from = clips.find((clip) => clip.id === fromId);
  const to = clips.find((clip) => clip.id === toId);
  if (!from || !to) {
    return;
  }
  for (const clip of clips) {
    if (clip.role !== "pause") {
      continue;
    }
    if (clip.startMs >= from.endMs && clip.endMs <= to.startMs) {
      if (
        clip.pauseClass === "thinking" ||
        clip.pauseClass === "long" ||
        durationOf(clip) >= 700
      ) {
        setKeep(clip.id, "考えている間として残す");
      }
    }
  }
}

export function isQuestion(text: string): boolean {
  return /[？?]$/.test(text.trim());
}

function pushLink(
  links: MeaningLink[],
  type: MeaningLinkType,
  fromId: string,
  toId: string,
) {
  if (fromId === toId) {
    return;
  }
  if (
    links.some(
      (link) => link.type === type && link.fromId === fromId && link.toId === toId,
    )
  ) {
    return;
  }
  links.push({ type, fromId, toId });
}

function canBeSetup(role: SemanticRole): boolean {
  return role === "content";
}

function canBeClaim(role: SemanticRole): boolean {
  return role === "content" || role === "self_correction";
}

function isSetup(text: string): boolean {
  return /と思(?:っ|ってたら)|という話|なんですけど/.test(text);
}

function isReason(text: string): boolean {
  return /なぜなら|というのは|だって|理由は|(?:ですから|からです)[。．]?$|(?:ので|から)、/.test(
    text,
  );
}

function hasContrast(text: string): boolean {
  return /けど|けれど|しかし|ただし|一方/.test(text);
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}
