import path from "node:path";
import { toSrtTime } from "./format";
import { durationOf, keptClips } from "./decide";
import type { CameraId, ScoredClip } from "./types";

const FRAME_RATE = 30;
const PUNCH_IN_SCALE = 1.15;

export type NleInput = {
  title: string;
  fileName: string;
  clips: ScoredClip[];
  cameras?: { id: CameraId; fileName: string; label: string }[];
  sourceDurationMs?: number;
};

export function cameraFileOf(
  clip: ScoredClip,
  input: Pick<NleInput, "fileName" | "cameras">,
): string {
  const cam = clip.camera ?? "A";
  return input.cameras?.find((item) => item.id === cam)?.fileName ?? input.fileName;
}

export function buildVtt(clips: ScoredClip[]): string {
  const kept = keptClips(clips).filter((clip) => clip.text.trim().length > 0);
  if (kept.length === 0) {
    return "WEBVTT\n\n";
  }
  let timelineMs = 0;
  const blocks: string[] = ["WEBVTT", ""];
  kept.forEach((clip, index) => {
    const start = timelineMs;
    const end = timelineMs + durationOf(clip);
    timelineMs = end;
    blocks.push(`${index + 1}`);
    blocks.push(`${toVttTime(start)} --> ${toVttTime(end)}`);
    blocks.push(`${clip.speaker}: ${clip.text.trim()}`);
    blocks.push("");
  });
  return `${blocks.join("\n").trim()}\n`;
}

export function buildFcpxml(input: NleInput): string {
  const kept = keptClips(input.clips);
  const sourceDurationMs = sourceDuration(input, kept);
  const assets = collectAssets(input, kept, sourceDurationMs);
  const assetLines = assets.map(
    (asset) =>
      `            <asset id="${asset.id}" name="${xmlEscape(asset.name)}" src="${xmlEscape(asset.src)}" start="0s" duration="${toFcpxmlTime(asset.durationMs)}" hasVideo="1" hasAudio="1" format="r1" videoSources="1" audioSources="1" audioChannels="2" audioRate="48000"/>`,
  );

  let timelineMs = 0;
  const clipLines: string[] = [];
  kept.forEach((clip) => {
    const durationMs = durationOf(clip);
    const asset = assets.find((item) => item.camera === (clip.camera ?? "A")) ?? assets[0];
    const name = clip.text.trim() || clip.reason;
    const note = [
      clip.verdict.toUpperCase(),
      `speaker=${clip.speaker}`,
      `keepScore=${clip.keepScore.toFixed(3)}`,
      `CAM ${clip.camera ?? "A"}`,
      clip.punchIn ? "punch-in" : "",
      clip.reason,
    ]
      .filter(Boolean)
      .join(" | ");
    const punch =
      clip.punchIn === true
        ? `\n                    <adjust-transform scale="${PUNCH_IN_SCALE} ${PUNCH_IN_SCALE}"/>`
        : "";
    clipLines.push(
      [
        `                    <asset-clip ref="${asset?.id ?? "r2"}" offset="${toFcpxmlTime(timelineMs)}" name="${xmlEscape(name)}" start="${toFcpxmlTime(clip.startMs)}" duration="${toFcpxmlTime(durationMs)}" tcFormat="NDF">`,
        `                        <note>${xmlEscape(note)}</note>${punch}`,
        `                    </asset-clip>`,
      ].join("\n"),
    );
    timelineMs += durationMs;
  });

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE fcpxml>
<fcpxml version="1.9">
    <resources>
        <format id="r1" name="FFVideoFormat720p30" frameDuration="${toFcpxmlTime(1000 / FRAME_RATE)}" width="1280" height="720"/>
${assetLines.join("\n")}
    </resources>
    <library>
        <event name="CUTLINE">
            <project name="${xmlEscape(input.title || "CutLine")}">
                <sequence format="r1" tcStart="0s" tcFormat="NDF" duration="${toFcpxmlTime(timelineMs)}">
                    <spine>
${clipLines.join("\n")}
                    </spine>
                </sequence>
            </project>
        </event>
    </library>
</fcpxml>
`;
}

export function buildXmeml(input: NleInput): string {
  const kept = keptClips(input.clips);
  const files = collectXmemlFiles(input, kept);
  let timelineFrames = 0;
  const videoItems: string[] = [];
  const audioItems: string[] = [];

  kept.forEach((clip, index) => {
    const durationFrames = Math.max(1, toFrames(durationOf(clip)));
    const startFrames = timelineFrames;
    const endFrames = startFrames + durationFrames;
    const inFrames = toFrames(clip.startMs);
    const outFrames = inFrames + durationFrames;
    const file = files.find((item) => item.camera === (clip.camera ?? "A")) ?? files[0];
    const name = xmlEscape(clip.text.trim() || clip.reason);
    const fileId = file?.id ?? "file-1";
    const videoId = `clipitem-${index + 1}`;
    const audioId = `clipitem-${index + 1}-a`;
    const punchFilter =
      clip.punchIn === true
        ? `
                <filter>
                    <effect>
                        <name>Basic Motion</name>
                        <effectid>basic</effectid>
                        <effectcategory>motion</effectcategory>
                        <parameter>
                            <name>Scale</name>
                            <value>${Math.round(PUNCH_IN_SCALE * 100)}</value>
                        </parameter>
                    </effect>
                </filter>`
        : "";
    const links = `
                <link>
                    <linkclipref>${videoId}</linkclipref>
                    <mediatype>video</mediatype>
                    <trackindex>1</trackindex>
                    <clipindex>${index + 1}</clipindex>
                </link>
                <link>
                    <linkclipref>${audioId}</linkclipref>
                    <mediatype>audio</mediatype>
                    <trackindex>1</trackindex>
                    <clipindex>${index + 1}</clipindex>
                </link>`;
    videoItems.push(`            <clipitem id="${videoId}">
                <name>${name}</name>
                <duration>${durationFrames}</duration>
                <rate>
                    <timebase>${FRAME_RATE}</timebase>
                    <ntsc>FALSE</ntsc>
                </rate>
                <start>${startFrames}</start>
                <end>${endFrames}</end>
                <in>${inFrames}</in>
                <out>${outFrames}</out>
                <file id="${fileId}"/>
                <comments>
                    <mastercomment2>${xmlEscape(nleComment(clip))}</mastercomment2>
                </comments>${punchFilter}${links}
            </clipitem>`);
    audioItems.push(`            <clipitem id="${audioId}">
                <name>${name}</name>
                <duration>${durationFrames}</duration>
                <rate>
                    <timebase>${FRAME_RATE}</timebase>
                    <ntsc>FALSE</ntsc>
                </rate>
                <start>${startFrames}</start>
                <end>${endFrames}</end>
                <in>${inFrames}</in>
                <out>${outFrames}</out>
                <file id="${fileId}"/>${links}
            </clipitem>`);
    timelineFrames = endFrames;
  });

  const fileDefs = files
    .map(
      (file) => `        <file id="${file.id}">
            <name>${xmlEscape(file.name)}</name>
            <pathurl>${xmlEscape(file.src)}</pathurl>
            <rate>
                <timebase>${FRAME_RATE}</timebase>
                <ntsc>FALSE</ntsc>
            </rate>
            <duration>${toFrames(file.durationMs)}</duration>
            <media>
                <video>
                    <samplecharacteristics>
                        <width>1280</width>
                        <height>720</height>
                    </samplecharacteristics>
                </video>
                <audio>
                    <samplecharacteristics>
                        <depth>16</depth>
                        <samplerate>48000</samplerate>
                    </samplecharacteristics>
                    <channelcount>2</channelcount>
                </audio>
            </media>
        </file>`,
    )
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE xmeml>
<xmeml version="5">
    <sequence id="sequence-1">
        <name>${xmlEscape(input.title || "CutLine")}</name>
        <rate>
            <timebase>${FRAME_RATE}</timebase>
            <ntsc>FALSE</ntsc>
        </rate>
${fileDefs}
        <media>
            <video>
                <format>
                    <samplecharacteristics>
                        <width>1280</width>
                        <height>720</height>
                        <rate>
                            <timebase>${FRAME_RATE}</timebase>
                            <ntsc>FALSE</ntsc>
                        </rate>
                    </samplecharacteristics>
                </format>
                <track>
${videoItems.join("\n")}
                </track>
            </video>
            <audio>
                <track>
${audioItems.join("\n")}
                </track>
            </audio>
        </media>
    </sequence>
</xmeml>
`;
}

