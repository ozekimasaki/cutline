import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { extractJsonObject } from "./json";
import {
  buildConcatList,
  buildFfmpegCommand,
  concatSourceName,
  buildEdl,
  buildOtio,
  buildSrt,
  exportNleFormat,
  keptClips,
} from "./export";
import { buildAaf } from "./aaf";
import { buildFcpxml, buildVtt, buildXmeml, toFileUrl } from "./nle";
import { buildTimelineIR } from "./decide";
import { PRE_HANDLE_MS, POST_HANDLE_MS, withHandles } from "./ffmpeg";
import type { JevSignals, ScoredClip } from "./types";

function signals(partial: Partial<JevSignals> = {}): JevSignals {
  return {
    importance: 0.8,
    novelty: 0.5,
    redundancy: 0.1,
    contextRequired: 0.4,
    filler: 0.05,
    falseStart: 0.04,
    selfCorrection: 0.04,
    tangent: 0.05,
    humanTexture: 0.3,
    removalNatural: 0.2,
    reactionValue: 0.1,
    reviewRequired: 0.08,
    confidence: 0.92,
    provider: "mock",
    ...partial,
  };
}

function clip(
  id: string,
  startMs: number,
  endMs: number,
  extra: Partial<ScoredClip> = {},
): ScoredClip {
  return {
    id,
    speaker: extra.speaker ?? "A",
    text: extra.text ?? id,
    startMs,
    endMs,
    role: extra.role ?? "content",
    signals: extra.signals ?? signals(),
    keepScore: extra.keepScore ?? 0.8,
    autoMarker: false,
    verdict: extra.verdict ?? "keep",
    verdictSource: extra.verdictSource ?? "code",
    reason: extra.reason ?? id,
    camera: extra.camera,
    punchIn: extra.punchIn,
    cameraReason: extra.cameraReason,
  };
}

const clips: ScoredClip[] = [
  clip("c1", 1000, 3000, { reason: "フック", text: "今日は" }),
  clip("c2", 4000, 5000, {
    reason: "間",
    text: "",
    role: "pause",
    verdict: "cut",
    signals: signals({ filler: 0.9, confidence: 0.91 }),
  }),
];

describe("extractJsonObject", () => {
  it("strips fences", () => {
    const parsed = extractJsonObject('```json\n{"title":"x"}\n```') as {
      title: string;
    };
    assert.equal(parsed.title, "x");
  });
});

describe("export", () => {
  it("keeps only keep verdicts", () => {
    assert.deepEqual(
      keptClips(clips).map((item) => item.id),
      ["c1"],
    );
  });

  it("builds an EDL with source and record times", () => {
    const edl = buildEdl({ title: "CutLine", fileName: "sample.mp4", clips });
    assert.match(edl, /TITLE: CutLine/);
    assert.match(edl, /FROM CLIP NAME: sample.mp4/);
    assert.match(edl, /フック/);
    assert.doesNotMatch(edl, /間/);
  });

  it("builds a concat list with inpoint/outpoint", () => {
    const list = buildConcatList(clips, "sample.mp4");
    assert.match(list, /file 'sample.mp4'/);
    assert.match(list, /inpoint 1.000/);
    assert.match(list, /outpoint 3.000/);
  });

  it("uses a basename concat name and drops CR/LF and -safe 0", () => {
    const list = buildConcatList(clips, "subdir/take\r\n.mp4");
    assert.match(list, /file 'take\.mp4'/);
    assert.doesNotMatch(list, /\r/);
    const injected = buildConcatList(clips, "ok.mp4\nfile '/etc/passwd'");
    assert.doesNotMatch(injected, /\/etc\/passwd/);
    assert.match(injected, /file 'passwd'/);
    assert.equal(concatSourceName("C:\\media\\cam.mp4"), "cam.mp4");
    assert.doesNotMatch(buildFfmpegCommand("sample.mp4"), /-safe 0/);
    assert.match(buildFfmpegCommand("sample.mp4"), /ffmpeg -y -f concat -i concat\.txt/);
  });
});

