import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { access, mkdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { durationOf, keptClips } from "./decide";
import {
  BROLL_TAG,
  type BrollCue,
  type BrollMotive,
  type Perception,
  type ScoredClip,
  type TimelineClip,
  type TimelineIR,
  type Topic,
} from "./types";

const execFileAsync = promisify(execFile);

export const BROLL_SLATE_FILE = "broll-slate.mp4";
export const BROLL_CAMERA = "BROLL";
export const JUMP_GAP_MS = 250;
export const MIN_COVER_MS = 600;
export const MAX_COVER_MS = 4_000;

type CoverNeed = {
  motive: BrollMotive;
  startMs: number;
  endMs: number;
  label: string;
  confidence: number;
};

export type InsertBrollInput = {
  clips: ScoredClip[];
  chapters?: Topic[];
  perception?: Pick<
    Perception,
    "brollCues" | "keyMoments" | "topics" | "durationMs"
  >;
  cues?: BrollCue[];
  slateSource?: string;
};

export function isBrollClip(clip: TimelineClip): boolean {
  return clip.kind === "broll";
}

export function talkingHeadClips(clips: TimelineClip[]): TimelineClip[] {
  return clips.filter((clip) => !isBrollClip(clip));
}

export function parseOmniBrollCues(input: {
  brollCues?: unknown;
  keyMoments?: string[];
  topics?: string[];
  durationMs?: number;
}): BrollCue[] {
  const cues: BrollCue[] = [];
  if (Array.isArray(input.brollCues)) {
    for (const item of input.brollCues) {
      const parsed = cueFromUnknown(item);
      if (parsed) {
        cues.push(parsed);
      }
    }
  }
  for (const moment of input.keyMoments ?? []) {
    const parsed = cueFromText(moment);
    if (parsed) {
      cues.push(parsed);
    }
  }
  for (const topic of input.topics ?? []) {
    const parsed = cueFromText(topic);
    if (parsed) {
      cues.push(parsed);
    }
  }
  return dedupeCues(cues);
}

export function collectBrollNeeds(input: InsertBrollInput): CoverNeed[] {
  const kept = keptClips(input.clips);
  if (kept.length === 0) {
    return [];
  }
  const cues =
    input.cues ??
    parseOmniBrollCues({
      brollCues: input.perception?.brollCues,
      keyMoments: input.perception?.keyMoments,
      topics: input.perception?.topics,
      durationMs: input.perception?.durationMs,
    });
  const needs: CoverNeed[] = [
    ...omniNeeds(cues, kept, input.chapters ?? []),
    ...jumpCutNeeds(kept),
    ...topicVisualNeeds(kept, input.chapters ?? []),
  ];
  return mergeNeeds(needs).filter(
    (need) => need.endMs - need.startMs >= MIN_COVER_MS,
  );
}

export function insertBroll(
  timeline: TimelineIR,
  input: InsertBrollInput,
): TimelineIR {
  const needs = collectBrollNeeds(input);
  if (needs.length === 0) {
    return timeline;
  }
  const kept = keptClips(input.clips);
  const source = path.basename(input.slateSource || BROLL_SLATE_FILE);
  const overlays: TimelineClip[] = [];
  for (const need of needs) {
    const range = editedRange(kept, need.startMs, need.endMs);
    if (!range) {
      continue;
    }
    overlays.push({
      source,
      sourceIn: 0,
      sourceOut: range.durationSec,
      timelineIn: range.timelineIn,
      camera: BROLL_CAMERA,
      speaker: "",
      kind: "broll",
      track: "V2",
      decision: {
        reason: BROLL_TAG,
        confidence: need.confidence,
      },
      broll: {
        tag: BROLL_TAG,
        motive: need.motive,
        placeholder: true,
        label: need.label,
      },
    });
  }
  if (overlays.length === 0) {
    return timeline;
  }
  return {
    ...timeline,
    clips: talkingHeadClips(timeline.clips),
    broll: overlays,
  };
}

export function brollClipsOf(timeline: TimelineIR): TimelineClip[] {
  return timeline.broll ?? timeline.clips.filter(isBrollClip);
}

export function brollSummary(timeline: TimelineIR): string {
  const items = brollClipsOf(timeline);
  if (items.length === 0) {
    return "";
  }
  const motives = unique(
    items.map((clip) => motiveLabel(clip.broll?.motive ?? "omni_cue")),
  );
  return `B-roll: ${BROLL_TAG} ${items.length} 件（${motives.join(" / ")}）`;
}

export function brollSlatePath(): string {
  return path.join(os.tmpdir(), "cutline", BROLL_SLATE_FILE);
}

export async function ensureBrollSlate(): Promise<string> {
  const dest = brollSlatePath();
  await mkdir(path.dirname(dest), { recursive: true });
  try {
    await access(dest);
    return dest;
  } catch {
    // generate a color slate — not stock, slides, or imagery
  }
  await execFileAsync("ffmpeg", [
    "-y",
    "-f",
    "lavfi",
    "-i",
    "color=c=0x1c1917:s=1280x720:d=12",
    "-f",
    "lavfi",
    "-i",
    "anullsrc=r=48000:cl=stereo:d=12",
    "-shortest",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-b:a",
    "64k",
    dest,
  ]);
  return dest;
}

function omniNeeds(
  cues: BrollCue[],
  kept: ScoredClip[],
  chapters: Topic[],
): CoverNeed[] {
  const needs: CoverNeed[] = [];
  for (const cue of cues) {
    const window = resolveCueWindow(cue, kept, chapters);
    if (!window) {
      continue;
    }
    needs.push({
      motive: "omni_cue",
      startMs: window.startMs,
      endMs: window.endMs,
      label: cue.topic?.trim() || BROLL_TAG,
      confidence: 0.9,
    });
  }
  return needs;
}

function jumpCutNeeds(kept: ScoredClip[]): CoverNeed[] {
  const needs: CoverNeed[] = [];
  for (let index = 1; index < kept.length; index += 1) {
    const previous = kept[index - 1];
    const current = kept[index];
    if (!previous || !current) {
      continue;
    }
    if (!isRemainingJump(previous, current)) {
      continue;
    }
    needs.push({
      motive: "jump_cut",
      startMs: current.startMs,
      endMs: Math.min(current.endMs, current.startMs + MAX_COVER_MS),
      label: current.cameraReason || "jump cut",
      confidence: current.signals.confidence,
    });
  }
  return needs;
}

function topicVisualNeeds(kept: ScoredClip[], chapters: Topic[]): CoverNeed[] {
  const needs: CoverNeed[] = [];
  for (const chapter of chapters) {
    if (!isVisualTopic(chapter)) {
      continue;
    }
    const overlap = kept.filter(
      (clip) =>
        clip.role === "content" &&
        clip.endMs > chapter.startMs &&
        clip.startMs < chapter.endMs,
    );
    if (overlap.length === 0) {
      continue;
    }
    const startMs = Math.max(chapter.startMs, overlap[0]?.startMs ?? chapter.startMs);
    const last = overlap[overlap.length - 1];
    const endMs = Math.min(
      startMs + MAX_COVER_MS,
      chapter.endMs,
      last?.endMs ?? chapter.endMs,
    );
    needs.push({
      motive: "topic_visual",
      startMs,
      endMs,
      label: chapter.title,
      confidence: chapter.viewerValue,
    });
  }
  return needs;
}

function isRemainingJump(previous: ScoredClip, current: ScoredClip): boolean {
  const gap = current.startMs - previous.endMs;
  if (gap < JUMP_GAP_MS) {
    return false;
  }
  if (current.punchIn === true) {
    return true;
  }
  if ((current.cameraReason ?? "").toLowerCase().includes("jump")) {
    return true;
  }
  const prevCam = previous.camera ?? "A";
  const nextCam = current.camera ?? "A";
  return nextCam === prevCam;
}

function isVisualTopic(chapter: Topic): boolean {
  return chapter.importance === "high" || chapter.viewerValue >= 0.8;
}

function resolveCueWindow(
  cue: BrollCue,
  kept: ScoredClip[],
  chapters: Topic[],
): { startMs: number; endMs: number } | undefined {
  if (hasRange(cue.startMs) && hasRange(cue.endMs) && (cue.endMs as number) > (cue.startMs as number)) {
    return clampCover(cue.startMs as number, cue.endMs as number);
  }
  if (cue.topic?.trim()) {
    const title = cue.topic.trim();
    const chapter = chapters.find((item) => item.title === title);
    if (chapter) {
      return clampCover(chapter.startMs, chapter.endMs);
    }
    const hit = kept.find((clip) => clip.text.includes(title));
    if (hit) {
      return clampCover(hit.startMs, hit.endMs);
    }
  }
  if (kept.length === 0) {
    return undefined;
  }
  const first = kept[0];
  const last = kept[kept.length - 1];
  if (!first || !last) {
    return undefined;
  }
  return clampCover(first.startMs, Math.min(last.endMs, first.startMs + MAX_COVER_MS));
}

function clampCover(startMs: number, endMs: number): { startMs: number; endMs: number } {
  const start = Math.max(0, startMs);
  const end = Math.max(start + MIN_COVER_MS, Math.min(endMs, start + MAX_COVER_MS));
  return { startMs: start, endMs: end };
}

function editedRange(
  kept: ScoredClip[],
  sourceStartMs: number,
  sourceEndMs: number,
): { timelineIn: number; durationSec: number } | undefined {
  let timelineMs = 0;
  let start: number | undefined;
  let end: number | undefined;
  for (const clip of kept) {
    const clipDuration = durationOf(clip);
    const overlapStart = Math.max(sourceStartMs, clip.startMs);
    const overlapEnd = Math.min(sourceEndMs, clip.endMs);
    if (overlapEnd > overlapStart) {
      const localStart = timelineMs + (overlapStart - clip.startMs);
      const localEnd = timelineMs + (overlapEnd - clip.startMs);
      start = start === undefined ? localStart : Math.min(start, localStart);
      end = end === undefined ? localEnd : Math.max(end, localEnd);
    }
    timelineMs += clipDuration;
  }
  if (start === undefined || end === undefined || end - start < MIN_COVER_MS) {
    return undefined;
  }
  const durationMs = Math.min(MAX_COVER_MS, end - start);
  return {
    timelineIn: round3(start / 1000),
    durationSec: round3(durationMs / 1000),
  };
}

function mergeNeeds(needs: CoverNeed[]): CoverNeed[] {
  const ordered = [...needs].sort((a, b) => {
    if (a.startMs !== b.startMs) {
      return a.startMs - b.startMs;
    }
    return motiveRank(b.motive) - motiveRank(a.motive);
  });
  const merged: CoverNeed[] = [];
  for (const need of ordered) {
    const previous = merged[merged.length - 1];
    if (previous && overlaps(previous, need)) {
      const winner =
        motiveRank(need.motive) > motiveRank(previous.motive) ? need : previous;
      previous.startMs = Math.min(previous.startMs, need.startMs);
      previous.endMs = Math.max(previous.endMs, need.endMs);
      previous.motive = winner.motive;
      previous.confidence = Math.max(previous.confidence, need.confidence);
      previous.label = unique([previous.label, need.label]).join(" / ");
      continue;
    }
    merged.push({ ...need });
  }
  return merged;
}

function overlaps(a: CoverNeed, b: CoverNeed): boolean {
  return a.startMs < b.endMs && b.startMs < a.endMs;
}

function motiveRank(motive: BrollMotive): number {
  switch (motive) {
    case "omni_cue":
      return 3;
    case "jump_cut":
      return 2;
    case "topic_visual":
      return 1;
    default: {
      const _never: never = motive;
      return _never;
    }
  }
}

function motiveLabel(motive: BrollMotive): string {
  switch (motive) {
    case "omni_cue":
      return "Omni";
    case "jump_cut":
      return "ジャンプカット";
    case "topic_visual":
      return "トピック";
    default: {
      const _never: never = motive;
      return _never;
    }
  }
}

function cueFromUnknown(value: unknown): BrollCue | undefined {
  if (typeof value === "string") {
    return cueFromText(value);
  }
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const row = value as Record<string, unknown>;
  const tag = typeof row.tag === "string" ? row.tag : asString(row.reason);
  if (tag && !isBrollTag(tag)) {
    return undefined;
  }
  const startMs = optionalMs(row.startMs ?? row.start);
  const endMs = optionalMs(row.endMs ?? row.end);
  const topic = asString(row.topic) || asString(row.label) || undefined;
  return {
    tag: BROLL_TAG,
    startMs,
    endMs,
    topic,
  };
}

function cueFromText(text: string): BrollCue | undefined {
  const trimmed = text.trim();
  if (!isBrollTag(trimmed) && !/^B_ROLL_RECOMMENDED\b/i.test(trimmed)) {
    return undefined;
  }
  const topicMatch = trimmed.match(
    /B_ROLL_RECOMMENDED\s*[:：]\s*(.+)$/i,
  );
  const rangeMatch = trimmed.match(
    /(\d+(?:\.\d+)?)\s*[-–〜~]\s*(\d+(?:\.\d+)?)/,
  );
  let startMs: number | undefined;
  let endMs: number | undefined;
  if (rangeMatch) {
    const start = Number(rangeMatch[1]);
    const end = Number(rangeMatch[2]);
    if (Number.isFinite(start) && Number.isFinite(end) && end > start) {
      startMs = start > 1000 ? start : Math.round(start * 1000);
      endMs = end > 1000 ? end : Math.round(end * 1000);
    }
  }
  const topic = topicMatch?.[1]?.replace(rangeMatch?.[0] ?? "", "").trim();
  return {
    tag: BROLL_TAG,
    startMs,
    endMs,
    topic: topic || undefined,
  };
}

function isBrollTag(value: string): boolean {
  return value.trim().toUpperCase() === BROLL_TAG;
}

function hasRange(value: number | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function optionalMs(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return undefined;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function dedupeCues(cues: BrollCue[]): BrollCue[] {
  const seen = new Set<string>();
  const uniqueCues: BrollCue[] = [];
  for (const cue of cues) {
    const key = `${cue.startMs ?? ""}:${cue.endMs ?? ""}:${cue.topic ?? ""}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    uniqueCues.push(cue);
  }
  return uniqueCues;
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))];
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}
