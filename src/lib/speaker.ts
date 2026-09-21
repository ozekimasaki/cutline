import type {
  SpeakerAssignment,
  SpeakerAssignmentSource,
  SpeakerId,
  TimelineIR,
  TranscriptCue,
} from "./types";

/** Spec §8: diarization is recommended within 2 hours. */
export const DIARIZATION_RECOMMENDED_MAX_MS = 2 * 60 * 60 * 1000;

export type SpeakerPlanMode = "per-mic" | "mix-diarization" | "mix";

export type SpeakerSourceInput = {
  fileName: string;
  filePath?: string;
  role?: string;
  audioChannels?: number | null;
};

export type SpeakerPlan = {
  mode: SpeakerPlanMode;
  diarizationEnabled: boolean;
  speakerCount?: number;
  channelId: number[];
  speakers: SpeakerAssignment[];
  notes: string[];
};

export type FiletransParameters = {
  channel_id: number[];
  diarization_enabled?: boolean;
  speaker_count?: number;
};

export type MicTranscript = {
  speakerId: SpeakerId;
  cues: TranscriptCue[];
};

export function speakerIdFromIndex(index: number): SpeakerId {
  if (!Number.isFinite(index) || index < 0) {
    return "A";
  }
  let n = Math.floor(index);
  let label = "";
  do {
    label = String.fromCharCode(65 + (n % 26)) + label;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return label;
}

export function parseSpeakerCountHint(value: unknown): number | undefined {
  if (value == null || value === "") {
    return undefined;
  }
  const raw = typeof value === "number" ? value : Number(String(value).trim());
  if (!Number.isInteger(raw) || raw < 2 || raw > 100) {
    return undefined;
  }
  return raw;
}

export function normalizeSpeakerId(raw: string): SpeakerId {
  const trimmed = raw.trim();
  if (!trimmed) {
    return "A";
  }
  const named = trimmed.match(/^speaker[-_\s]?([A-Za-z]+)$/i);
  if (named?.[1]) {
    return named[1].toUpperCase();
  }
  const numbered = trimmed.match(/^(?:speaker[-_\s]?)?(\d+)$/i);
  if (numbered) {
    return speakerIdFromIndex(Number(numbered[1]));
  }
  if (/^[A-Za-z]+$/.test(trimmed)) {
    return trimmed.toUpperCase();
  }
  return trimmed;
}

export function speakerIdFromDiarizationIndex(value: unknown): SpeakerId {
  if (typeof value === "string") {
    return normalizeSpeakerId(value);
  }
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) {
    return speakerIdFromIndex(value);
  }
  return "A";
}

export function micIndexFromSource(source: SpeakerSourceInput): number | undefined {
  const fromRole = micIndexFromToken(source.role ?? "");
  if (fromRole != null) {
    return fromRole;
  }
  const stem = fileStem(source.fileName);
  if (isCameraStem(stem)) {
    return undefined;
  }
  return micIndexFromToken(stem);
}

export function collectMicTracks(sources: SpeakerSourceInput[]): SpeakerAssignment[] {
  const found: { index: number; source: SpeakerSourceInput }[] = [];
  for (const source of sources) {
    const index = micIndexFromSource(source);
    if (index == null) {
      continue;
    }
    found.push({ index, source });
  }
  found.sort(
    (a, b) =>
      a.index - b.index || a.source.fileName.localeCompare(b.source.fileName),
  );
  const seen = new Set<number>();
  const tracks: SpeakerAssignment[] = [];
  for (const item of found) {
    if (seen.has(item.index)) {
      continue;
    }
    seen.add(item.index);
    tracks.push({
      id: speakerIdFromIndex(item.index),
      source: "mic",
      fileName: item.source.fileName,
      filePath: item.source.filePath,
      micIndex: item.index,
    });
  }
  return tracks;
}

