import type { MeaningLink, ScoredClip, SemanticRole } from "./types";

const OVER_TARGET_REASON = "（目標尺を超えるため確認）";

export type DeletionCandidate = {
  clipId: string;
  groupId: string;
  value: number;
  durationMs: number;
  dependency: number;
  risk: number;
  dropScore: number;
};

type PackGroup = {
  id: string;
  clipIds: string[];
  durationMs: number;
  value: number;
  dependency: number;
  risk: number;
  dropScore: number;
};

export function clipDurationMs(clip: { startMs: number; endMs: number }): number {
  return Math.max(0, clip.endMs - clip.startMs);
}

export function editorialValue(clip: ScoredClip): number {
  const signals = clip.signals;
  const answerContribution = clamp01(
    1 - Math.max(signals.filler, signals.falseStart, signals.tangent),
  );
  let value =
    clip.keepScore * 0.62 +
    signals.importance * 0.14 +
    signals.novelty * 0.06 +
    signals.contextRequired * 0.08 +
    signals.humanTexture * 0.06 +
    answerContribution * 0.06 -
    signals.redundancy * 0.1 -
    signals.filler * 0.06 -
    signals.tangent * 0.07;

  switch (clip.role) {
    case "filler":
    case "false_start":
      value -= 0.08;
      break;
    case "self_correction":
      value += 0.04;
      break;
    case "pause":
      if (clip.pauseClass === "thinking" || clip.pauseClass === "long") {
        value += 0.05;
      } else {
        value -= 0.05;
      }
      break;
    case "backchannel":
      value -= 0.03;
      break;
    case "content":
      break;
    default: {
      const _never: never = clip.role;
      return _never;
    }
  }

  return clamp01(value);
}

export function inferDurationLinks(
  clips: Array<{
    id: string;
    text: string;
    role: SemanticRole;
    startMs: number;
  }>,
): MeaningLink[] {
  const ordered = [...clips].sort((a, b) => a.startMs - b.startMs);
  const links: MeaningLink[] = [];
  for (let index = 0; index < ordered.length; index += 1) {
    const unit = ordered[index];
    if (!unit) {
      continue;
    }
    const nextSpoken = ordered
      .slice(index + 1)
      .find((item) => item.role !== "pause" && item.role !== "filler");
    if (!nextSpoken) {
      continue;
    }
    if (isQuestion(unit.text)) {
      links.push({
        type: "question_answer",
        fromId: unit.id,
        toId: nextSpoken.id,
      });
    }
    if (unit.role === "false_start" && nextSpoken.role === "self_correction") {
      links.push({
        type: "correction",
        fromId: unit.id,
        toId: nextSpoken.id,
      });
    }
    if (hasContrast(unit.text) || unit.role === "self_correction") {
      const conclusion = ordered
        .slice(index + 1)
        .find((item) => item.role === "content");
      if (conclusion) {
        links.push({
          type: "contrast",
          fromId: unit.id,
          toId: conclusion.id,
        });
      }
    }
  }
  return links;
}

export function rankDeletionCandidates(
  clips: ScoredClip[],
  links: MeaningLink[] = inferDurationLinks(clips),
): DeletionCandidate[] {
  const { droppable, groupOf, protectedPauses } = partitionForPacking(clips, links);
  const droppableIds = new Set(droppable.map((clip) => clip.id));
  return droppable
    .map((clip) => {
      const group = groupOf.get(clip.id);
      const value = editorialValue(clip);
      const durationMs = clipDurationMs(clip);
      const dependency = group?.dependency ?? dependencyOf(clip.id, links, 1);
      const risk = group
        ? Math.max(group.risk, riskOf(clip, protectedPauses))
        : riskOf(clip, protectedPauses);
      return {
        clipId: clip.id,
        groupId: group?.id ?? clip.id,
        value,
        durationMs,
        dependency,
        risk,
        dropScore: dropScoreOf(value, durationMs, dependency, risk),
      };
    })
    .filter((candidate) => droppableIds.has(candidate.clipId))
    .sort((a, b) => {
      const scoreDelta = b.dropScore - a.dropScore;
      if (scoreDelta !== 0) {
        return scoreDelta;
      }
      const durationDelta = b.durationMs - a.durationMs;
      if (durationDelta !== 0) {
        return durationDelta;
      }
      return a.value - b.value;
    });
}

