import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildTimelineIR } from "./decide";
import {
  BROLL_CAMERA,
  BROLL_SLATE_FILE,
  brollClipsOf,
  collectBrollNeeds,
  insertBroll,
  parseOmniBrollCues,
} from "./broll";
import { BROLL_TAG, type JevSignals, type ScoredClip, type Topic } from "./types";

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

function chapter(
  title: string,
  startMs: number,
  endMs: number,
  extra: Partial<Topic> = {},
): Topic {
  return {
    id: extra.id ?? `topic_${title}`,
    title,
    importance: extra.importance ?? "medium",
    startMs,
    endMs,
    redundancy: extra.redundancy ?? 0.1,
    narrativeDependency: extra.narrativeDependency ?? 0.4,
    viewerValue: extra.viewerValue ?? 0.5,
    removability: extra.removability ?? 0.2,
  };
}

function timelineOf(clips: ScoredClip[]) {
  return buildTimelineIR({
    timelineId: "job-broll",
    fileName: "cam_a.mp4",
    clips,
  });
}

describe("parseOmniBrollCues", () => {
  it("reads B_ROLL_RECOMMENDED objects and keyMoment tags", () => {
    const cues = parseOmniBrollCues({
      brollCues: [
        {
          tag: BROLL_TAG,
          startMs: 9000,
          endMs: 13200,
          topic: "役割分担",
        },
      ],
      keyMoments: ["B_ROLL_RECOMMENDED: 画面収録 12.0-15.5", "フック"],
      topics: ["開始時期"],
    });
    assert.equal(cues.length, 2);
    assert.equal(cues[0]?.tag, BROLL_TAG);
    assert.equal(cues[0]?.topic, "役割分担");
    assert.equal(cues[1]?.topic, "画面収録");
    assert.equal(cues[1]?.startMs, 12000);
    assert.equal(cues[1]?.endMs, 15500);
  });

  it("ignores stock-style tags that are not B_ROLL_RECOMMENDED", () => {
    const cues = parseOmniBrollCues({
      brollCues: [{ tag: "STOCK_SEARCH", startMs: 0, endMs: 4000 }],
    });
    assert.equal(cues.length, 0);
  });
});

describe("insertBroll", () => {
  it("inserts Omni B_ROLL_RECOMMENDED as a V2 overlay on Timeline IR", () => {
    const clips = [clip("talk", 9000, 13200, { camera: "A", text: "判断は Jev" })];
    const ir = insertBroll(timelineOf(clips), {
      clips,
      cues: [
        {
          tag: BROLL_TAG,
          startMs: 9000,
          endMs: 13200,
          topic: "役割分担",
        },
      ],
    });
    const overlays = brollClipsOf(ir);
    assert.equal(ir.clips.length, 1);
    assert.equal(ir.clips[0]?.kind, undefined);
    assert.equal(overlays.length, 1);
    assert.equal(overlays[0]?.kind, "broll");
    assert.equal(overlays[0]?.track, "V2");
    assert.equal(overlays[0]?.camera, BROLL_CAMERA);
    assert.equal(overlays[0]?.decision.reason, BROLL_TAG);
    assert.equal(overlays[0]?.broll?.tag, BROLL_TAG);
    assert.equal(overlays[0]?.broll?.motive, "omni_cue");
    assert.equal(overlays[0]?.broll?.placeholder, true);
    assert.equal(overlays[0]?.source, BROLL_SLATE_FILE);
    assert.equal(overlays[0]?.timelineIn, 0);
    assert.ok((overlays[0]?.sourceOut ?? 0) >= 0.6);
    assert.doesNotMatch(overlays[0]?.source ?? "", /stock|unsplash|pexels/i);
  });

  it("covers a remaining same-camera jump cut", () => {
    const clips = [
      clip("keep1", 0, 2000, { camera: "A" }),
      clip("cut", 2000, 5000, { verdict: "cut", camera: "A" }),
      clip("keep2", 5000, 8000, {
        camera: "A",
        punchIn: true,
        cameraReason: "jump cut を punch-in で隠す",
      }),
    ];
    const ir = insertBroll(timelineOf(clips), { clips });
    const overlays = brollClipsOf(ir);
    assert.equal(ir.clips.length, 2);
    assert.equal(overlays.length, 1);
    assert.equal(overlays[0]?.broll?.motive, "jump_cut");
    assert.equal(overlays[0]?.timelineIn, 2);
    assert.equal(overlays[0]?.decision.reason, BROLL_TAG);
  });

  it("does not add jump-cut B-roll when a wide reset already covers the gap", () => {
    const clips = [
      clip("keep1", 0, 2000, { camera: "A" }),
      clip("cut", 2000, 5000, { verdict: "cut" }),
      clip("keep2", 5000, 8000, {
        camera: "WIDE",
        cameraReason: "wide reset",
      }),
    ];
    const ir = insertBroll(timelineOf(clips), { clips, chapters: [] });
    assert.equal(brollClipsOf(ir).length, 0);
    assert.deepEqual(
      collectBrollNeeds({ clips, chapters: [] }).map((need) => need.motive),
      [],
    );
  });

  it("recommends B-roll on a high-importance topic without fetching stock", () => {
    const clips = [
      clip("intro", 0, 2000, { camera: "A", text: "自己紹介です" }),
      clip("core", 2000, 6000, { camera: "B", text: "判断は Jev に分けています" }),
    ];
    const ir = insertBroll(timelineOf(clips), {
      clips,
      chapters: [
        chapter("自己紹介", 0, 2000, { importance: "medium", viewerValue: 0.4 }),
        chapter("役割分担", 2000, 6000, { importance: "high", viewerValue: 0.86 }),
      ],
    });
    const overlays = brollClipsOf(ir);
    assert.equal(ir.clips.every((clip) => clip.kind !== "broll"), true);
    assert.equal(overlays.length, 1);
    assert.equal(overlays[0]?.broll?.motive, "topic_visual");
    assert.equal(overlays[0]?.broll?.label, "役割分担");
    assert.equal(overlays[0]?.source, BROLL_SLATE_FILE);
    assert.equal(overlays[0]?.broll?.placeholder, true);
  });

  it("dedupes overlapping Omni and topic covers into one Omni cue", () => {
    const clips = [clip("core", 2000, 6000, { camera: "A", text: "判断は Jev" })];
    const ir = insertBroll(timelineOf(clips), {
      clips,
      chapters: [
        chapter("役割分担", 2000, 6000, { importance: "high", viewerValue: 0.9 }),
      ],
      cues: [
        { tag: BROLL_TAG, startMs: 2000, endMs: 5000, topic: "役割分担" },
      ],
    });
    const overlays = brollClipsOf(ir);
    assert.equal(overlays.length, 1);
    assert.equal(overlays[0]?.broll?.motive, "omni_cue");
  });

  it("leaves Timeline IR unchanged when conversation does not need cover", () => {
    const clips = [
      clip("a", 0, 2000, { camera: "A" }),
      clip("b", 2000, 3500, { camera: "B", speaker: "B" }),
    ];
    const base = timelineOf(clips);
    const ir = insertBroll(base, { clips, chapters: [] });
    assert.deepEqual(ir, base);
  });
});
