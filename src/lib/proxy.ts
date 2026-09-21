import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { access, mkdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";

const execFileAsync = promisify(execFile);

export type ProxyHeight = 720 | 1080;

export type AudioEncodeMode = "copy" | "aac_high" | "none";

export type ProxyReason = "already_proxy" | "encoded" | "audio_only" | "encode_failed";

export type ProxyRequest = {
  sourcePath: string;
  outputPath?: string;
  height?: ProxyHeight;
  metadata?: {
    width: number | null;
    height: number | null;
    videoCodec: string | null;
    audioCodec: string | null;
  };
  runFfmpeg?: (args: string[]) => Promise<void>;
};

export type ProxyResult = {
  sourcePath: string;
  path: string;
  height: ProxyHeight;
  skipped: boolean;
  reason: ProxyReason;
  audio: AudioEncodeMode;
  error?: string;
};

export function isH264(codec: string | null | undefined): boolean {
  if (!codec) {
    return false;
  }
  const value = codec.toLowerCase();
  return value === "h264" || value === "avc" || value === "avc1";
}

export function chooseAudioMode(
  audioCodec: string | null | undefined,
): AudioEncodeMode {
  if (!audioCodec) {
    return "none";
  }
  const value = audioCodec.toLowerCase();
  if (
    value === "aac" ||
    value === "flac" ||
    value === "alac" ||
    value.startsWith("pcm")
  ) {
    return "copy";
  }
  return "aac_high";
}

export function shouldSkipProxyEncode(
  meta: { height: number | null; videoCodec: string | null },
  targetHeight: ProxyHeight = 720,
): boolean {
  if (meta.height == null || meta.height <= 0) {
    return false;
  }
  return meta.height <= targetHeight && isH264(meta.videoCodec);
}

export function proxyFfmpegArgs(input: {
  sourcePath: string;
  outputPath: string;
  height: ProxyHeight;
  audio: AudioEncodeMode;
}): string[] {
  const args = [
    "-y",
    "-i",
    input.sourcePath,
    "-vf",
    `scale=-2:${input.height}`,
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "18",
    "-pix_fmt",
    "yuv420p",
  ];
  switch (input.audio) {
    case "copy":
      args.push("-c:a", "copy");
      break;
    case "aac_high":
      args.push("-c:a", "aac", "-b:a", "192k");
      break;
    case "none":
      args.push("-an");
      break;
    default: {
      const _never: never = input.audio;
      return _never;
    }
  }
  args.push("-movflags", "+faststart", input.outputPath);
  return args;
}

export async function ensureProxy(input: ProxyRequest): Promise<ProxyResult> {
  const height = input.height ?? 720;
  const meta = input.metadata ?? {
    width: null,
    height: null,
    videoCodec: null,
    audioCodec: null,
  };
  const audio = chooseAudioMode(meta.audioCodec);
  if (meta.height == null || meta.height <= 0) {
    return {
      sourcePath: input.sourcePath,
      path: input.sourcePath,
      height,
      skipped: true,
      reason: "audio_only",
      audio,
    };
  }
  if (shouldSkipProxyEncode(meta, height)) {
    return {
      sourcePath: input.sourcePath,
      path: input.sourcePath,
      height,
      skipped: true,
      reason: "already_proxy",
      audio,
    };
  }
  const outputPath =
    input.outputPath ?? defaultProxyPath(input.sourcePath, height);
  await mkdir(path.dirname(outputPath), { recursive: true });
  try {
    await access(outputPath);
    return {
      sourcePath: input.sourcePath,
      path: outputPath,
      height,
      skipped: false,
      reason: "encoded",
      audio,
    };
  } catch {
    // encode below
  }
  const args = proxyFfmpegArgs({
    sourcePath: input.sourcePath,
    outputPath,
    height,
    audio: audio === "none" ? "aac_high" : audio,
  });
  const run = input.runFfmpeg ?? defaultRunFfmpeg;
  try {
    await run(args);
  } catch {
    if (audio === "copy") {
      await run(
        proxyFfmpegArgs({
          sourcePath: input.sourcePath,
          outputPath,
          height,
          audio: "aac_high",
        }),
      );
    } else {
      throw new Error(`proxy encode failed: ${input.sourcePath}`);
    }
  }
  return {
    sourcePath: input.sourcePath,
    path: outputPath,
    height,
    skipped: false,
    reason: "encoded",
    audio: audio === "none" ? "aac_high" : audio,
  };
}

function defaultProxyPath(sourcePath: string, height: ProxyHeight): string {
  const digest = createHash("sha256")
    .update(sourcePath)
    .digest("hex")
    .slice(0, 12);
  return path.join(
    os.tmpdir(),
    "cutline",
    "proxy",
    `${digest}-${height}.mp4`,
  );
}

async function defaultRunFfmpeg(args: string[]): Promise<void> {
  await execFileAsync("ffmpeg", args);
}
