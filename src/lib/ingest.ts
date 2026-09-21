import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import type { CameraId } from "./types";
import {
  extractWaveform,
  syncTracks,
  type SyncableTrack,
  type SyncResult,
} from "./sync";
import { ensureProxy, type ProxyHeight, type ProxyResult } from "./proxy";

const execFileAsync = promisify(execFile);

export type MediaRole =
  | "cam_a"
  | "cam_b"
  | "cam_wide"
  | "mic_a"
  | "mic_b"
  | "unknown";

export type FfprobeStream = {
  codec_type?: string;
  codec_name?: string;
  avg_frame_rate?: string;
  r_frame_rate?: string;
  width?: number;
  height?: number;
  channels?: number;
  sample_rate?: string;
  duration?: string;
  tags?: Record<string, string>;
  side_data_list?: { type?: string; timecode?: string }[];
};

export type FfprobeJson = {
  format?: {
    duration?: string;
    tags?: Record<string, string>;
  };
  streams?: FfprobeStream[];
};

export type ProbeFn = (filePath: string) => Promise<FfprobeJson>;

export type MediaMetadata = {
  filePath: string;
  fileName: string;
  role: MediaRole;
  durationMs: number;
  fps: number | null;
  width: number | null;
  height: number | null;
  videoCodec: string | null;
  audioCodec: string | null;
  audioChannels: number | null;
  sampleRate: number | null;
  embeddedTimecode: string | null;
  audioTimecode: string | null;
  audioTimeReferenceSamples: number | null;
};

export type JobMediaSource = {
  filePath: string;
  fileName: string;
  mediaId?: string;
  role?: MediaRole;
  manualOffsetMs?: number;
};

export type DroppedMediaFile = {
  file: File;
  fileName: string;
  role: MediaRole;
  manualOffsetMs?: number;
};

export type PreparedIngest = {
  sources: MediaMetadata[];
  mix: MediaMetadata | undefined;
  analysisPath?: string;
  durationMs: number;
  sync: SyncResult | null;
  proxies: ProxyResult[];
  notes: string[];
};

const ROLE_FIELDS = [
  "cam_a",
  "cam_b",
  "cam_wide",
  "mic_a",
  "mic_b",
] as const;

export function classifyMediaRole(fileName: string): MediaRole {
  const base = path
    .basename(fileName)
    .replace(/\.[^.]+$/, "")
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
  if (/(^|_)(cam_?a|camera_?a)$/.test(base) || base === "a") {
    return "cam_a";
  }
  if (/(^|_)(cam_?b|camera_?b)$/.test(base) || base === "b") {
    return "cam_b";
  }
  if (/(cam_)?wide/.test(base)) {
    return "cam_wide";
  }
  if (/(^|_)mic_?a$/.test(base)) {
    return "mic_a";
  }
  if (/(^|_)mic_?b$/.test(base)) {
    return "mic_b";
  }
  return "unknown";
}

export function cameraIdFromRole(role: MediaRole): CameraId | undefined {
  switch (role) {
    case "cam_a":
      return "A";
    case "cam_b":
      return "B";
    case "cam_wide":
      return "WIDE";
    case "mic_a":
    case "mic_b":
    case "unknown":
      return undefined;
    default: {
      const _never: never = role;
      return _never;
    }
  }
}

export function roleFromCameraId(id: CameraId): MediaRole {
  switch (id) {
    case "A":
      return "cam_a";
    case "B":
      return "cam_b";
    case "WIDE":
      return "cam_wide";
    default: {
      const _never: never = id;
      return _never;
    }
  }
}

export function jobSourcesFromCameras(
  cameras: { id: CameraId; mediaId: string; fileName: string }[],
  lookup: (mediaId: string) => { filePath: string } | undefined,
  extra: JobMediaSource[] = [],
): JobMediaSource[] {
  const sources: JobMediaSource[] = [];
  const seen = new Set<string>();
  for (const camera of cameras) {
    const media = lookup(camera.mediaId);
    if (!media) {
      continue;
    }
    seen.add(media.filePath);
    sources.push({
      filePath: media.filePath,
      fileName: camera.fileName,
      mediaId: camera.mediaId,
      role: roleFromCameraId(camera.id),
    });
  }
  for (const item of extra) {
    if (seen.has(item.filePath)) {
      continue;
    }
    seen.add(item.filePath);
    sources.push(item);
  }
  return sources;
}

export function labelFromRole(role: MediaRole): string {
  switch (role) {
    case "cam_a":
      return "CAM A";
    case "cam_b":
      return "CAM B";
    case "cam_wide":
      return "CAM WIDE";
    case "mic_a":
      return "MIC A";
    case "mic_b":
      return "MIC B";
    case "unknown":
      return "MEDIA";
    default: {
      const _never: never = role;
      return _never;
    }
  }
}