describe("buildTimelineIR", () => {
  it("emits kept clips and removals", () => {
    const ir = buildTimelineIR({
      timelineId: "job-1",
      fileName: "sample.mp4",
      clips,
    });
    assert.equal(ir.timelineId, "job-1");
    assert.equal(ir.clips.length, 1);
    assert.equal(ir.clips[0]?.sourceIn, 1);
    assert.equal(ir.removals.length, 1);
    assert.equal(ir.removals[0]?.reason, "間");
  });
});

describe("subtitles and OTIO", () => {
  it("builds SRT on the edited timeline", () => {
    const srt = buildSrt(clips);
    assert.match(srt, /00:00:00,000 --> 00:00:02,000/);
    assert.match(srt, /今日は/);
    assert.doesNotMatch(srt, /間/);
  });

  it("builds OTIO clips with source range", () => {
    const otio = buildOtio({ title: "CutLine", fileName: "sample.mp4", clips });
    const track = (otio.tracks as { children: Array<{ children: unknown[] }> }).children[0];
    assert.equal(track?.children.length, 1);
    assert.equal(otio.OTIO_SCHEMA, "Timeline.2");
  });

  it("puts camera and review metadata on OTIO clips", () => {
    const otio = buildOtio({
      title: "CutLine",
      fileName: "cam-a.mp4",
      clips: [
        clip("c1", 1000, 3000, {
          camera: "B",
          punchIn: true,
          text: "反応",
        }),
      ],
      cameras: [
        { id: "A", fileName: "cam-a.mp4", label: "CAM A" },
        { id: "B", fileName: "cam-b.mp4", label: "CAM B" },
      ],
    });
    const track = (
      otio.tracks as {
        children: Array<{
          children: Array<{
            media_reference: { target_url: string };
            metadata: { cutline: { camera: string; punchIn: boolean } };
          }>;
        }>;
      }
    ).children[0];
    const child = track?.children[0];
    assert.equal(child?.media_reference.target_url, "cam-b.mp4");
    assert.equal(child?.metadata.cutline.camera, "B");
    assert.equal(child?.metadata.cutline.punchIn, true);
  });
});

describe("NLE file URLs", () => {
  it("keeps only an encoded basename on file://localhost/", () => {
    assert.equal(toFileUrl("cam-b.mp4"), "file://localhost/cam-b.mp4");
    assert.equal(toFileUrl("../../secret.mp4"), "file://localhost/secret.mp4");
    assert.equal(toFileUrl("http://evil.example/cam.mp4"), "file://localhost/cam.mp4");
    assert.equal(toFileUrl("file://localhost/etc/passwd"), "file://localhost/passwd");
    assert.equal(toFileUrl("file:cam.mp4"), "file://localhost/media");
    assert.equal(toFileUrl("http:cam.mp4"), "file://localhost/media");
    assert.equal(toFileUrl(".."), "file://localhost/media");
    assert.equal(toFileUrl("a b.mp4"), "file://localhost/a%20b.mp4");
    const xml = buildFcpxml({
      title: "対談",
      fileName: "../file:/etc/passwd",
      clips: [clip("c1", 1000, 3000, { camera: "A", text: "今日は" })],
    });
    assert.match(xml, /src="file:\/\/localhost\/passwd"/);
    assert.doesNotMatch(xml, /src="[^"]*\.\./);
    assert.doesNotMatch(xml, /src="[^"]*file:\/etc/);
  });
});

