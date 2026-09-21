import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  asrCacheKind,
  collectMicTracks,
  cuesFromTranscription,
  filetransParameters,
  mergeMicTranscripts,
  micIndexFromSource,
  parseSpeakerCountHint,
  planSpeakerProcessing,
  resolveTranscriptSpeakers,
  speakerIdFromDiarizationIndex,
  speakerIdFromIndex,
  uniqueSpeakerIds,
  withTimelineSpeakers,
} from "./speaker";
import type { TimelineIR, TranscriptCue } from "./types";

const MIX_CUES: TranscriptCue[] = [
  { speaker: "A", text: "えー", startMs: 0, endMs: 700 },
  { speaker: "A", text: "去年", startMs: 700, endMs: 1400 },
  { speaker: "B", text: "へえ", startMs: 8200, endMs: 8800 },
];

describe("speakerIdFromIndex", () => {
  it("maps 0,1,2… beyond two speakers", () => {
    assert.equal(speakerIdFromIndex(0), "A");
    assert.equal(speakerIdFromIndex(1), "B");
    assert.equal(speakerIdFromIndex(2), "C");
    assert.equal(speakerIdFromIndex(3), "D");
    assert.equal(speakerIdFromIndex(25), "Z");
    assert.equal(speakerIdFromIndex(26), "AA");
  });
});

describe("parseSpeakerCountHint", () => {
  it("accepts Filetrans range 2–100 only", () => {
    assert.equal(parseSpeakerCountHint(2), 2);
    assert.equal(parseSpeakerCountHint("4"), 4);
    assert.equal(parseSpeakerCountHint(1), undefined);
    assert.equal(parseSpeakerCountHint(101), undefined);
    assert.equal(parseSpeakerCountHint(""), undefined);
  });
});

describe("planSpeakerProcessing", () => {
  it("enables mix diarization with optional speaker_count", () => {
    const plan = planSpeakerProcessing({
      sources: [{ fileName: "mix.wav", audioChannels: 1 }],
      mixChannels: 1,
      speakerCountHint: 3,
    });
    assert.equal(plan.mode, "mix-diarization");
    assert.equal(plan.diarizationEnabled, true);
    assert.equal(plan.speakerCount, 3);
    assert.deepEqual(
      plan.speakers.map((speaker) => speaker.id),
      ["A", "B", "C"],
    );
    const params = filetransParameters(plan);
    assert.equal(params.diarization_enabled, true);
    assert.equal(params.speaker_count, 3);
    assert.deepEqual(params.channel_id, [0]);
    assert.match(plan.notes.join("\n"), /Jev は話者を選ばない/);
  });

  it("keeps the A/B mix path when speaker_count is omitted", () => {
    const plan = planSpeakerProcessing({ mixChannels: 1 });
    assert.deepEqual(
      plan.speakers.map((speaker) => speaker.id),
      ["A", "B"],
    );
    assert.equal(plan.speakerCount, undefined);
    assert.equal("speaker_count" in filetransParameters(plan), false);
  });

  it("does not run diarization on multi-channel mix", () => {
    const plan = planSpeakerProcessing({
      mixChannels: 2,
      speakerCountHint: 4,
    });
    assert.equal(plan.mode, "mix");
    assert.equal(plan.diarizationEnabled, false);
    assert.equal(plan.speakerCount, undefined);
    const params = filetransParameters(plan);
    assert.equal("diarization_enabled" in params, false);
    assert.equal("speaker_count" in params, false);
    assert.match(plan.notes.join("\n"), /multi-channel/);
  });

  it("trusts Mic 1→A, Mic 2→B and further tracks as C/D", () => {
    const plan = planSpeakerProcessing({
      mixChannels: 1,
      speakerCountHint: 2,
      sources: [
        { fileName: "CAM_A.mp4", role: "cam_a", audioChannels: 2 },
        { fileName: "MIC_A.wav", role: "mic_a", filePath: "/tmp/MIC_A.wav" },
        { fileName: "mic-b.wav", role: "mic_b", filePath: "/tmp/mic-b.wav" },
        { fileName: "MIC_C.wav", filePath: "/tmp/MIC_C.wav" },
        { fileName: "Mic 4.wav", filePath: "/tmp/Mic4.wav" },
      ],
    });
    assert.equal(plan.mode, "per-mic");
    assert.equal(plan.diarizationEnabled, false);
    assert.equal(plan.speakerCount, undefined);
    assert.deepEqual(
      plan.speakers.map((speaker) => speaker.id),
      ["A", "B", "C", "D"],
    );
    assert.equal(plan.speakers[0]?.micIndex, 0);
    assert.equal(plan.speakers[3]?.id, "D");
    assert.equal("diarization_enabled" in filetransParameters(plan), false);
    assert.match(plan.notes.join("\n"), /AI話者推定は使わない/);
  });

  it("notes the 2 hour diarization recommendation", () => {
    const plan = planSpeakerProcessing({
      mixChannels: 1,
      durationMs: 2 * 60 * 60 * 1000 + 1,
    });
    assert.match(plan.notes.join("\n"), /2 時間以内/);
  });

  it("does not combine diarization with extra channel_id", () => {
    const params = filetransParameters({
      diarizationEnabled: true,
      speakerCount: 2,
      channelId: [0, 1],
    });
    assert.equal(params.diarization_enabled, true);
    assert.deepEqual(params.channel_id, [0]);
  });
});