export function planSpeakerProcessing(input: {
  sources?: SpeakerSourceInput[];
  mixChannels?: number | null;
  speakerCountHint?: number;
  durationMs?: number;
}): SpeakerPlan {
  const mics = collectMicTracks(input.sources ?? []);
  const hint = parseSpeakerCountHint(input.speakerCountHint);
  if (mics.length > 0) {
    return {
      mode: "per-mic",
      diarizationEnabled: false,
      channelId: [0],
      speakers: mics,
      notes: [
        `個別Micを信頼: ${mics
          .map((mic) => `${micLabel(mic)}→Speaker ${mic.id}`)
          .join(" / ")}。AI話者推定は使わない。Jev は話者を選ばない。`,
      ],
    };
  }

  const multiChannel =
    typeof input.mixChannels === "number" && input.mixChannels > 1;
  if (multiChannel) {
    return {
      mode: "mix",
      diarizationEnabled: false,
      channelId: [0],
      speakers: defaultTwoSpeakers("mix"),
      notes: [
        "mix が multi-channel のため Qwen Audio diarization は使わない（mono 専用で同時利用不可）。Jev は話者を選ばない。",
      ],
    };
  }

  const notes = [
    "mix 音声のため diarization_enabled=true。Jev は話者を選ばない。",
  ];
  if (hint != null) {
    notes.push(`speaker_count=${hint} をヒントとして指定。`);
  }
  if ((input.durationMs ?? 0) > DIARIZATION_RECOMMENDED_MAX_MS) {
    notes.push("diarization は 2 時間以内が推奨。");
  }
  return {
    mode: "mix-diarization",
    diarizationEnabled: true,
    speakerCount: hint,
    channelId: [0],
    speakers:
      hint != null
        ? Array.from({ length: hint }, (_, index) => ({
            id: speakerIdFromIndex(index),
            source: "diarization" as const,
          }))
        : defaultTwoSpeakers("diarization"),
    notes,
  };
}

export function filetransParameters(
  plan: Pick<SpeakerPlan, "diarizationEnabled" | "speakerCount" | "channelId">,
): FiletransParameters {
  if (plan.diarizationEnabled) {
    const parameters: FiletransParameters = {
      channel_id: [0],
      diarization_enabled: true,
    };
    if (plan.speakerCount != null) {
      parameters.speaker_count = plan.speakerCount;
    }
    return parameters;
  }
  return {
    channel_id: plan.channelId.length ? plan.channelId : [0],
  };
}

export function asrCacheKind(plan: SpeakerPlan): string {
  const count = plan.speakerCount ?? "auto";
  return `asr:${plan.mode}:d${plan.diarizationEnabled ? 1 : 0}:n${count}`;
}

export function cuesFromTranscription(payload: unknown): TranscriptCue[] {
  if (!payload || typeof payload !== "object") {
    return [];
  }
  const root = payload as Record<string, unknown>;
  const nested =
    root.transcripts ??
    (root.output && typeof root.output === "object"
      ? (root.output as Record<string, unknown>).transcripts
      : undefined);
  const transcripts = Array.isArray(nested)
    ? nested
    : Array.isArray(root.sentences)
      ? [root]
      : [];
  const cues: TranscriptCue[] = [];
  for (const transcript of transcripts) {
    if (!transcript || typeof transcript !== "object") {
      continue;
    }
    const sentences = (transcript as Record<string, unknown>).sentences;
    if (!Array.isArray(sentences)) {
      continue;
    }
    for (const sentence of sentences) {
      const cue = cueFromSentence(sentence);
      if (cue) {
        cues.push(cue);
      }
    }
  }
  return cues.sort(
    (a, b) => a.startMs - b.startMs || a.endMs - b.endMs,
  );
}

export function mergeMicTranscripts(tracks: MicTranscript[]): TranscriptCue[] {
  const cues = tracks.flatMap((track) =>
    track.cues.map((cue) => ({
      ...cue,
      speaker: track.speakerId,
    })),
  );
  cues.sort(
    (a, b) =>
      a.startMs - b.startMs ||
      a.endMs - b.endMs ||
      a.speaker.localeCompare(b.speaker),
  );
  return cues;
}

export function resolveTranscriptSpeakers(input: {
  cues: TranscriptCue[];
  plan: SpeakerPlan;
  micTranscripts?: MicTranscript[];
}): { cues: TranscriptCue[]; notes: string[] } {
  switch (input.plan.mode) {
    case "per-mic": {
      const notes = [
        "個別Micの話者割り当てを適用。AI話者推定はスキップ。",
      ];
      if (input.micTranscripts && input.micTranscripts.length > 0) {
        return { cues: mergeMicTranscripts(input.micTranscripts), notes };
      }
      return { cues: relabelCues(input.cues), notes };
    }
    case "mix-diarization":
      return {
        cues: relabelCues(input.cues),
        notes: ["mix diarization の speaker_id を A/B/C… に写す。"],
      };
    case "mix":
      return {
        cues: relabelCues(input.cues),
        notes: ["multi-channel mix のため diarization なし。既存ラベルを維持。"],
      };
    default: {
      const _never: never = input.plan.mode;
      return { cues: input.cues, notes: [String(_never)] };
    }
  }
}

