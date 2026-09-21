import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const PCM_SAMPLE_RATE = 16_000;
export const BOUNDARY_SEARCH_MS = 250;
export const MOCK_SPEECH_INSET_MS = 32;
export const MIN_KEEP_MS = 80;
export const ZERO_CROSS_WINDOW_MS = 12;
export const VAD_FRAME_MS = 20;
export const MOCK_TONE_HZ = 440;

const SILENCE_DETECT_FILTER = "silencedetect=n=-35dB:d=0.06";
export const PCM_MAX_BUFFER = 32 * 1024 * 1024;
const USER_MEDIA_PROTOCOL_WHITELIST = "file,crypto,data";
const USER_MEDIA_FORMAT_WHITELIST =
  "mov,mp4,m4a,3gp,3g2,mj2,matroska,webm,avi,wav,mp3,aac,flac,ogg,mpeg,mpegts,asf";
const PCM_SLICE_BYTES = 24 * 1024 * 1024;
export const PCM_SLICE_MS = Math.floor(
  (PCM_SLICE_BYTES / (PCM_SAMPLE_RATE * 2)) * 1000,
);
const MIN_SPEECH_MS = 40;
const SILENCE_PAD_MS = 8;

export type TimeRange = {
  startMs: number;
  endMs: number;
};

export type WaveformSource = "ffmpeg" | "mock";

export type Waveform = {
  sampleRate: number;
  samples: Int16Array;
  durationMs: number;
  source: WaveformSource;
  silences: TimeRange[];
  speech: TimeRange[];
};

export type BoundarySide = "start" | "end";

export type BoundaryTrace = {
  semanticMs: number;
  vadMs: number;
  silenceMs: number;
  zeroCrossMs: number;
  actualMs: number;
};

export type BoundaryClip = {
  startMs: number;
  endMs: number;
  role?: string;
  verdict?: "keep" | "cut" | "review";
  verdictSource?: "code" | "user";
  semanticStartMs?: number;
  semanticEndMs?: number;
};

export type BoundaryUnit = {
  startMs: number;
  endMs: number;
  role?: string;
};

export function parseSilenceDetect(stderr: string): TimeRange[] {
  const ranges: TimeRange[] = [];
  let openStart: number | undefined;
  for (const line of stderr.split(/\r?\n/)) {
    const startMatch = line.match(/silence_start:\s*([0-9.]+)/i);
    if (startMatch) {
      openStart = Number(startMatch[1]) * 1000;
      continue;
    }
    const endMatch = line.match(/silence_end:\s*([0-9.]+)/i);
    if (endMatch && openStart !== undefined) {
      const endMs = Number(endMatch[1]) * 1000;
      if (Number.isFinite(openStart) && Number.isFinite(endMs) && endMs > openStart) {
        ranges.push({ startMs: Math.round(openStart), endMs: Math.round(endMs) });
      }
      openStart = undefined;
    }
  }
  return mergeRanges(ranges);
}

export function speechFromEnergy(
  samples: Int16Array,
  sampleRate: number,
): TimeRange[] {
  if (samples.length === 0 || sampleRate <= 0) {
    return [];
  }
  const frameSize = Math.max(1, Math.round((sampleRate * VAD_FRAME_MS) / 1000));
  const energies: number[] = [];
  for (let offset = 0; offset + frameSize <= samples.length; offset += frameSize) {
    energies.push(frameRms(samples, offset, frameSize));
  }
  if (energies.length === 0) {
    return [];
  }
  const sorted = [...energies].sort((a, b) => a - b);
  const noise = sorted[Math.floor(sorted.length * 0.2)] ?? 0;
  const peak = sorted[sorted.length - 1] ?? 0;
  const threshold = Math.max(800, Math.min(Math.max(noise * 3.5, 800), peak * 0.2));
  const voiced = energies.map((energy) => energy >= threshold);
  let pending = 0;
  for (let index = 0; index < voiced.length; index += 1) {
    if (voiced[index]) {
      pending = 2;
    } else if (pending > 0) {
      voiced[index] = true;
      pending -= 1;
    }
  }
  const regions: TimeRange[] = [];
  let startFrame: number | undefined;
  for (let index = 0; index <= voiced.length; index += 1) {
    const active = index < voiced.length && voiced[index];
    if (active && startFrame === undefined) {
      startFrame = index;
    } else if (!active && startFrame !== undefined) {
      const startMs = Math.round((startFrame * frameSize * 1000) / sampleRate);
      const endMs = Math.round((index * frameSize * 1000) / sampleRate);
      if (endMs - startMs >= MIN_SPEECH_MS) {
        regions.push({ startMs, endMs });
      }
      startFrame = undefined;
    }
  }
  return mergeRanges(regions, 40);
}

