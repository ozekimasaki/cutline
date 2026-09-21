import type {
  ConversationTurn,
  ConversationWindow,
  ConversationWindowAnalysis,
  SpeakerId,
  TranscriptCue,
} from "./types";

export const MIN_WINDOW_MS = 30_000;
export const MAX_WINDOW_MS = 90_000;
export const WINDOW_CONTEXT_MS = 30_000;
export const PREFERRED_WINDOW_MS = 60_000;

type TopicSpan = {
  id: string;
  startMs: number;
  endMs: number;
};

export function sliceConversationWindows(input: {
  durationMs: number;
  cues?: Array<{ startMs: number; endMs: number; speaker?: string }>;
  topics?: TopicSpan[];
}): ConversationWindow[] {
  const durationMs = Math.max(0, Math.round(input.durationMs));
  if (durationMs <= 0) {
    return [];
  }

  const cues = [...(input.cues ?? [])].sort((a, b) => a.startMs - b.startMs);
  const topics = [...(input.topics ?? [])].sort((a, b) => a.startMs - b.startMs);
  const hints = splitHints(durationMs, cues, topics);
  const bounds = packTargetBounds(durationMs, hints);

  return bounds.slice(0, -1).map((start, index) => {
    const end = bounds[index + 1] ?? durationMs;
    const topicId = topicIdFor(topics, start, end);
    return withContext(
      {
        id: windowId(index),
        targetStartMs: start,
        targetEndMs: end,
        contextStartMs: start,
        contextEndMs: end,
        topicId,
      },
      durationMs,
    );
  });
}

export function withContext(
  window: ConversationWindow,
  durationMs: number,
): ConversationWindow {
  return {
    ...window,
    contextStartMs: Math.max(0, window.targetStartMs - WINDOW_CONTEXT_MS),
    contextEndMs: Math.min(durationMs, window.targetEndMs + WINDOW_CONTEXT_MS),
  };
}

export function cuesInRange<T extends { startMs: number; endMs: number }>(
  cues: T[],
  startMs: number,
  endMs: number,
): T[] {
  return cues.filter((cue) => cue.endMs > startMs && cue.startMs < endMs);
}

export function windowTranscriptSections(
  cues: TranscriptCue[],
  window: ConversationWindow,
): {
  before: TranscriptCue[];
  target: TranscriptCue[];
  after: TranscriptCue[];
} {
  return {
    before: cuesInRange(cues, window.contextStartMs, window.targetStartMs),
    target: cuesInRange(cues, window.targetStartMs, window.targetEndMs),
    after: cuesInRange(cues, window.targetEndMs, window.contextEndMs),
  };
}

export function mockConversationWindow(input: {
  window: ConversationWindow;
  cues: TranscriptCue[];
}): ConversationWindowAnalysis {
  const { target } = windowTranscriptSections(input.cues, input.window);
  const turns: ConversationTurn[] = target.map((cue) => ({
    speaker: cue.speaker,
    text: cue.text,
    startMs: cue.startMs,
    endMs: cue.endMs,
  }));
  const speakers = uniqueSpeakers(turns);
  const summary =
    turns.map((turn) => turn.text).join(" ").trim() ||
    "この区間に発話はありません。";
  return {
    ...input.window,
    source: "mock",
    summary,
    speakers,
    turns,
  };
}

export function formatWindowPrompt(input: {
  window: ConversationWindow;
  cues: TranscriptCue[];
  fileName: string;
  durationMs: number;
  brief: string;
  storyline?: string;
}): string {
  const { before, target, after } = windowTranscriptSections(
    input.cues,
    input.window,
  );
  const brief = input.brief.trim() || "見どころを残し、間と繰り返しを落とす。";
  return [
    "You are CutLine PASS 2 conversation analysis.",
    "Analyze only the TARGET span. BEFORE and AFTER are context, not the target.",
    "Return JSON only. No markdown. Do not propose KEEP/CUT.",
    `Source file: ${input.fileName}`,
    `Source duration ms: ${input.durationMs}`,
    `Editor brief: ${brief}`,
    input.storyline ? `Global storyline: ${input.storyline}` : "",
    `Window ${input.window.id}`,
    `TARGET ${clock(input.window.targetStartMs)}–${clock(input.window.targetEndMs)} (${input.window.targetStartMs}-${input.window.targetEndMs} ms)`,
    `CONTEXT BEFORE ${clock(input.window.contextStartMs)}–${clock(input.window.targetStartMs)}`,
    `CONTEXT AFTER ${clock(input.window.targetEndMs)}–${clock(input.window.contextEndMs)}`,
    "BEFORE:",
    formatCueBlock(before) || "(none)",
    "TARGET:",
    formatCueBlock(target) || "(none)",
    "AFTER:",
    formatCueBlock(after) || "(none)",
    "Schema:",
    JSON.stringify({
      summary: "what happens in TARGET",
      speakers: ["A"],
      turns: [
        {
          speaker: "A",
          text: "utterance",
          startMs: 0,
          endMs: 0,
        },
      ],
    }),
  ]
    .filter((line) => line.length > 0)
    .join("\n");
}

