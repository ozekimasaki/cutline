import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type SyncMethod =
  | "embedded_timecode"
  | "audio_timecode"
  | "waveform"
  | "manual";

export type SyncableTrack = {
  id: string;
  embeddedTimecodeMs: number | null;
  audioTimecodeMs: number | null;
  audioTimeReferenceSamples?: number | null;
  sampleRate?: number | null;
  manualOffsetMs?: number;
  waveform?: ArrayLike<number>;
  filePath?: string;
};

export type SyncOffset = {
  id: string;
  offsetMs: number;
  method: SyncMethod;
  confidence: number;
};

export type SyncResult = {
  referenceId: string;
  offsets: SyncOffset[];
};

export type WaveformExtractor = (
  filePath: string,
) => Promise<{ samples: ArrayLike<number>; sampleRate: number }>;

export function pickSyncMethod(
  reference: SyncableTrack,
  track: SyncableTrack,
  canWaveform: boolean,
): SyncMethod {
  if (
    reference.embeddedTimecodeMs != null &&
    track.embeddedTimecodeMs != null
  ) {
    return "embedded_timecode";
  }
  if (hasAudioClock(reference) && hasAudioClock(track)) {
    return "audio_timecode";
  }
  if (
    canWaveform &&
    ((reference.waveform && track.waveform) ||
      (Boolean(reference.filePath) && Boolean(track.filePath)))
  ) {
    return "waveform";
  }
  return "manual";
}

export function crossCorrelateLag(
  reference: ArrayLike<number>,
  track: ArrayLike<number>,
  maxLag = Math.max(0, Math.min(reference.length, track.length) - 1),
): { lag: number; score: number } {
  let bestLag = 0;
  let bestScore = Number.NEGATIVE_INFINITY;
  const limit = Math.max(0, maxLag);
  for (let lag = -limit; lag <= limit; lag += 1) {
    const score = normalizedCorrAtLag(reference, track, lag);
    if (score > bestScore) {
      bestScore = score;
      bestLag = lag;
    }
  }
  return { lag: bestLag, score: Number.isFinite(bestScore) ? bestScore : 0 };
}

export function downsampleEnvelope(
  samples: ArrayLike<number>,
  window: number,
): Float32Array {
  const size = Math.max(1, Math.floor(samples.length / Math.max(1, window)));
  const out = new Float32Array(size);
  const hop = Math.max(1, window);
  for (let i = 0; i < size; i += 1) {
    let sum = 0;
    const start = i * hop;
    for (let j = 0; j < hop; j += 1) {
      const value = samples[start + j] ?? 0;
      sum += value * value;
    }
    out[i] = Math.sqrt(sum / hop);
  }
  return out;
}

export function alignWaveforms(
  reference: ArrayLike<number>,
  track: ArrayLike<number>,
  sampleRate: number,
): { offsetMs: number; score: number } {
  const hop =
    sampleRate > 4000 ? Math.round(sampleRate / 100) : 1;
  if (reference.length <= 4096 || hop <= 1) {
    const raw = crossCorrelateLag(reference, track);
    return {
      offsetMs: Math.round((raw.lag / sampleRate) * 1000),
      score: raw.score,
    };
  }
  const envA = downsampleEnvelope(reference, hop);
  const envB = downsampleEnvelope(track, hop);
  const coarse = crossCorrelateLag(envA, envB);
  const center = coarse.lag * hop;
  const refined = crossCorrelateAround(reference, track, center, hop * 2);
  return {
    offsetMs: Math.round((refined.lag / sampleRate) * 1000),
    score: refined.score,
  };
}

export function resolveTrackSync(
  reference: SyncableTrack,
  track: SyncableTrack,
  options: { sampleRate?: number; canWaveform?: boolean } = {},
): SyncOffset {
  const method = pickSyncMethod(
    reference,
    track,
    options.canWaveform ?? Boolean(reference.waveform && track.waveform),
  );
  switch (method) {
    case "embedded_timecode":
      return {
        id: track.id,
        offsetMs:
          (track.embeddedTimecodeMs ?? 0) - (reference.embeddedTimecodeMs ?? 0),
        method,
        confidence: 1,
      };
    case "audio_timecode":
      return {
        id: track.id,
        offsetMs: audioClockOffsetMs(reference, track),
        method,
        confidence: 0.95,
      };
    case "waveform": {
      const sampleRate = options.sampleRate ?? 8000;
      if (!reference.waveform || !track.waveform) {
        return {
          id: track.id,
          offsetMs: track.manualOffsetMs ?? 0,
          method: "manual",
          confidence: track.manualOffsetMs == null ? 0 : 1,
        };
      }
      const aligned = alignWaveforms(
        reference.waveform,
        track.waveform,
        sampleRate,
      );
      return {
        id: track.id,
        offsetMs: aligned.offsetMs,
        method,
        confidence: clamp01(aligned.score),
      };
    }
    case "manual":
      return {
        id: track.id,
        offsetMs: track.manualOffsetMs ?? 0,
        method,
        confidence: track.manualOffsetMs == null ? 0 : 1,
      };
    default: {
      const _never: never = method;
      return _never;
    }
  }
}