export function nearestZeroCrossing(
  samples: Int16Array,
  sampleRate: number,
  timeMs: number,
  windowMs = ZERO_CROSS_WINDOW_MS,
): number {
  if (samples.length < 2 || sampleRate <= 0) {
    return Math.round(timeMs);
  }
  const center = clamp(
    Math.round((timeMs / 1000) * sampleRate),
    0,
    samples.length - 2,
  );
  const radius = Math.max(1, Math.round((windowMs / 1000) * sampleRate));
  const from = Math.max(0, center - radius);
  const to = Math.min(samples.length - 2, center + radius);
  let bestIndex = center;
  let bestDist = Number.POSITIVE_INFINITY;
  for (let index = from; index <= to; index += 1) {
    const current = samples[index] ?? 0;
    const next = samples[index + 1] ?? 0;
    if (current === 0 || current * next <= 0) {
      const chosen =
        current === 0 || Math.abs(current) <= Math.abs(next) ? index : index + 1;
      const dist = Math.abs(chosen - center);
      if (dist < bestDist) {
        bestDist = dist;
        bestIndex = chosen;
      }
    }
  }
  return Math.round((bestIndex / sampleRate) * 1000);
}

export function mockWaveform(input: {
  durationMs: number;
  units: BoundaryUnit[];
}): Waveform {
  const durationMs = Math.max(0, Math.round(input.durationMs));
  const speech = mockSpeechRegions(input.units, durationMs);
  const silences = complementRanges(speech, durationMs);
  const samples = synthesizePcm(speech, durationMs, PCM_SAMPLE_RATE);
  return {
    sampleRate: PCM_SAMPLE_RATE,
    samples,
    durationMs,
    source: "mock",
    silences,
    speech,
  };
}

export function waveformFromPcm(input: {
  samples: Int16Array;
  sampleRate: number;
  source?: WaveformSource;
  silences?: TimeRange[];
}): Waveform {
  const durationMs =
    input.sampleRate > 0
      ? Math.round((input.samples.length / input.sampleRate) * 1000)
      : 0;
  const speech = speechFromEnergy(input.samples, input.sampleRate);
  const silences =
    input.silences && input.silences.length > 0
      ? mergeRanges(input.silences)
      : complementRanges(speech, durationMs);
  return {
    sampleRate: input.sampleRate,
    samples: input.samples,
    durationMs,
    source: input.source ?? "ffmpeg",
    silences,
    speech,
  };
}

export function planPcmSlices(input: {
  durationMs: number;
  ranges?: TimeRange[];
}): TimeRange[] {
  const durationMs = Math.max(0, Math.round(input.durationMs));
  const windows =
    input.ranges && input.ranges.length > 0
      ? mergeRanges(
          input.ranges.map((range) => ({
            startMs: Math.max(0, Math.round(range.startMs)),
            endMs: Math.min(durationMs || range.endMs, Math.round(range.endMs)),
          })),
          80,
        ).filter((range) => range.endMs > range.startMs)
      : durationMs > 0
        ? [{ startMs: 0, endMs: durationMs }]
        : [];
  const slices: TimeRange[] = [];
  for (const window of windows) {
    let cursor = window.startMs;
    while (cursor < window.endMs) {
      const endMs = Math.min(window.endMs, cursor + PCM_SLICE_MS);
      slices.push({ startMs: cursor, endMs });
      if (endMs <= cursor) {
        break;
      }
      cursor = endMs;
    }
  }
  return slices;
}