function packTargetBounds(durationMs: number, hints: number[]): number[] {
  const bounds = [0];
  let cursor = 0;
  while (cursor < durationMs) {
    const remaining = durationMs - cursor;
    if (remaining <= MAX_WINDOW_MS) {
      bounds.push(durationMs);
      break;
    }
    let want = PREFERRED_WINDOW_MS;
    if (remaining - MAX_WINDOW_MS < MIN_WINDOW_MS) {
      want = clamp(
        Math.round(remaining / 2),
        MIN_WINDOW_MS,
        MAX_WINDOW_MS,
      );
    }
    const minEnd = cursor + MIN_WINDOW_MS;
    const maxEnd = Math.min(durationMs, cursor + MAX_WINDOW_MS);
    const snapped = snapToHint(cursor + want, hints, minEnd, maxEnd);
    bounds.push(snapped);
    cursor = snapped;
  }
  return bounds;
}

function splitHints(
  durationMs: number,
  cues: Array<{ startMs: number; endMs: number; speaker?: string }>,
  topics: TopicSpan[],
): number[] {
  const hints = new Set<number>([0, durationMs]);
  for (const topic of topics) {
    hints.add(clamp(Math.round(topic.startMs), 0, durationMs));
    hints.add(clamp(Math.round(topic.endMs), 0, durationMs));
  }
  for (let index = 0; index < cues.length; index += 1) {
    const cue = cues[index];
    const previous = cues[index - 1];
    hints.add(clamp(Math.round(cue.startMs), 0, durationMs));
    hints.add(clamp(Math.round(cue.endMs), 0, durationMs));
    if (previous && previous.speaker && cue.speaker && previous.speaker !== cue.speaker) {
      hints.add(clamp(Math.round(cue.startMs), 0, durationMs));
    }
  }
  return [...hints].sort((a, b) => a - b);
}

function snapToHint(
  ideal: number,
  hints: number[],
  min: number,
  max: number,
): number {
  const inRange = hints.filter((hint) => hint >= min && hint <= max);
  if (inRange.length === 0) {
    return clamp(Math.round(ideal), min, max);
  }
  return inRange.reduce((best, hint) =>
    Math.abs(hint - ideal) < Math.abs(best - ideal) ? hint : best,
  );
}

function topicIdFor(
  topics: TopicSpan[],
  startMs: number,
  endMs: number,
): string | undefined {
  let best: TopicSpan | undefined;
  let bestOverlap = 0;
  for (const topic of topics) {
    const overlap =
      Math.min(topic.endMs, endMs) - Math.max(topic.startMs, startMs);
    if (overlap > bestOverlap) {
      best = topic;
      bestOverlap = overlap;
    }
  }
  return bestOverlap > 0 ? best?.id : undefined;
}

function windowId(index: number): string {
  return `win_${String(index + 1).padStart(2, "0")}`;
}

function uniqueSpeakers(turns: ConversationTurn[]): SpeakerId[] {
  const seen = new Set<SpeakerId>();
  const speakers: SpeakerId[] = [];
  for (const turn of turns) {
    if (seen.has(turn.speaker)) {
      continue;
    }
    seen.add(turn.speaker);
    speakers.push(turn.speaker);
  }
  return speakers;
}

function formatCueBlock(cues: TranscriptCue[]): string {
  return cues
    .map(
      (cue) =>
        `${clock(cue.startMs)} ${cue.speaker}: ${cue.text}`,
    )
    .join("\n");
}

function clock(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