export async function syncTracks(
  tracks: SyncableTrack[],
  options: {
    referenceId?: string;
    extractWaveform?: WaveformExtractor;
    sampleRate?: number;
  } = {},
): Promise<SyncResult> {
  if (tracks.length === 0) {
    return { referenceId: "mix", offsets: [] };
  }
  const reference =
    tracks.find((track) => track.id === options.referenceId) ?? tracks[0];
  if (!reference) {
    return { referenceId: "mix", offsets: [] };
  }
  const loaded = [...tracks];
  const needsWaveform = loaded.some(
    (track) =>
      track.id !== reference.id &&
      pickSyncMethod(reference, track, Boolean(options.extractWaveform)) ===
        "waveform" &&
      (!reference.waveform || !track.waveform),
  );
  if (needsWaveform && options.extractWaveform) {
    for (const track of loaded) {
      if (track.waveform || !track.filePath) {
        continue;
      }
      const extracted = await options.extractWaveform(track.filePath);
      track.waveform = extracted.samples;
      track.sampleRate = extracted.sampleRate;
    }
  }
  const sampleRate =
    options.sampleRate ?? reference.sampleRate ?? 8000;
  const offsets = loaded.map((track) => {
    if (track.id === reference.id) {
      return {
        id: track.id,
        offsetMs: 0,
        method: referenceMethod(track),
        confidence: 1,
      } satisfies SyncOffset;
    }
    return resolveTrackSync(reference, track, {
      sampleRate: Number(sampleRate) || 8000,
      canWaveform: true,
    });
  });
  return { referenceId: reference.id, offsets };
}

export async function extractWaveform(
  filePath: string,
  options: { durationSec?: number; sampleRate?: number } = {},
): Promise<{ samples: Float32Array; sampleRate: number }> {
  const sampleRate = options.sampleRate ?? 8000;
  const durationSec = options.durationSec ?? 20;
  const { stdout } = await execFileAsync(
    "ffmpeg",
    [
      "-v",
      "error",
      "-i",
      filePath,
      "-t",
      String(durationSec),
      "-ac",
      "1",
      "-ar",
      String(sampleRate),
      "-f",
      "f32le",
      "-acodec",
      "pcm_f32le",
      "pipe:1",
    ],
    { encoding: "buffer", maxBuffer: 32 * 1024 * 1024 },
  );
  const buffer = stdout as unknown as Buffer;
  const aligned = new Float32Array(
    buffer.buffer,
    buffer.byteOffset,
    Math.floor(buffer.byteLength / 4),
  );
  return { samples: new Float32Array(aligned), sampleRate };
}

function referenceMethod(track: SyncableTrack): SyncMethod {
  if (track.embeddedTimecodeMs != null) {
    return "embedded_timecode";
  }
  if (hasAudioClock(track)) {
    return "audio_timecode";
  }
  if (track.waveform) {
    return "waveform";
  }
  return "manual";
}

function hasAudioClock(track: SyncableTrack): boolean {
  return (
    track.audioTimecodeMs != null ||
    (track.audioTimeReferenceSamples != null &&
      track.sampleRate != null &&
      track.sampleRate > 0)
  );
}

function audioClockOffsetMs(
  reference: SyncableTrack,
  track: SyncableTrack,
): number {
  if (reference.audioTimecodeMs != null && track.audioTimecodeMs != null) {
    return track.audioTimecodeMs - reference.audioTimecodeMs;
  }
  const refSamples = reference.audioTimeReferenceSamples;
  const trackSamples = track.audioTimeReferenceSamples;
  const rate = track.sampleRate || reference.sampleRate;
  if (refSamples == null || trackSamples == null || !rate) {
    return track.manualOffsetMs ?? 0;
  }
  return Math.round(((trackSamples - refSamples) / rate) * 1000);
}

function crossCorrelateAround(
  reference: ArrayLike<number>,
  track: ArrayLike<number>,
  center: number,
  radius: number,
): { lag: number; score: number } {
  let bestLag = center;
  let bestScore = Number.NEGATIVE_INFINITY;
  for (let lag = center - radius; lag <= center + radius; lag += 1) {
    const score = normalizedCorrAtLag(reference, track, lag);
    if (score > bestScore) {
      bestScore = score;
      bestLag = lag;
    }
  }
  return { lag: bestLag, score: Number.isFinite(bestScore) ? bestScore : 0 };
}

function normalizedCorrAtLag(
  reference: ArrayLike<number>,
  track: ArrayLike<number>,
  lag: number,
): number {
  let dot = 0;
  let energyA = 0;
  let energyB = 0;
  let count = 0;
  for (let i = 0; i < reference.length; i += 1) {
    const j = i + lag;
    if (j < 0 || j >= track.length) {
      continue;
    }
    const a = reference[i] ?? 0;
    const b = track[j] ?? 0;
    dot += a * b;
    energyA += a * a;
    energyB += b * b;
    count += 1;
  }
  if (count < 4 || energyA === 0 || energyB === 0) {
    return Number.NEGATIVE_INFINITY;
  }
  return dot / Math.sqrt(energyA * energyB);
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.min(1, Math.max(0, value));
}