describe("NLE interchange", () => {
  const multi: ScoredClip[] = [
    clip("keep-a", 1000, 3000, {
      camera: "A",
      text: "今日は",
      reason: "フック",
    }),
    clip("keep-b", 3000, 5000, {
      camera: "B",
      punchIn: true,
      speaker: "B",
      text: "反応",
      reason: "リアクション",
    }),
    clip("gone", 5000, 6000, { verdict: "cut", text: "えーと" }),
  ];
  const cameras = [
    { id: "A" as const, fileName: "cam-a.mp4", label: "CAM A" },
    { id: "B" as const, fileName: "cam-b.mp4", label: "CAM B" },
    { id: "WIDE" as const, fileName: "cam-wide.mp4", label: "WIDE" },
  ];

  it("builds FCPXML 1.9 with camera assets and punch-in", () => {
    const xml = buildFcpxml({
      title: "対談",
      fileName: "cam-a.mp4",
      clips: multi,
      cameras,
      sourceDurationMs: 24_000,
    });
    assert.match(xml, /fcpxml version="1.9"/);
    assert.match(xml, /cam-a\.mp4/);
    assert.match(xml, /cam-b\.mp4/);
    assert.doesNotMatch(xml, /えーと/);
    assert.match(xml, /adjust-transform scale="1.15 1.15"/);
    assert.match(xml, /CAM B/);
  });

  it("builds FCP 7 XML for Resolve", () => {
    const xml = buildXmeml({
      title: "対談",
      fileName: "cam-a.mp4",
      clips: multi,
      cameras,
    });
    assert.match(xml, /<xmeml version="5">/);
    assert.match(xml, /cam-b\.mp4/);
    assert.match(xml, /<value>115<\/value>/);
    assert.doesNotMatch(xml, /えーと/);
  });

  it("builds AAF-XML with camera SourceMobs and punch-in", () => {
    const input = {
      title: "対談",
      fileName: "cam-a.mp4",
      clips: [
        ...multi,
        clip("keep-wide", 6000, 8000, {
          camera: "WIDE" as const,
          text: "俯瞰",
          reason: "wide",
        }),
      ],
      cameras,
      sourceDurationMs: 24_000,
    };
    const xml = buildAaf(input);
    assert.match(xml, /<AAF xmlns="http:\/\/www.aafassociation.org\/aafx\/1.1"/);
    assert.match(xml, /<CompositionMob /);
    assert.match(xml, /<MasterMob /);
    assert.match(xml, /<SourceMob /);
    assert.match(xml, /cam-a\.mp4/);
    assert.match(xml, /cam-b\.mp4/);
    assert.match(xml, /cam-wide\.mp4/);
    assert.match(xml, /StartTime="30"/);
    assert.match(xml, /OperationDefinition="VideoScale"/);
    assert.match(xml, /<Value>115<\/Value>/);
    assert.match(xml, /CAM B/);
    assert.doesNotMatch(xml, /えーと/);
    const exported = exportNleFormat("aaf", input);
    assert.equal(exported.filename, "video-final.aaf.xml");
    assert.equal(exported.contentType, "application/xml; charset=utf-8");
    assert.equal(exported.body, xml);
  });

  it("builds VTT on the edited timeline", () => {
    const vtt = buildVtt(clips);
    assert.match(vtt, /WEBVTT/);
    assert.match(vtt, /00:00:00.000 --> 00:00:02.000/);
    assert.match(vtt, /今日は/);
  });

  it("adds pre/post handles", () => {
    const handled = withHandles([{ startMs: 1000, endMs: 3000 }], 24_000);
    assert.equal(handled[0]?.startMs, 1000 - PRE_HANDLE_MS);
    assert.equal(handled[0]?.endMs, 3000 + POST_HANDLE_MS);
  });

  it("ships the four Premiere UXP buttons from the spec", () => {
    const html = readFileSync(
      path.join(process.cwd(), "premiere-uxp/index.html"),
      "utf8",
    );
    assert.match(html, /Import CUTLINE Edit/);
    assert.match(html, /Apply AI Edit/);
    assert.match(html, /Review AI Decisions/);
    assert.match(html, /Export Final/);
  });
});