export function optimizeDuration(
  clips: ScoredClip[],
  targetDurationMs: number,
  links: MeaningLink[] = inferDurationLinks(clips),
): ScoredClip[] {
  if (targetDurationMs <= 0) {
    return clips;
  }

  const autoKeeps = clips.filter(isAutoKeep);
  const autoTotal = autoKeeps.reduce((sum, clip) => sum + clipDurationMs(clip), 0);
  if (autoTotal <= targetDurationMs) {
    return clips;
  }

  const { lockedIds, groups } = partitionForPacking(clips, links);
  const lockedDuration = autoKeeps
    .filter((clip) => lockedIds.has(clip.id))
    .reduce((sum, clip) => sum + clipDurationMs(clip), 0);
  const budget = targetDurationMs - lockedDuration;
  const selectedGroupIds =
    budget <= 0 ? new Set<string>() : selectGroups(groups, budget);

  const keepIds = new Set<string>(lockedIds);
  for (const group of groups) {
    if (!selectedGroupIds.has(group.id)) {
      continue;
    }
    for (const clipId of group.clipIds) {
      keepIds.add(clipId);
    }
  }

  return clips.map((clip) => {
    if (isAutoKeep(clip) && !keepIds.has(clip.id)) {
      return {
        ...clip,
        verdict: "review" as const,
        reason: `${clip.reason}${OVER_TARGET_REASON}`,
      };
    }
    return clip;
  });
}

function partitionForPacking(clips: ScoredClip[], links: MeaningLink[]) {
  const autoKeeps = clips.filter(isAutoKeep);
  const protectedPauses = protectedPauseIds(clips, links);
  const parent = unionFind(clips.map((clip) => clip.id));
  for (const link of links) {
    if (!isAtomicLink(link.type)) {
      continue;
    }
    parent.union(link.fromId, link.toId);
  }

  const userKeepRoots = new Set(
    clips
      .filter((clip) => clip.verdict === "keep" && clip.verdictSource === "user")
      .map((clip) => parent.find(clip.id)),
  );

  const lockedIds = new Set<string>();
  for (const clip of autoKeeps) {
    if (protectedPauses.has(clip.id) || userKeepRoots.has(parent.find(clip.id))) {
      lockedIds.add(clip.id);
    }
  }

  const droppable = autoKeeps.filter((clip) => !lockedIds.has(clip.id));
  const buckets = new Map<string, ScoredClip[]>();
  for (const clip of droppable) {
    const root = parent.find(clip.id);
    const bucket = buckets.get(root) ?? [];
    bucket.push(clip);
    buckets.set(root, bucket);
  }

  const groups: PackGroup[] = [...buckets.entries()].map(([root, members]) => {
    const durationMs = members.reduce((sum, clip) => sum + clipDurationMs(clip), 0);
    const value = members.reduce(
      (sum, clip) => sum + editorialValue(clip) * clipDurationMs(clip),
      0,
    );
    const dependency = Math.max(
      ...members.map((clip) => dependencyOf(clip.id, links, members.length)),
    );
    const risk = Math.max(...members.map((clip) => riskOf(clip, protectedPauses)));
    const meanValue =
      durationMs > 0
        ? members.reduce((sum, clip) => sum + editorialValue(clip), 0) / members.length
        : 0;
    return {
      id: root,
      clipIds: members.map((clip) => clip.id),
      durationMs,
      value,
      dependency,
      risk,
      dropScore: dropScoreOf(meanValue, durationMs, dependency, risk),
    };
  });

  const groupOf = new Map<string, PackGroup>();
  for (const group of groups) {
    for (const clipId of group.clipIds) {
      groupOf.set(clipId, group);
    }
  }

  return { autoKeeps, lockedIds, droppable, groups, groupOf, protectedPauses };
}

function selectGroups(groups: PackGroup[], capacityMs: number): Set<string> {
  const feasible = groups.filter((group) => group.durationMs <= capacityMs);
  if (feasible.length === 0 || capacityMs <= 0) {
    return new Set();
  }

  const quantum = packingQuantum(capacityMs);
  const cap = Math.floor(capacityMs / quantum);
  const cellCount = cap * feasible.length;
  if (cap > 240_000 || cellCount > 10_000_000) {
    return greedySelect(feasible, capacityMs);
  }

  const weights = feasible.map((group) =>
    Math.max(1, Math.ceil(group.durationMs / quantum)),
  );
  const dp = new Float64Array(cap + 1);
  const take = feasible.map(() => new Uint8Array(cap + 1));

  for (let index = 0; index < feasible.length; index += 1) {
    const group = feasible[index];
    const weight = weights[index];
    if (!group || weight > cap) {
      continue;
    }
    for (let capacity = cap; capacity >= weight; capacity -= 1) {
      const candidate = dp[capacity - weight] + group.value;
      if (candidate > dp[capacity] + 1e-9) {
        dp[capacity] = candidate;
        take[index][capacity] = 1;
      }
    }
  }

  let bestCap = 0;
  for (let capacity = 1; capacity <= cap; capacity += 1) {
    if (dp[capacity] > dp[bestCap] + 1e-9) {
      bestCap = capacity;
    }
  }

  const chosen = new Set<string>();
  let cursor = bestCap;
  for (let index = feasible.length - 1; index >= 0 && cursor > 0; index -= 1) {
    if (take[index]?.[cursor]) {
      const group = feasible[index];
      if (group) {
        chosen.add(group.id);
      }
      cursor -= weights[index] ?? 0;
    }
  }
  return chosen;
}

