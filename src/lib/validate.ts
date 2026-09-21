import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ExportValidation } from "./types";

const execFileAsync = promisify(execFile);
const DURATION_SLACK_MS = 600;

export function parseDetectLog(stderr: string): {
  blackFrames: boolean;
  frozenFrames: boolean;
  silenceAnomaly: boolean;
} {
  const silenceDurations = [...stderr.matchAll(/silence_duration:\s*([0-9.]+)/gi)].map(
    (match) => Number(match[1]),
  );
  return {
    blackFrames: /black_duration:\s*([0-9.]+)/i.test(stderr),
    frozenFrames: /lavfi\.freezedetect\.freeze_start/i.test(stderr),
    silenceAnomaly: silenceDurations.some((value) => value >= 2),
  };
}

export async function validateRender(input: {
  filePath: string;
  expectedDurationMs: number;
}): Promise<ExportValidation> {
  const probe = await probeMedia(input.filePath);
  const detect = await detectAnomalies(input.filePath);
  const durationDelta = Math.abs(probe.durationMs - input.expectedDurationMs);
  const avSyncOk =
    probe.hasAudio &&
    probe.hasVideo &&
    Math.abs(probe.videoDurationMs - probe.audioDurationMs) <= 80;
  const durationOk = durationDelta <= DURATION_SLACK_MS;
  const notes: string[] = [];
  if (!probe.hasVideo) {
    notes.push("映像ストリームがありません");
  }
  if (!probe.hasAudio) {
    notes.push("音声ストリームがありません");
  }
  if (!durationOk) {
    notes.push(
      `尺が想定とずれています（${probe.durationMs}ms / 想定 ${input.expectedDurationMs}ms）`,
    );
  }
  if (!avSyncOk) {
    notes.push("映像と音声の尺差が 80ms を超えています");
  }
  if (detect.blackFrames) {
    notes.push("黒味区間を検出しました");
  }
  if (detect.frozenFrames) {
    notes.push("固まったフレームを検出しました");
  }
  if (detect.silenceAnomaly) {
    notes.push("2秒を超える無音があります");
  }
  const ok =
    probe.hasAudio &&
    probe.hasVideo &&
    durationOk &&
    avSyncOk &&
    !detect.blackFrames;
  return {
    durationMs: probe.durationMs,
    expectedDurationMs: input.expectedDurationMs,
    hasAudio: probe.hasAudio,
    hasVideo: probe.hasVideo,
    blackFrames: detect.blackFrames,
    frozenFrames: detect.frozenFrames,
    silenceAnomaly: detect.silenceAnomaly,
    avSyncOk,
    ok,
    notes,
  };
}

async function probeMedia(filePath: string): Promise<{
  durationMs: number;
  hasAudio: boolean;
  hasVideo: boolean;
  videoDurationMs: number;
  audioDurationMs: number;
}> {
  const { stdout } = await execFileAsync("ffprobe", [
    "-v",
    "error",
    "-show_streams",
    "-show_format",
    "-of",
    "json",
    filePath,
  ]);
  const parsed = JSON.parse(stdout) as {
    format?: { duration?: string };
    streams?: { codec_type?: string; duration?: string }[];
  };
  const streams = parsed.streams ?? [];
  const video = streams.find((stream) => stream.codec_type === "video");
  const audio = streams.find((stream) => stream.codec_type === "audio");
  const formatMs = secondsToMs(parsed.format?.duration);
  const videoDurationMs = secondsToMs(video?.duration) || formatMs;
  const audioDurationMs = secondsToMs(audio?.duration) || formatMs;
  return {
    durationMs: formatMs || videoDurationMs,
    hasAudio: Boolean(audio),
    hasVideo: Boolean(video),
    videoDurationMs,
    audioDurationMs,
  };
}

async function detectAnomalies(filePath: string): Promise<{
  blackFrames: boolean;
  frozenFrames: boolean;
  silenceAnomaly: boolean;
}> {
  try {
    const { stderr } = await execFileAsync("ffmpeg", [
      "-hide_banner",
      "-i",
      filePath,
      "-vf",
      "blackdetect=d=0.4:pic_th=0.98,freezedetect=n=0.003:d=5",
      "-af",
      "silencedetect=n=-45dB:d=2",
      "-f",
      "null",
      "-",
    ]);
    return parseDetectLog(stderr);
  } catch (error) {
    const stderr =
      error && typeof error === "object" && "stderr" in error
        ? String((error as { stderr?: string }).stderr ?? "")
        : "";
    if (stderr) {
      return parseDetectLog(stderr);
    }
    return { blackFrames: false, frozenFrames: false, silenceAnomaly: false };
  }
}

function secondsToMs(value: string | undefined): number {
  const seconds = Number(value ?? 0);
  return Number.isFinite(seconds) ? Math.round(seconds * 1000) : 0;
}
