import { durationOf, keptClips } from "./decide";
import { toFileUrl, type NleInput } from "./nle";
import type { CameraId, ScoredClip } from "./types";

const FRAME_RATE = 30;
const PUNCH_IN_SCALE = 1.15;

type MobKind = "composition" | "master" | "source";

type CameraAsset = {
  camera: CameraId;
  fileName: string;
  src: string;
  durationFrames: number;
  masterMobId: string;
  sourceMobId: string;
};

export function buildAaf(input: NleInput): string {
  const kept = keptClips(input.clips);
  const assets = collectCameraAssets(input, kept);
  const timelineFrames = kept.reduce(
    (sum, clip) => sum + Math.max(1, toFrames(durationOf(clip))),
    0,
  );
  const compositionMobId = mobId("composition", input.title || "CutLine");
  const pictureComponents = kept.map((clip) =>
    sourceClipXml(clip, assets, "Picture"),
  );
  const soundComponents = kept.map((clip) =>
    sourceClipXml(clip, assets, "Sound"),
  );
  const masterMobs = assets.map((asset) => masterMobXml(asset)).join("\n");
  const sourceMobs = assets.map((asset) => sourceMobXml(asset)).join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<AAF xmlns="http://www.aafassociation.org/aafx/1.1" version="1.1">
    <Identification>
        <CompanyName>CUTLINE</CompanyName>
        <ProductName>CutLine</ProductName>
        <ProductVersion>0.1.0</ProductVersion>
        <ProductID>urn:uuid:6c0a7c11-7e2a-4b3d-9f10-aaf000000001</ProductID>
        <Date>${new Date(0).toISOString()}</Date>
        <Platform>CutLine Timeline IR</Platform>
    </Identification>
    <ContentStorage>
        <CompositionMob MobID="${compositionMobId}" Name="${xmlEscape(input.title || "CutLine")}" Usage="TopLevel">
            <Comment>CUTLINE AAF-XML from Timeline IR. Resolve: File &gt; Import AAF / XML.</Comment>
            <TimelineMobSlot SlotID="1" PhysicalTrackNumber="1" Name="V1" EditRate="${FRAME_RATE}/1">
                <Sequence DataDefinition="Picture" Length="${timelineFrames}">
${pictureComponents.join("\n")}
                </Sequence>
            </TimelineMobSlot>
            <TimelineMobSlot SlotID="2" PhysicalTrackNumber="1" Name="A1" EditRate="${FRAME_RATE}/1">
                <Sequence DataDefinition="Sound" Length="${timelineFrames}">
${soundComponents.join("\n")}
                </Sequence>
            </TimelineMobSlot>
            <TimelineMobSlot SlotID="3" Name="TC" EditRate="${FRAME_RATE}/1">
                <Timecode Start="0" FPS="${FRAME_RATE}" Drop="false" Length="${timelineFrames}"/>
            </TimelineMobSlot>
        </CompositionMob>
${masterMobs}
${sourceMobs}
    </ContentStorage>
</AAF>
`;
}

function sourceClipXml(
  clip: ScoredClip,
  assets: CameraAsset[],
  dataDefinition: "Picture" | "Sound",
): string {
  const durationFrames = Math.max(1, toFrames(durationOf(clip)));
  const startFrames = toFrames(clip.startMs);
  const asset =
    assets.find((item) => item.camera === (clip.camera ?? "A")) ?? assets[0];
  const name = xmlEscape(clip.text.trim() || clip.reason);
  const comment = xmlEscape(nleComment(clip));
  const clipXml = `                        <SourceClip DataDefinition="${dataDefinition}" Name="${name}" SourceID="${asset?.masterMobId ?? ""}" SourceMobSlotID="${dataDefinition === "Picture" ? 1 : 2}" StartTime="${startFrames}" Length="${durationFrames}">
                            <Comment>${comment}</Comment>
                        </SourceClip>`;
  if (dataDefinition !== "Picture" || clip.punchIn !== true) {
    return clipXml;
  }
  return `                        <OperationGroup DataDefinition="Picture" Name="punch-in ${name}" Length="${durationFrames}" OperationDefinition="VideoScale">
                            <Comment>punch-in Scale ${Math.round(PUNCH_IN_SCALE * 100)}</Comment>
                            <InputSegments>
${clipXml}
                            </InputSegments>
                            <Parameters>
                                <Parameter Name="Scale" Identification="AvidResizeEffect">
                                    <Value>${Math.round(PUNCH_IN_SCALE * 100)}</Value>
                                </Parameter>
                            </Parameters>
                        </OperationGroup>`;
}

function masterMobXml(asset: CameraAsset): string {
  const name = xmlEscape(asset.fileName);
  return `        <MasterMob MobID="${asset.masterMobId}" Name="${name}">
            <TimelineMobSlot SlotID="1" Name="Picture" EditRate="${FRAME_RATE}/1">
                <SourceClip DataDefinition="Picture" SourceID="${asset.sourceMobId}" SourceMobSlotID="1" StartTime="0" Length="${asset.durationFrames}"/>
            </TimelineMobSlot>
            <TimelineMobSlot SlotID="2" Name="Sound" EditRate="${FRAME_RATE}/1">
                <SourceClip DataDefinition="Sound" SourceID="${asset.sourceMobId}" SourceMobSlotID="2" StartTime="0" Length="${asset.durationFrames}"/>
            </TimelineMobSlot>
        </MasterMob>`;
}

function sourceMobXml(asset: CameraAsset): string {
  const name = xmlEscape(asset.fileName);
  return `        <SourceMob MobID="${asset.sourceMobId}" Name="${name}">
            <TimelineMobSlot SlotID="1" Name="Picture" EditRate="${FRAME_RATE}/1">
                <SourceClip DataDefinition="Picture" SourceID="0" SourceMobSlotID="0" StartTime="0" Length="${asset.durationFrames}"/>
            </TimelineMobSlot>
            <TimelineMobSlot SlotID="2" Name="Sound" EditRate="${FRAME_RATE}/1">
                <SourceClip DataDefinition="Sound" SourceID="0" SourceMobSlotID="0" StartTime="0" Length="${asset.durationFrames}"/>
            </TimelineMobSlot>
            <EssenceDescriptor>
                <ImportDescriptor>
                    <Locator>
                        <NetworkLocator URL="${xmlEscape(asset.src)}"/>
                    </Locator>
                </ImportDescriptor>
                <CDCIDescriptor StoredWidth="1280" StoredHeight="720" FrameLayout="FullFrame" ImageAspectRatio="16/9" ComponentWidth="8" HorizontalSubsampling="2" VerticalSubsampling="1"/>
                <PCMDescriptor AudioSampleRate="48000/1" QuantizationBits="16" Channels="2"/>
            </EssenceDescriptor>
        </SourceMob>`;
}

function collectCameraAssets(input: NleInput, kept: ScoredClip[]): CameraAsset[] {
  const cameras = usedCameras(kept);
  const sourceDurationMs =
    input.sourceDurationMs && input.sourceDurationMs > 0
      ? input.sourceDurationMs
      : Math.max(1000, ...kept.map((clip) => clip.endMs), 0);
  return cameras.map((camera) => {
    const fileName =
      input.cameras?.find((item) => item.id === camera)?.fileName ??
      input.fileName;
    return {
      camera,
      fileName,
      src: toFileUrl(fileName),
      durationFrames: Math.max(1, toFrames(sourceDurationMs)),
      masterMobId: mobId("master", camera),
      sourceMobId: mobId("source", camera),
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

function nleComment(clip: ScoredClip): string {
  return [
    clip.reason,
    `keepScore=${clip.keepScore.toFixed(3)}`,
    `CAM ${clip.camera ?? "A"}`,
    clip.verdict,
    clip.punchIn ? "punch-in" : "",
  ]
    .filter(Boolean)
    .join(" ");
}

function toFrames(ms: number): number {
  return Math.max(0, Math.round((ms / 1000) * FRAME_RATE));
}

function mobId(kind: MobKind, key: string): string {
  const kindByte =
    kind === "composition" ? "01" : kind === "master" ? "02" : "03";
  const material = hashKey(key).padStart(8, "0").slice(0, 8);
  return `urn:smpte:umid:060a2b34.01010105.01010f00.13000000.00000000.00000000.${kindByte}000000.${material}`;
}

function hashKey(key: string): string {
  let hash = 0;
  for (let index = 0; index < key.length; index += 1) {
    hash = (hash * 31 + key.charCodeAt(index)) | 0;
  }
  return Math.abs(hash).toString(16);
}

function xmlEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