export function pcmByteLength(durationMs: number): number {
  return Math.max(0, Math.round((durationMs / 1000) * PCM_SAMPLE_RATE) * 2);
}

export async function loadWaveform(input: {
  filePath?: string;
  durationMs?: number;
  units?: BoundaryUnit[];
  ranges?: TimeRange[];
}): Promise<Waveform> {
  const units = input.units ?? [];
  const fallbackDuration =
    input.durationMs && input.durationMs > 0
      ? input.durationMs
      : lastUnitEnd(units);
  const fallback = () =>
    mockWaveform({ durationMs: fallbackDuration, units });
  if (!input.filePath) {
    return fallback();
  }
  try {
    const durationMs =
      input.durationMs && input.durationMs > 0
        ? input.durationMs
        : (await probeDurationMs(input.filePath)) || fallbackDuration;
    const pcm = await extractPcm(input.filePath, durationMs, input.ranges);
    const detected = await detectSilences(input.filePath);
    const wave = waveformFromPcm({
      samples: pcm,
      sampleRate: PCM_SAMPLE_RATE,
      source: "ffmpeg",
      silences: detected,
    });
    if (isUninformativeWaveform(wave)) {
      return fallback();
    }
    return wave;
  } catch {
    return fallback();
  }
}

export function isUninformativeWaveform(wave: Waveform): boolean {
  if (wave.durationMs < 200) {
    return false;
  }
  const silenceMs = wave.silences.reduce(
    (sum, range) => sum + Math.max(0, range.endMs - range.startMs),
    0,
  );
  if (silenceMs < wave.durationMs * 0.04) {
    return true;
  }
  return wave.speech.length <= 1 && silenceMs < 200;
}

export function resolveBoundary(input: {
  semanticMs: number;
  side: BoundarySide;
  waveform: Waveform;
  minMs: number;
  maxMs: number;
}): BoundaryTrace {
  const semanticMs = Math.round(input.semanticMs);
  const vadMs = vadEdge(input.waveform.speech, semanticMs, input.side);
  const silenceMs = silenceEdge(
    input.waveform.silences,
    vadMs,
    input.side,
  );
  const zeroCrossMs = nearestZeroCrossing(
    input.waveform.samples,
    input.waveform.sampleRate,
    silenceMs,
  );
  const actualMs = clamp(Math.round(zeroCrossMs), input.minMs, input.maxMs);
  return {
    semanticMs,
    vadMs,
    silenceMs,
    zeroCrossMs,
    actualMs,
  };
}

export function snapKeepClips<T extends BoundaryClip>(
  clips: T[],
  waveform: Waveform,
): T[] {
  const durationMs = waveform.durationMs || lastUnitEnd(clips);
  const next = clips.map((clip) => ({ ...clip }));
  const keepIndexes = next
    .map((clip, index) => ({ clip, index }))
    .filter((item) => isKeepClip(item.clip))
    .sort(
      (a, b) =>
        semanticRange(a.clip).startMs - semanticRange(b.clip).startMs,
    );
  let previousEnd = 0;
  for (let order = 0; order < keepIndexes.length; order += 1) {
    const current = keepIndexes[order];
    const clip = next[current.index];
    if (!clip) {
      continue;
    }
    const semantic = semanticRange(clip);
    if (clip.verdictSource === "user") {
      next[current.index] = {
        ...clip,
        semanticStartMs: semantic.startMs,
        semanticEndMs: semantic.endMs,
      };
      previousEnd = Math.max(previousEnd, next[current.index]?.endMs ?? previousEnd);
      continue;
    }
    const following = keepIndexes[order + 1]?.clip;
    const nextStart = following ? semanticRange(following).startMs : durationMs;
    const maxStart = Math.max(
      previousEnd,
      Math.min(semantic.endMs - MIN_KEEP_MS, nextStart - MIN_KEEP_MS),
    );
    const start = resolveBoundary({
      semanticMs: semantic.startMs,
      side: "start",
      waveform,
      minMs: previousEnd,
      maxMs: Math.max(previousEnd, maxStart),
    });
    const minEnd = Math.min(durationMs, start.actualMs + MIN_KEEP_MS);
    const end = resolveBoundary({
      semanticMs: semantic.endMs,
      side: "end",
      waveform,
      minMs: minEnd,
      maxMs: Math.max(minEnd, nextStart),
    });
    let actualStart = start.actualMs;
    let actualEnd = end.actualMs;
    if (actualEnd <= actualStart) {
      actualStart = semantic.startMs;
      actualEnd = Math.max(semantic.endMs, actualStart + MIN_KEEP_MS);
    }
    next[current.index] = {
      ...clip,
      semanticStartMs: semantic.startMs,
      semanticEndMs: semantic.endMs,
      startMs: actualStart,
      endMs: Math.min(durationMs || actualEnd, actualEnd),
    };
    previousEnd = next[current.index]?.endMs ?? previousEnd;
  }
  return next;
}