describe("mic detection", () => {
  it("maps roles and filenames, ignoring cameras", () => {
    assert.equal(micIndexFromSource({ fileName: "x", role: "mic_a" }), 0);
    assert.equal(micIndexFromSource({ fileName: "x", role: "mic_b" }), 1);
    assert.equal(micIndexFromSource({ fileName: "MIC_C.wav" }), 2);
    assert.equal(micIndexFromSource({ fileName: "Mic 1.wav" }), 0);
    assert.equal(micIndexFromSource({ fileName: "CAM_A.mp4", role: "cam_a" }), undefined);
    assert.equal(micIndexFromSource({ fileName: "interview.mp4" }), undefined);
    const tracks = collectMicTracks([
      { fileName: "MIC_B.wav" },
      { fileName: "MIC_A.wav" },
    ]);
    assert.deepEqual(
      tracks.map((track) => track.id),
      ["A", "B"],
    );
  });
});

describe("cuesFromTranscription", () => {
  it("maps speaker_id 0,1,2 to A,B,C", () => {
    const cues = cuesFromTranscription({
      transcripts: [
        {
          channel_id: 0,
          sentences: [
            { begin_time: 100, end_time: 800, text: "hello", speaker_id: 0 },
            { begin_time: 900, end_time: 1200, text: "hi", speaker_id: 1 },
            { begin_time: 1300, end_time: 2000, text: "there", speaker_id: 2 },
          ],
        },
      ],
    });
    assert.deepEqual(
      cues.map((cue) => cue.speaker),
      ["A", "B", "C"],
    );
    assert.equal(cues[0]?.startMs, 100);
    assert.equal(speakerIdFromDiarizationIndex(0), "A");
    assert.equal(speakerIdFromDiarizationIndex("1"), "B");
  });

  it("keeps letter labels from the current A/B path", () => {
    const cues = cuesFromTranscription({
      sentences: [
        { begin_time: 0, end_time: 500, text: "えー", speaker: "A" },
        { begin_time: 800, end_time: 1100, text: "へえ", speaker: "B" },
      ],
    });
    assert.deepEqual(
      cues.map((cue) => cue.speaker),
      ["A", "B"],
    );
  });
});

describe("resolveTranscriptSpeakers", () => {
  it("keeps current A/B cues on the mix path", () => {
    const plan = planSpeakerProcessing({ mixChannels: 1 });
    const resolved = resolveTranscriptSpeakers({ cues: MIX_CUES, plan });
    assert.deepEqual(
      resolved.cues.map((cue) => cue.speaker),
      ["A", "A", "B"],
    );
  });

  it("merges per-mic transcripts and ignores mix AI labels", () => {
    const plan = planSpeakerProcessing({
      sources: [
        { fileName: "MIC_A.wav", filePath: "/tmp/a.wav" },
        { fileName: "MIC_B.wav", filePath: "/tmp/b.wav" },
        { fileName: "MIC_C.wav", filePath: "/tmp/c.wav" },
      ],
    });
    const resolved = resolveTranscriptSpeakers({
      cues: MIX_CUES,
      plan,
      micTranscripts: [
        {
          speakerId: "A",
          cues: [{ speaker: "X", text: "ホスト", startMs: 0, endMs: 1000 }],
        },
        {
          speakerId: "B",
          cues: [{ speaker: "X", text: "ゲスト", startMs: 400, endMs: 900 }],
        },
        {
          speakerId: "C",
          cues: [{ speaker: "X", text: "観客", startMs: 2000, endMs: 2400 }],
        },
      ],
    });
    assert.deepEqual(
      resolved.cues.map((cue) => `${cue.speaker}:${cue.text}`),
      ["A:ホスト", "B:ゲスト", "C:観客"],
    );
    assert.match(resolved.notes.join("\n"), /AI話者推定はスキップ/);
  });

  it("interleaves overlapping mic cues by time", () => {
    const merged = mergeMicTranscripts([
      {
        speakerId: "B",
        cues: [{ speaker: "B", text: "un", startMs: 500, endMs: 800 }],
      },
      {
        speakerId: "A",
        cues: [{ speaker: "A", text: "ah", startMs: 0, endMs: 400 }],
      },
    ]);
    assert.deepEqual(
      merged.map((cue) => cue.speaker),
      ["A", "B"],
    );
  });
});

describe("timeline speakers", () => {
  it("stores more than two speaker ids on Timeline IR", () => {
    const timeline: TimelineIR = {
      timelineId: "t1",
      clips: [
        clip("A"),
        clip("C"),
        clip("D"),
      ],
      removals: [],
    };
    const next = withTimelineSpeakers(timeline, [
      { id: "A", source: "mic", micIndex: 0 },
      { id: "C", source: "mic", micIndex: 2 },
      { id: "D", source: "mic", micIndex: 3 },
    ]);
    assert.deepEqual(
      next.speakers?.map((speaker) => speaker.id),
      ["A", "C", "D"],
    );
    assert.deepEqual(uniqueSpeakerIds(timeline.clips), ["A", "C", "D"]);
    assert.deepEqual(
      uniqueSpeakerIds([...timeline.clips, { speaker: "" }]),
      ["A", "C", "D"],
    );
  });
});

describe("asrCacheKind", () => {
  it("changes when diarization or speaker_count changes", () => {
    const mix = planSpeakerProcessing({ mixChannels: 1, speakerCountHint: 2 });
    const stereo = planSpeakerProcessing({ mixChannels: 2 });
    assert.notEqual(asrCacheKind(mix), asrCacheKind(stereo));
    assert.match(asrCacheKind(mix), /mix-diarization/);
  });
});

function clip(speaker: string) {
  return {
    source: "cam.mp4",
    sourceIn: 0,
    sourceOut: 1,
    timelineIn: 0,
    camera: "A",
    speaker,
    decision: { reason: "content", confidence: 0.9 },
  };
}