function nleComment(clip: ScoredClip): string {
  return [
    clip.reason,
    `keepScore=${clip.keepScore.toFixed(3)}`,
    `CAM ${clip.camera ?? "A"}`,
    clip.verdict,
  ].join(" ");
}

function collectAssets(
  input: NleInput,
  kept: ScoredClip[],
  sourceDurationMs: number,
): { id: string; name: string; src: string; camera: CameraId; durationMs: number }[] {
  const cameras = usedCameras(kept);
  return cameras.map((camera, index) => {
    const fileName =
      input.cameras?.find((item) => item.id === camera)?.fileName ?? input.fileName;
    return {
      id: `r${index + 2}`,
      name: fileName,
      src: toFileUrl(fileName),
      camera,
      durationMs: sourceDurationMs,
    };
  });
}

function collectXmemlFiles(
  input: NleInput,
  kept: ScoredClip[],
): { id: string; name: string; src: string; camera: CameraId; durationMs: number }[] {
  const sourceDurationMs = sourceDuration(input, kept);
  return usedCameras(kept).map((camera, index) => {
    const fileName =
      input.cameras?.find((item) => item.id === camera)?.fileName ?? input.fileName;
    return {
      id: `file-${index + 1}`,
      name: fileName,
      src: toFileUrl(fileName),
      camera,
      durationMs: sourceDurationMs,
    };
  });
}

function usedCameras(clips: ScoredClip[]): CameraId[] {
  const seen = new Set<CameraId>();
  const order: CameraId[] = [];
  for (const clip of clips) {
    const camera = clip.camera ?? "A";
    if (!seen.has(camera)) {
      seen.add(camera);
      order.push(camera);
    }
  }
  return order.length > 0 ? order : ["A"];
}

function sourceDuration(input: NleInput, kept: ScoredClip[]): number {
  if (input.sourceDurationMs && input.sourceDurationMs > 0) {
    return input.sourceDurationMs;
  }
  return Math.max(1000, ...kept.map((clip) => clip.endMs), 0);
}

function toFrames(ms: number): number {
  return Math.max(0, Math.round((ms / 1000) * FRAME_RATE));
}

function toFcpxmlTime(ms: number): string {
  const frames = toFrames(ms);
  return `${frames}/${FRAME_RATE}s`;
}

function toVttTime(ms: number): string {
  return toSrtTime(ms).replace(",", ".");
}

export function toFileUrl(fileName: string): string {
  const leaf = path.posix
    .basename(fileName.replaceAll("\\", "/"))
    .replace(/[\r\n]+/g, "");
  if (!leaf || leaf === "." || leaf === ".." || /^(file|https?):/i.test(leaf)) {
    return "file://localhost/media";
  }
  return `file://localhost/${encodeURIComponent(leaf)}`;
}

function xmlEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