export async function applyAudioBoundaries<T extends BoundaryClip>(
  clips: T[],
  options: { filePath?: string; durationMs?: number } = {},
): Promise<T[]> {
  const waveform = await loadWaveform({
    filePath: options.filePath,
    durationMs: options.durationMs,
    units: clips,
    ranges: keepDecodeRanges(clips),
  });
  return snapKeepClips(clips, waveform);
}

function isKeepClip(clip: BoundaryClip): boolean {
  switch (clip.verdict) {
    case "cut":
    case "review":
      return false;
    case "keep":
    case undefined:
      return true;
    default: {
      const _never: never = clip.verdict;
      return _never;
    }
  }
}

function semanticRange(clip: BoundaryClip): TimeRange {
  return {
    startMs: clip.semanticStartMs ?? clip.startMs,
    endMs: clip.semanticEndMs ?? clip.endMs,
  };
}

function vadEdge(
  speech: TimeRange[],
  semanticMs: number,
  side: BoundarySide,
): number {
  const window = searchWindow(semanticMs);
  switch (side) {
    case "start": {
      const containing = speech.find((range) => contains(range, semanticMs));
      if (containing && containing.startMs >= window.startMs) {
        return containing.startMs;
      }
      const onset = nearestBy(
        speech.filter(
          (range) =>
            range.startMs >= window.startMs && range.startMs <= window.endMs,
        ),
        (range) => range.startMs,
        semanticMs,
      );
      return onset?.startMs ?? semanticMs;
    }
    case "end": {
      const containing = speech.find((range) => contains(range, semanticMs));
      if (containing && containing.endMs <= window.endMs) {
        return containing.endMs;
      }
      const offset = nearestBy(
        speech.filter(
          (range) =>
            range.endMs >= window.startMs && range.endMs <= window.endMs,
        ),
        (range) => range.endMs,
        semanticMs,
      );
      return offset?.endMs ?? semanticMs;
    }
    default: {
      const _never: never = side;
      return _never;
    }
  }
}

function silenceEdge(
  silences: TimeRange[],
  vadMs: number,
  side: BoundarySide,
): number {
  const window = searchWindow(vadMs);
  switch (side) {
    case "start": {
      const before = silences.find(
        (range) =>
          range.endMs >= window.startMs &&
          range.startMs <= vadMs &&
          range.endMs <= window.endMs + SILENCE_PAD_MS,
      );
      const covering = silences.find((range) => contains(range, vadMs));
      const range = covering ?? before;
      if (!range) {
        return vadMs;
      }
      const padded = vadMs - SILENCE_PAD_MS;
      if (contains(range, padded)) {
        return padded;
      }
      return clamp(range.endMs, window.startMs, vadMs);
    }
    case "end": {
      const after = silences.find(
        (range) => range.startMs <= window.endMs && range.endMs >= vadMs,
      );
      const covering = silences.find((range) => contains(range, vadMs));
      const range = covering ?? after;
      if (!range) {
        return vadMs;
      }
      const padded = vadMs + SILENCE_PAD_MS;
      if (contains(range, padded)) {
        return padded;
      }
      return clamp(range.startMs, vadMs, window.endMs);
    }
    default: {
      const _never: never = side;
      return _never;
    }
  }
}

