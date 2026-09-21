import { mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { toTimecode, toSrtTime } from "./format";
import { durationOf, keptClips } from "./decide";
import { loudnormFilter, scaleFilter, buildRenderFilterComplex } from "./ffmpeg";
import type { ScoredClip } from "./types";
import {
  buildFcpxml,
  buildXmeml,
  cameraFileOf,
  type NleInput,
} from "./nle";
import { buildAaf } from "./aaf";

export { keptClips };
export { buildAaf } from "./aaf";
export { buildFcpxml, buildVtt, buildXmeml, cameraFileOf } from "./nle";
export type { NleInput } from "./nle";

export type NleExportFormat = "otio" | "fcpxml" | "xmeml" | "xml" | "aaf";

export type NleExportFile = {
  body: string;
  contentType: string;
  filename: string;
};

export function exportNleFormat(
  format: NleExportFormat,
  input: NleInput,
): NleExportFile {
  switch (format) {
    case "aaf":
      return {
        body: buildAaf(input),
        contentType: "application/xml; charset=utf-8",
        filename: "video-final.aaf.xml",
      };
    case "otio":
      return {
        body: JSON.stringify(buildOtio(input), null, 2),
        contentType: "application/json; charset=utf-8",
        filename: "video-final.otio",
      };
    case "fcpxml":
      return {
        body: buildFcpxml(input),
        contentType: "application/xml; charset=utf-8",
        filename: "video-final.fcpxml",
      };
    case "xml":
    case "xmeml":
      return {
        body: buildXmeml(input),
        contentType: "application/xml; charset=utf-8",
        filename: "video-final.xml",
      };
    default: {
      const _never: never = format;
      return _never;
    }
  }
}

export function buildEdl(input: {
  title: string;
  fileName: string;
  clips: ScoredClip[];
}): string {
  const kept = keptClips(input.clips);
  const lines = [
    `TITLE: ${input.title || "CutLine"}`,
    "FCM: NON-DROP FRAME",
    "",
  ];
  let timelineMs = 0;
  kept.forEach((clip, index) => {
    const recIn = timelineMs;
    const recOut = timelineMs + durationOf(clip);
    timelineMs = recOut;
    const event = String(index + 1).padStart(3, "0");
    lines.push(
      `${event}  AX       V     C        ${toTimecode(clip.startMs)} ${toTimecode(clip.endMs)} ${toTimecode(recIn)} ${toTimecode(recOut)}`,
    );
    lines.push(`* FROM CLIP NAME: ${input.fileName}`);
    lines.push(`* COMMENT: ${clip.reason} ${clip.text}`.trim());
    lines.push("");
  });
  return `${lines.join("\n").trim()}\n`;
}

export function concatSourceName(fileName: string): string {
  const leaf = path.posix
    .basename(fileName.replaceAll("\\", "/"))
    .replace(/[\r\n]+/g, "");
  return leaf.replaceAll("'", "'\\''");
}

export function buildConcatList(clips: ScoredClip[], fileName: string): string {
  const kept = keptClips(clips);
  const safeName = concatSourceName(fileName);
  const lines = kept.flatMap((clip) => [
    `file '${safeName}'`,
    `inpoint ${formatSeconds(clip.startMs)}`,
    `outpoint ${formatSeconds(clip.endMs)}`,
  ]);
  return lines.join("\n") + (lines.length ? "\n" : "");
}

export function buildFfmpegCommand(fileName: string): string {
  void fileName;
  return [
    "ffmpeg -y -f concat -i concat.txt",
    "-c:v libx264 -preset veryfast -crf 18 -c:a aac",
    "edited.mp4",
  ].join(" ");
}

export function buildFilterComplexCommand(input: {
  fileName: string;
  clips: ScoredClip[];
}): string {
  const kept = keptClips(input.clips);
  if (kept.length === 0) {
    return "# 残すクリップがありません";
  }
  const captionDir = path.join(os.tmpdir(), "cutline", "captions");
  mkdirSync(captionDir, { recursive: true });
  kept.forEach((clip, index) => {
    if (!clip.burnIn || !clip.text.trim()) {
      return;
    }
    writeFileSync(
      path.join(captionDir, `caption-${index}.txt`),
      clip.text.trim(),
      "utf8",
    );
  });
  const graph = buildRenderFilterComplex({
    clips: kept.map((clip) => ({
      startMs: clip.startMs,
      endMs: clip.endMs,
      camera: clip.camera,
      punchIn: clip.punchIn,
      morph: clip.morph,
      text: clip.text,
      burnIn: clip.burnIn,
      role: clip.role,
      sourceStartMs: clip.startMs,
      sourceEndMs: clip.endMs,
    })),
    captionDir,
    indexByCamera: { A: 0, B: 0, WIDE: 0 },
    scale: scaleFilter("youtube-1080p"),
    loudnorm: true,
    loudnessFilter: loudnormFilter("youtube"),
  });
  return [
    `ffmpeg -y -i '${input.fileName.replaceAll("'", "'\\''")}'`,
    `-filter_complex "${graph.filterComplex}"`,
    `-map "[v]" -map "[a]" -c:v libx264 -preset veryfast -crf 18 -c:a aac`,
    "edited.mp4",
  ].join(" ");
}

function formatSeconds(ms: number): string {
  return (ms / 1000).toFixed(3);
}

export function buildSrt(clips: ScoredClip[]): string {
  const kept = keptClips(clips).filter((clip) => clip.text.trim().length > 0);
  let timelineMs = 0;
  const blocks: string[] = [];
  kept.forEach((clip, index) => {
    const start = timelineMs;
    const end = timelineMs + durationOf(clip);
    timelineMs = end;
    blocks.push(
      `${index + 1}\n${toSrtTime(start)} --> ${toSrtTime(end)}\n${clip.speaker}: ${clip.text.trim()}`,
    );
  });
  return blocks.length ? `${blocks.join("\n\n")}\n` : "";
}

export function buildOtio(input: {
  title: string;
  fileName: string;
  clips: ScoredClip[];
  cameras?: { id: "A" | "B" | "WIDE"; fileName: string; label: string }[];
}): Record<string, unknown> {
  const kept = keptClips(input.clips);
  const rate = 30;
  const children = kept.map((clip) => {
    const startFrames = Math.round((clip.startMs / 1000) * rate);
    const durationFrames = Math.round((durationOf(clip) / 1000) * rate);
    return {
      OTIO_SCHEMA: "Clip.1",
      name: clip.text.trim() || clip.reason,
      source_range: {
        OTIO_SCHEMA: "TimeRange.1",
        start_time: {
          OTIO_SCHEMA: "RationalTime.1",
          value: startFrames,
          rate,
        },
        duration: {
          OTIO_SCHEMA: "RationalTime.1",
          value: Math.max(1, durationFrames),
          rate,
        },
      },
      media_reference: {
        OTIO_SCHEMA: "ExternalReference.1",
        target_url: cameraFileOf(clip, input),
      },
      metadata: {
        cutline: {
          speaker: clip.speaker,
          reason: clip.reason,
          keepScore: clip.keepScore,
          confidence: clip.signals.confidence,
          camera: clip.camera ?? "A",
          alternativeCamera: clip.camera === "WIDE" ? "A" : "WIDE",
          punchIn: clip.punchIn === true,
          reviewStatus: clip.verdict,
          deleteReason: clip.verdict === "cut" ? clip.reason : null,
        },
      },
    };
  });
  return {
    OTIO_SCHEMA: "Timeline.2",
    name: input.title || "CutLine",
    tracks: {
      OTIO_SCHEMA: "Stack.1",
      children: [
        {
          OTIO_SCHEMA: "Track.1",
          name: "V1",
          kind: "Video",
          children,
        },
      ],
    },
  };
}

export function buildProjectJson(input: {
  title: string;
  fileName: string;
  clips: ScoredClip[];
  timeline: unknown;
  qa: unknown;
  perception: unknown;
}): Record<string, unknown> {
  return {
    title: input.title,
    fileName: input.fileName,
    timeline: input.timeline,
    qa: input.qa,
    perception: input.perception,
    clips: input.clips.map((clip) => ({
      id: clip.id,
      speaker: clip.speaker,
      text: clip.text,
      startMs: clip.startMs,
      endMs: clip.endMs,
      role: clip.role,
      verdict: clip.verdict,
      keepScore: clip.keepScore,
      reason: clip.reason,
      camera: clip.camera ?? "A",
      punchIn: clip.punchIn === true,
      cameraReason: clip.cameraReason,
    })),
  };
}