export function uniqueSpeakerIds(items: { speaker: string }[]): SpeakerId[] {
  const seen = new Set<string>();
  const ids: SpeakerId[] = [];
  for (const item of items) {
    if (!item.speaker.trim()) {
      continue;
    }
    const id = normalizeSpeakerId(item.speaker);
    if (!id || seen.has(id)) {
      continue;
    }
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

export function perMicAsrJobs(
  plan: SpeakerPlan,
): { speakerId: SpeakerId; filePath: string; fileName: string }[] {
  if (plan.mode !== "per-mic") {
    return [];
  }
  const jobs: { speakerId: SpeakerId; filePath: string; fileName: string }[] =
    [];
  for (const speaker of plan.speakers) {
    if (!speaker.filePath) {
      continue;
    }
    jobs.push({
      speakerId: speaker.id,
      filePath: speaker.filePath,
      fileName: speaker.fileName ?? speaker.id,
    });
  }
  return jobs;
}

export function withTimelineSpeakers(
  timeline: TimelineIR,
  speakers: SpeakerAssignment[],
): TimelineIR {
  const fromClips = uniqueSpeakerIds(timeline.clips).map((id) => {
    const known = speakers.find((speaker) => speaker.id === id);
    return known ?? { id, source: "mix" as const };
  });
  return {
    ...timeline,
    speakers: speakers.length ? speakers : fromClips,
  };
}

function cueFromSentence(sentence: unknown): TranscriptCue | undefined {
  if (!sentence || typeof sentence !== "object") {
    return undefined;
  }
  const row = sentence as Record<string, unknown>;
  const text = typeof row.text === "string" ? row.text.trim() : "";
  if (!text) {
    return undefined;
  }
  const speaker =
    row.speaker_id != null
      ? speakerIdFromDiarizationIndex(row.speaker_id)
      : typeof row.speaker === "string"
        ? normalizeSpeakerId(row.speaker)
        : "A";
  const startMs = asMs(row.begin_time ?? row.startMs);
  const endMs = Math.max(asMs(row.end_time ?? row.endMs), startMs);
  return { speaker, text, startMs, endMs };
}

function relabelCues(cues: TranscriptCue[]): TranscriptCue[] {
  return cues.map((cue) => ({
    ...cue,
    speaker: normalizeSpeakerId(cue.speaker),
  }));
}

function defaultTwoSpeakers(
  source: SpeakerAssignmentSource,
): SpeakerAssignment[] {
  return [
    { id: "A", source },
    { id: "B", source },
  ];
}

function micLabel(mic: SpeakerAssignment): string {
  return mic.fileName ?? `Mic ${ (mic.micIndex ?? 0) + 1 }`;
}

function micIndexFromToken(token: string): number | undefined {
  const normalized = token.trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (!normalized) {
    return undefined;
  }
  const letter = normalized.match(
    /^(?:mic|iso|lav|track|spk|speaker)_([a-z])$/,
  );
  if (letter?.[1]) {
    return letter[1].charCodeAt(0) - 97;
  }
  const numbered = normalized.match(
    /^(?:mic|iso|lav|track|spk|speaker)_?(\d+)$/,
  );
  if (numbered) {
    const n = Number(numbered[1]);
    if (n >= 1) {
      return n - 1;
    }
  }
  return undefined;
}

function isCameraStem(stem: string): boolean {
  return (
    /(?:^|_)(?:cam|camera)(?:_|$)/.test(stem) || /(?:^|_)wide(?:_|$)/.test(stem)
  );
}

function fileStem(fileName: string): string {
  const base = fileName.split(/[\\/]/).pop() ?? fileName;
  return base
    .replace(/\.[^.]+$/, "")
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
}

function asMs(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? Math.round(n) : 0;
}