function mockSpeechRegions(units: BoundaryUnit[], durationMs: number): TimeRange[] {
  if (units.length === 0) {
    return durationMs > MOCK_SPEECH_INSET_MS * 2
      ? [
          {
            startMs: MOCK_SPEECH_INSET_MS,
            endMs: Math.max(MOCK_SPEECH_INSET_MS + MIN_SPEECH_MS, durationMs - MOCK_SPEECH_INSET_MS),
          },
        ]
      : durationMs > 0
        ? [{ startMs: 0, endMs: durationMs }]
        : [];
  }
  const regions: TimeRange[] = [];
  for (const unit of units) {
    if (!isVoicedUnit(unit)) {
      continue;
    }
    const span = unit.endMs - unit.startMs;
    const inset = span > MOCK_SPEECH_INSET_MS * 2 + MIN_SPEECH_MS ? MOCK_SPEECH_INSET_MS : 0;
    const startMs = Math.max(0, unit.startMs + inset);
    const endMs = Math.max(startMs + MIN_SPEECH_MS, unit.endMs - inset);
    regions.push({
      startMs,
      endMs: Math.min(durationMs || endMs, endMs),
    });
  }
  return mergeRanges(regions, 20);
}

function isVoicedUnit(unit: BoundaryUnit): boolean {
  return unit.role !== "pause";
}

function synthesizePcm(
  speech: TimeRange[],
  durationMs: number,
  sampleRate: number,
): Int16Array {
  const count = Math.max(0, Math.round((durationMs / 1000) * sampleRate));
  const samples = new Int16Array(count);
  const omega = (2 * Math.PI * MOCK_TONE_HZ) / sampleRate;
  for (let index = 0; index < count; index += 1) {
    const ms = (index / sampleRate) * 1000;
    if (!speech.some((range) => contains(range, ms))) {
      continue;
    }
    samples[index] = Math.round(Math.sin(omega * index) * 8000);
  }
  return samples;
}

function keepDecodeRanges(clips: BoundaryClip[]): TimeRange[] {
  const pad = BOUNDARY_SEARCH_MS + ZERO_CROSS_WINDOW_MS;
  return clips.filter(isKeepClip).map((clip) => {
    const semantic = semanticRange(clip);
    return {
      startMs: semantic.startMs - pad,
      endMs: semantic.endMs + pad,
    };
  });
}

function userMediaOpenArgs(): string[] {
  return [
    "-protocol_whitelist",
    USER_MEDIA_PROTOCOL_WHITELIST,
    "-format_whitelist",
    USER_MEDIA_FORMAT_WHITELIST,
  ];
}

async function probeDurationMs(filePath: string): Promise<number> {
  const { stdout } = await execFileAsync("ffprobe", [
    ...userMediaOpenArgs(),
    "-v",
    "error",
    "-show_entries",
    "format=duration",
    "-of",
    "json",
    filePath,
  ]);
  const parsed = JSON.parse(String(stdout)) as { format?: { duration?: string } };
  const seconds = Number(parsed.format?.duration ?? 0);
  return Number.isFinite(seconds) ? Math.round(seconds * 1000) : 0;
}

async function extractPcm(
  filePath: string,
  durationMs: number,
  ranges?: TimeRange[],
): Promise<Int16Array> {
  const slices = planPcmSlices({ durationMs, ranges });
  const total = Math.max(0, Math.round((durationMs / 1000) * PCM_SAMPLE_RATE));
  const samples = new Int16Array(total);
  for (const slice of slices) {
    const pcm = await extractPcmSlice(filePath, slice.startMs, slice.endMs);
    const offset = Math.round((slice.startMs / 1000) * PCM_SAMPLE_RATE);
    const room = samples.length - offset;
    if (room <= 0) {
      continue;
    }
    samples.set(pcm.subarray(0, Math.min(pcm.length, room)), offset);
  }
  return samples;
}

