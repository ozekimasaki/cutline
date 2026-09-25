import type { EditUnit, JevSignals, Perception, TranscriptCue } from "./types";
import { sampleDurationMs } from "./ffmpeg";
import { isShortTalkFile, shortTalkPerception } from "./short-talk";

export function mockPerception(input: {
  durationMs: number;
  fileName: string;
  brief: string;
}): Perception {
  if (isShortTalkFile(input.fileName)) {
    return shortTalkPerception(input.durationMs);
  }
  return {
    title: input.fileName.replace(/\.[^.]+$/, "") || "無題の素材",
    durationMs: input.durationMs > 0 ? input.durationMs : sampleDurationMs(),
    language: "ja",
    summary:
      input.brief.trim() ||
      "対談の言い直しとフィラーを落とし、考えている間は残す。",
    storyline:
      "ホストが開始時期を言い直し、ゲストが転職の話を聞き、ホストが間を置いて答える。",
    topics: ["開始時期", "役割分担", "転職"],
    keyMoments: ["今年の2月から始めました", "会社辞めようと思ったことあります？"],
    participants: [
      { id: "A", role: "host" },
      { id: "B", role: "guest" },
    ],
    brollCues: [
      {
        tag: "B_ROLL_RECOMMENDED",
        startMs: 9000,
        endMs: 13200,
        topic: "役割分担",
      },
    ],
    source: "mock",
  };
}

export function mockTranscript(durationMs: number): TranscriptCue[] {
  const scale = (durationMs > 0 ? durationMs : sampleDurationMs()) / sampleDurationMs();
  return SAMPLE_CUES.map((cue) => ({
    ...cue,
    startMs: Math.round(cue.startMs * scale),
    endMs: Math.round(cue.endMs * scale),
  }));
}

export function mockSignals(unit: EditUnit): JevSignals {
  switch (unit.role) {
    case "filler":
      return signals({
        importance: 0.04,
        novelty: 0.02,
        redundancy: 0.2,
        filler: 0.96,
        humanTexture: 0.35,
        removalNatural: 0.97,
        confidence: 0.97,
      });
    case "false_start":
      return signals({
        importance: 0.08,
        novelty: 0.04,
        redundancy: 0.7,
        falseStart: 0.94,
        selfCorrection: 0.2,
        removalNatural: 0.95,
        confidence: 0.96,
      });
    case "self_correction":
      return signals({
        importance: 0.12,
        novelty: 0.05,
        redundancy: 0.88,
        falseStart: 0.35,
        selfCorrection: 0.93,
        contextRequired: 0.1,
        removalNatural: 0.9,
        confidence: 0.93,
      });
    case "pause":
      return unit.pauseClass === "thinking" || unit.pauseClass === "long"
        ? signals({
            importance: 0.42,
            humanTexture: 0.78,
            filler: 0.1,
            removalNatural: 0.28,
            reviewRequired: 0.22,
            confidence: 0.72,
          })
        : signals({
            importance: 0.06,
            humanTexture: 0.12,
            filler: 0.4,
            removalNatural: 0.88,
            confidence: 0.91,
          });
    case "backchannel":
      return signals({
        importance: 0.22,
        novelty: 0.08,
        humanTexture: 0.7,
        reactionValue: 0.55,
        removalNatural: 0.45,
        reviewRequired: 0.18,
        confidence: 0.74,
      });
    case "content":
      return signals({
        importance: 0.82,
        novelty: 0.64,
        contextRequired: 0.7,
        humanTexture: 0.4,
        reactionValue: 0.2,
        confidence: 0.92,
      });
    default: {
      const _never: never = unit.role;
      return _never;
    }
  }
}

function signals(partial: Partial<JevSignals>): JevSignals {
  return {
    importance: 0.2,
    novelty: 0.2,
    redundancy: 0.1,
    contextRequired: 0.15,
    filler: 0.05,
    falseStart: 0.04,
    selfCorrection: 0.04,
    tangent: 0.05,
    humanTexture: 0.2,
    removalNatural: 0.2,
    reactionValue: 0.1,
    reviewRequired: 0.08,
    confidence: 0.85,
    provider: "mock",
    ...partial,
  };
}

const SAMPLE_CUES: TranscriptCue[] = [
  { speaker: "A", text: "えー", startMs: 0, endMs: 700 },
  { speaker: "A", text: "去年", startMs: 700, endMs: 1400 },
  { speaker: "A", text: "いや去年じゃないですね", startMs: 1500, endMs: 3400 },
  { speaker: "A", text: "今年の2月から始めました", startMs: 3500, endMs: 6200 },
  { speaker: "B", text: "へえ", startMs: 8200, endMs: 8800 },
  {
    speaker: "A",
    text: "知覚は Qwen、判断は Jev に分けています",
    startMs: 9000,
    endMs: 13200,
  },
  { speaker: "A", text: "えーっと", startMs: 13400, endMs: 14200 },
  {
    speaker: "A",
    text: "不確かなところだけ人が見ます",
    startMs: 14400,
    endMs: 17600,
  },
  {
    speaker: "B",
    text: "会社辞めようと思ったことあります？",
    startMs: 17800,
    endMs: 19800,
  },
  { speaker: "A", text: "……あります。", startMs: 22800, endMs: 24000 },
];