function greedySelect(groups: PackGroup[], capacityMs: number): Set<string> {
  const ranked = [...groups].sort((a, b) => {
    const dropDelta = b.dropScore - a.dropScore;
    if (dropDelta !== 0) {
      return dropDelta;
    }
    return a.value - b.value;
  });

  const dropped = new Set<string>();
  let remaining =
    groups.reduce((sum, group) => sum + group.durationMs, 0) - capacityMs;
  for (const group of ranked) {
    if (remaining <= 0) {
      break;
    }
    dropped.add(group.id);
    remaining -= group.durationMs;
  }

  const kept = groups.filter((group) => !dropped.has(group.id));
  let used = kept.reduce((sum, group) => sum + group.durationMs, 0);
  const chosen = new Set(kept.map((group) => group.id));

  const addBack = [...groups]
    .filter((group) => dropped.has(group.id))
    .sort((a, b) => b.value - a.value);
  for (const group of addBack) {
    if (used + group.durationMs <= capacityMs) {
      chosen.add(group.id);
      used += group.durationMs;
    }
  }
  return chosen;
}

function protectedPauseIds(clips: ScoredClip[], links: MeaningLink[]): Set<string> {
  const byId = new Map(clips.map((clip) => [clip.id, clip]));
  const ids = new Set<string>();
  for (const link of links) {
    if (link.type !== "question_answer") {
      continue;
    }
    const from = byId.get(link.fromId);
    const to = byId.get(link.toId);
    if (!from || !to) {
      continue;
    }
    for (const clip of clips) {
      if (clip.role !== "pause") {
        continue;
      }
      if (clip.startMs < from.endMs || clip.endMs > to.startMs) {
        continue;
      }
      if (
        clip.pauseClass === "thinking" ||
        clip.pauseClass === "long" ||
        clipDurationMs(clip) >= 700
      ) {
        ids.add(clip.id);
      }
    }
  }
  return ids;
}

function isAtomicLink(type: MeaningLink["type"]): boolean {
  switch (type) {
    case "question_answer":
    case "correction":
    case "contrast":
    case "setup_punchline":
      return true;
    default: {
      const _never: never = type;
      return _never;
    }
  }
}

function dependencyOf(clipId: string, links: MeaningLink[], groupSize: number): number {
  const linked = links.filter(
    (link) => isAtomicLink(link.type) && (link.fromId === clipId || link.toId === clipId),
  );
  if (linked.length === 0 && groupSize <= 1) {
    return 0;
  }
  let score = groupSize > 1 ? 0.55 : 0;
  if (linked.some((link) => link.type === "question_answer")) {
    score += 0.3;
  }
  if (linked.some((link) => link.type === "correction" || link.type === "contrast")) {
    score += 0.25;
  }
  if (linked.some((link) => link.type === "setup_punchline")) {
    score += 0.2;
  }
  return clamp01(score);
}

function riskOf(clip: ScoredClip, protectedPauses: Set<string>): number {
  let risk =
    clip.signals.reviewRequired * 0.35 +
    (1 - clip.signals.removalNatural) * 0.2 +
    clip.signals.contextRequired * 0.15;
  if (clip.role === "self_correction") {
    risk += 0.25;
  }
  if (protectedPauses.has(clip.id)) {
    risk += 0.45;
  }
  if (clip.pauseClass === "thinking" || clip.pauseClass === "long") {
    risk += 0.15;
  }
  return clamp01(risk);
}

function dropScoreOf(
  value: number,
  durationMs: number,
  dependency: number,
  risk: number,
): number {
  return (durationMs / (value + 0.05)) * (1 - dependency) * (1 - risk);
}

function isAutoKeep(clip: ScoredClip): boolean {
  return clip.verdict === "keep" && clip.verdictSource === "code";
}

function isQuestion(text: string): boolean {
  return /[？?]$/.test(text.trim());
}

function hasContrast(text: string): boolean {
  return /けど|けれど|しかし|ただし|一方/.test(text);
}

function packingQuantum(capacityMs: number): number {
  if (capacityMs >= 600_000) {
    return 100;
  }
  if (capacityMs >= 180_000) {
    return 25;
  }
  return 5;
}

function unionFind(ids: string[]) {
  const parent = new Map<string, string>();
  for (const id of ids) {
    parent.set(id, id);
  }
  const find = (id: string): string => {
    if (!parent.has(id)) {
      parent.set(id, id);
    }
    let current = parent.get(id) ?? id;
    const trail: string[] = [];
    while ((parent.get(current) ?? current) !== current) {
      trail.push(current);
      current = parent.get(current) ?? current;
    }
    for (const node of trail) {
      parent.set(node, current);
    }
    return current;
  };
  const union = (left: string, right: string) => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot !== rightRoot) {
      parent.set(leftRoot, rightRoot);
    }
  };
  return { find, union };
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}