async function extractPcmSlice(
  filePath: string,
  startMs: number,
  endMs: number,
): Promise<Int16Array> {
  const { stdout } = await execFileAsync(
    "ffmpeg",
    [
      "-hide_banner",
      "-loglevel",
      "error",
      ...userMediaOpenArgs(),
      "-i",
      filePath,
      "-ss",
      (Math.max(0, startMs) / 1000).toFixed(3),
      "-to",
      (Math.max(0, endMs) / 1000).toFixed(3),
      "-vn",
      "-ac",
      "1",
      "-ar",
      String(PCM_SAMPLE_RATE),
      "-f",
      "s16le",
      "-acodec",
      "pcm_s16le",
      "pipe:1",
    ],
    { encoding: "buffer", maxBuffer: PCM_MAX_BUFFER },
  );
  return new Int16Array(
    stdout.buffer,
    stdout.byteOffset,
    Math.floor(stdout.byteLength / 2),
  );
}

async function detectSilences(filePath: string): Promise<TimeRange[]> {
  try {
    const { stderr } = await execFileAsync(
      "ffmpeg",
      [
        "-hide_banner",
        ...userMediaOpenArgs(),
        "-i",
        filePath,
        "-af",
        SILENCE_DETECT_FILTER,
        "-f",
        "null",
        "-",
      ],
      { encoding: "utf8" },
    );
    return parseSilenceDetect(stderr);
  } catch (error) {
    const stderr =
      error && typeof error === "object" && "stderr" in error
        ? String((error as { stderr?: string }).stderr ?? "")
        : "";
    return parseSilenceDetect(stderr);
  }
}

function searchWindow(centerMs: number): TimeRange {
  return {
    startMs: centerMs - BOUNDARY_SEARCH_MS,
    endMs: centerMs + BOUNDARY_SEARCH_MS,
  };
}

function contains(range: TimeRange, timeMs: number): boolean {
  return timeMs >= range.startMs && timeMs <= range.endMs;
}

function nearestBy<T>(
  items: T[],
  valueOf: (item: T) => number,
  target: number,
): T | undefined {
  let best: T | undefined;
  let bestDist = Number.POSITIVE_INFINITY;
  for (const item of items) {
    const dist = Math.abs(valueOf(item) - target);
    if (dist < bestDist) {
      bestDist = dist;
      best = item;
    }
  }
  return best;
}

function mergeRanges(ranges: TimeRange[], joinGapMs = 0): TimeRange[] {
  const sorted = [...ranges]
    .filter((range) => range.endMs > range.startMs)
    .sort((a, b) => a.startMs - b.startMs);
  const merged: TimeRange[] = [];
  for (const range of sorted) {
    const last = merged[merged.length - 1];
    if (last && range.startMs <= last.endMs + joinGapMs) {
      last.endMs = Math.max(last.endMs, range.endMs);
    } else {
      merged.push({ ...range });
    }
  }
  return merged;
}

function complementRanges(ranges: TimeRange[], durationMs: number): TimeRange[] {
  const merged = mergeRanges(ranges);
  const gaps: TimeRange[] = [];
  let cursor = 0;
  for (const range of merged) {
    if (range.startMs > cursor) {
      gaps.push({ startMs: cursor, endMs: range.startMs });
    }
    cursor = Math.max(cursor, range.endMs);
  }
  if (cursor < durationMs) {
    gaps.push({ startMs: cursor, endMs: durationMs });
  }
  return gaps;
}

function lastUnitEnd(units: { endMs: number }[]): number {
  return units.reduce((max, unit) => Math.max(max, unit.endMs), 0);
}

function frameRms(samples: Int16Array, offset: number, length: number): number {
  let sum = 0;
  for (let index = 0; index < length; index += 1) {
    const value = samples[offset + index] ?? 0;
    sum += value * value;
  }
  return Math.sqrt(sum / length);
}

function clamp(value: number, min: number, max: number): number {
  if (max < min) {
    return min;
  }
  return Math.min(max, Math.max(min, value));
}