export function parseFrameRate(value: string | undefined): number | null {
  if (!value || value === "0/0" || value === "N/A") {
    return null;
  }
  if (value.includes("/")) {
    const [num, den] = value.split("/").map(Number);
    if (!Number.isFinite(num) || !Number.isFinite(den) || den === 0) {
      return null;
    }
    return num / den;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export function parseSmpteTimecodeMs(
  timecode: string | null | undefined,
  fps = 30,
): number | null {
  if (!timecode) {
    return null;
  }
  const match = timecode
    .trim()
    .match(/^(\d{1,2}):(\d{2}):(\d{2})[:;](\d{1,3})$/);
  if (!match) {
    return null;
  }
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  const seconds = Number(match[3]);
  const frames = Number(match[4]);
  const frameRate = fps > 0 ? fps : 30;
  const ms =
    ((hours * 3600 + minutes * 60 + seconds) * 1000) +
    Math.round((frames / frameRate) * 1000);
  return Number.isFinite(ms) ? ms : null;
}

export function parseFfprobeJson(
  raw: FfprobeJson,
  filePath: string,
  fileName = path.basename(filePath),
): MediaMetadata {
  const streams = raw.streams ?? [];
  const video = streams.find((stream) => stream.codec_type === "video");
  const audio = streams.find((stream) => stream.codec_type === "audio");
  const formatTags = raw.format?.tags ?? {};
  const videoTags = video?.tags ?? {};
  const audioTags = audio?.tags ?? {};
  const fps =
    parseFrameRate(video?.avg_frame_rate) ?? parseFrameRate(video?.r_frame_rate);
  const formatDuration = secondsToMs(raw.format?.duration);
  const streamDuration =
    secondsToMs(video?.duration) || secondsToMs(audio?.duration);
  const timeReference = firstNumber(
    formatTags.time_reference,
    formatTags.TimeReference,
    audioTags.time_reference,
  );
  return {
    filePath,
    fileName,
    role: classifyMediaRole(fileName),
    durationMs: formatDuration || streamDuration,
    fps,
    width: video?.width ?? null,
    height: video?.height ?? null,
    videoCodec: video?.codec_name ?? null,
    audioCodec: audio?.codec_name ?? null,
    audioChannels: audio?.channels ?? null,
    sampleRate: audio?.sample_rate ? Number(audio.sample_rate) || null : null,
    embeddedTimecode: firstTimecode(
      videoTags.timecode,
      videoTags.TIMECODE,
      formatTags.timecode,
      formatTags.TIMECODE,
      sideDataTimecode(video),
    ),
    audioTimecode: firstTimecode(
      audioTags.timecode,
      audioTags.TIMECODE,
      sideDataTimecode(audio),
    ),
    audioTimeReferenceSamples: timeReference,
  };
}

export async function probeMediaMetadata(
  filePath: string,
  options: { probe?: ProbeFn; fileName?: string } = {},
): Promise<MediaMetadata> {
  const probe = options.probe ?? defaultProbe;
  const raw = await probe(filePath);
  return parseFfprobeJson(
    raw,
    filePath,
    options.fileName ?? path.basename(filePath),
  );
}

export async function ingestMediaFiles(
  files: { filePath: string; fileName: string }[],
  options: { probe?: ProbeFn } = {},
): Promise<MediaMetadata[]> {
  const scanned: MediaMetadata[] = [];
  for (const file of files) {
    scanned.push(
      await probeMediaMetadata(file.filePath, {
        probe: options.probe,
        fileName: file.fileName,
      }),
    );
  }
  return scanned;
}

export function collectDroppedFiles(form: FormData): DroppedMediaFile[] {
  const named = new Map<string, DroppedMediaFile>();
  const offsets = parseManualOffsets(form);
  for (const field of ROLE_FIELDS) {
    const value = form.get(field);
    if (value instanceof File && value.size > 0) {
      named.set(field, {
        file: value,
        fileName: value.name,
        role: field,
        manualOffsetMs: offsets[field],
      });
    }
  }
  const extras: DroppedMediaFile[] = [];
  const bag = [
    ...form.getAll("files"),
    ...form.getAll("file"),
  ];
  for (const value of bag) {
    if (!(value instanceof File) || value.size === 0) {
      continue;
    }
    const role = classifyMediaRole(value.name);
    const key = role === "unknown" ? value.name : role;
    if (role !== "unknown" && named.has(role)) {
      continue;
    }
    extras.push({
      file: value,
      fileName: value.name,
      role,
      manualOffsetMs: offsets[key] ?? offsets[role],
    });
  }
  const merged = [...named.values(), ...extras];
  const seen = new Set<string>();
  return merged.filter((item) => {
    const id = `${item.role}:${item.fileName}:${item.file.size}`;
    if (seen.has(id)) {
      return false;
    }
    seen.add(id);
    return true;
  });
}

export function parseManualOffsets(
  form: FormData,
): Record<string, number> {
  const offsets: Record<string, number> = {};
  const global = Number(form.get("manualOffsetMs"));
  if (Number.isFinite(global) && form.get("manualOffsetMs") != null && String(form.get("manualOffsetMs")).trim() !== "") {
    offsets.unknown = global;
  }
  for (const field of ROLE_FIELDS) {
    const raw = form.get(`manualOffset_${field}`) ?? form.get(`offset_${field}`);
    const value = Number(raw);
    if (Number.isFinite(value) && raw != null && String(raw).trim() !== "") {
      offsets[field] = value;
    }
  }
  return offsets;
}

export async function prepareAnalysisMedia(input: {
  filePath?: string;
  fileName: string;
  durationMs?: number;
  sources?: JobMediaSource[];
  manualOffsetsMs?: Record<string, number>;
  jobId?: string;
  probe?: ProbeFn;
  proxyHeight?: ProxyHeight;
  runFfmpeg?: (args: string[]) => Promise<void>;
}): Promise<PreparedIngest> {
  const listed = input.sources?.length
    ? input.sources
    : input.filePath
      ? [{ filePath: input.filePath, fileName: input.fileName }]
      : [];
  if (listed.length === 0) {
    return {
      sources: [],
      mix: undefined,
      analysisPath: input.filePath,
      durationMs: input.durationMs ?? 0,
      sync: null,
      proxies: [],
      notes: ["ingest: 素材パスが無いためメタデータ取得をスキップ"],
    };
  }

  let sources: MediaMetadata[] = [];
  try {
    sources = await ingestMediaFiles(
      listed.map((item) => ({
        filePath: item.filePath,
        fileName: item.fileName,
      })),
      { probe: input.probe },
    );
  } catch (error) {
    return {
      sources: [],
      mix: undefined,
      analysisPath: input.filePath,
      durationMs: input.durationMs ?? 0,
      sync: null,
      proxies: [],
      notes: [
        `ingest: ffprobe に失敗したため原盤を使います (${errorMessage(error)})`,
      ],
    };
  }

  sources = sources.map((meta, index) => {
    const listedRole = listed[index]?.role;
    return {
      ...meta,
      role:
        listedRole && listedRole !== "unknown"
          ? listedRole
          : meta.role === "unknown" && listed.length === 1
            ? "cam_a"
            : meta.role,
    };
  });

  const mix = pickMix(sources);
  const durationMs = mix?.durationMs || input.durationMs || 0;
  const tracks = sources.map((meta, index) =>
    toSyncableTrack(meta, listed[index], input.manualOffsetsMs),
  );
  const mixTrackId = mix
    ? mix.role === "unknown"
      ? mix.fileName
      : mix.role
    : tracks[0]?.id;
  const mixTrack = tracks.find((track) => track.id === mixTrackId) ?? tracks[0];
  let sync: SyncResult | null = null;
  try {
    const needsWaveform =
      Boolean(mixTrack) &&
      tracks.length > 1 &&
      tracks.some((track) => {
        if (!mixTrack || track.id === mixTrack.id) {
          return false;
        }
        return (
          (mixTrack.embeddedTimecodeMs == null ||
            track.embeddedTimecodeMs == null) &&
          !hasAudioTimecode(mixTrack) &&
          !hasAudioTimecode(track)
        );
      });
    sync = await syncTracks(tracks, {
      referenceId: mixTrackId,
      extractWaveform: needsWaveform ? extractWaveform : undefined,
    });
  } catch {
    sync = {
      referenceId: mixTrackId ?? "mix",
      offsets: tracks.map((track) => ({
        id: track.id,
        offsetMs: track.manualOffsetMs ?? 0,
        method: "manual" as const,
        confidence: track.manualOffsetMs == null ? 0 : 1,
      })),
    };
  }

  const proxies: ProxyResult[] = [];
  const videos = sources.filter((meta) => meta.height != null && meta.height > 0);
  for (const video of videos) {
    try {
      proxies.push(
        await ensureProxy({
          sourcePath: video.filePath,
          height: input.proxyHeight ?? 720,
          metadata: {
            width: video.width,
            height: video.height,
            videoCodec: video.videoCodec,
            audioCodec: video.audioCodec,
          },
          runFfmpeg: input.runFfmpeg,
        }),
      );
    } catch (error) {
      const message = errorMessage(error);
      proxies.push({
        sourcePath: video.filePath,
        path: video.filePath,
        height: input.proxyHeight ?? 720,
        skipped: false,
        reason: "encode_failed",
        audio: "copy",
        error: message,
      });
    }
  }

  const mixProxy = mix
    ? proxies.find((proxy) => proxy.sourcePath === mix.filePath)
    : undefined;
  const analysisPath = mixProxy?.path ?? mix?.filePath ?? input.filePath;
  const notes = [
    `ingest: ${sources.map((meta) => summarizeSource(meta)).join(" / ") || "なし"}`,
    sync
      ? `sync: ${sync.offsets
          .map((offset) => `${offset.id}=${offset.method}${offset.offsetMs ? `@${offset.offsetMs}ms` : ""}`)
          .join(", ")}`
      : "sync: スキップ",
    proxies.length
      ? `proxy: ${proxies
          .map((proxy) => proxyNote(proxy))
          .join(", ")}`
      : "proxy: なし",
  ];

  return {
    sources,
    mix,
    analysisPath,
    durationMs,
    sync,
    proxies,
    notes,
  };
}

async function defaultProbe(filePath: string): Promise<FfprobeJson> {
  const { stdout } = await execFileAsync("ffprobe", [
    "-v",
    "error",
    "-print_format",
    "json",
    "-show_format",
    "-show_streams",
    filePath,
  ]);
  return JSON.parse(stdout) as FfprobeJson;
}

function pickMix(sources: MediaMetadata[]): MediaMetadata | undefined {
  return (
    sources.find((meta) => meta.role === "cam_a") ??
    sources.find((meta) => meta.height != null && meta.height > 0) ??
    sources[0]
  );
}

function toSyncableTrack(
  meta: MediaMetadata,
  listed: JobMediaSource | undefined,
  manualOffsetsMs: Record<string, number> | undefined,
): SyncableTrack {
  const fps = meta.fps && meta.fps > 0 ? meta.fps : 30;
  const audioFromSamples =
    meta.audioTimeReferenceSamples != null && meta.sampleRate
      ? Math.round((meta.audioTimeReferenceSamples / meta.sampleRate) * 1000)
      : null;
  return {
    id: meta.role === "unknown" ? meta.fileName : meta.role,
    filePath: meta.filePath,
    embeddedTimecodeMs: parseSmpteTimecodeMs(meta.embeddedTimecode, fps),
    audioTimecodeMs:
      parseSmpteTimecodeMs(meta.audioTimecode, fps) ?? audioFromSamples,
    audioTimeReferenceSamples: meta.audioTimeReferenceSamples,
    sampleRate: meta.sampleRate,
    manualOffsetMs:
      listed?.manualOffsetMs ??
      manualOffsetsMs?.[meta.role] ??
      manualOffsetsMs?.[meta.fileName],
  };
}

function hasAudioTimecode(track: SyncableTrack): boolean {
  return track.audioTimecodeMs != null;
}

function proxyNote(proxy: ProxyResult): string {
  if (proxy.reason === "encode_failed") {
    return `encode failed ${proxy.height}p (${proxy.error ?? "unknown"})`;
  }
  if (proxy.skipped) {
    return `skip ${proxy.height}p`;
  }
  return `encode ${proxy.height}p/${proxy.audio}`;
}

function summarizeSource(meta: MediaMetadata): string {
  const size =
    meta.width && meta.height ? `${meta.width}x${meta.height}` : "audio";
  const codec = meta.videoCodec ?? meta.audioCodec ?? "?";
  const rate = meta.sampleRate ? `${meta.sampleRate}Hz` : "no-sr";
  const tc = meta.embeddedTimecode ?? meta.audioTimecode ?? "no-tc";
  return `${labelFromRole(meta.role)} ${size} ${codec} ${rate} ${tc}`;
}

function firstTimecode(
  ...values: (string | undefined | null)[]
): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return null;
}

function sideDataTimecode(stream: FfprobeStream | undefined): string | undefined {
  const hit = stream?.side_data_list?.find((item) => item.timecode);
  return hit?.timecode;
}

function firstNumber(...values: (string | undefined)[]): number | null {
  for (const value of values) {
    if (value == null || value === "") {
      continue;
    }
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return null;
}

function secondsToMs(value: string | undefined): number {
  const seconds = Number(value ?? 0);
  return Number.isFinite(seconds) ? Math.round(seconds * 1000) : 0;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
