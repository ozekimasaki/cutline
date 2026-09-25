import type { Perception, TranscriptCue } from "./types";

/** Job file name for the bundled short dialogue. */
export const SHORT_TALK_FILE = "short-talk.mp4";

/** Measured end of samples/short-talk/dialogue.wav. */
export const SHORT_TALK_DURATION_MS = 42_336;

const SHORT_TALK_CUES: TranscriptCue[] = [
  {
    speaker: "A",
    text: "えー、あの、今日の昼、何にしようか。",
    startMs: 0,
    endMs: 4341,
  },
  { speaker: "B", text: "カレーがいいな。", startMs: 4621, endMs: 5699 },
  {
    speaker: "A",
    text: "カレー。いや、カレーは材料がない。",
    startMs: 6019,
    endMs: 9976,
  },
  { speaker: "A", text: "うどんにしよう。", startMs: 10236, endMs: 11473 },
  { speaker: "B", text: "あの、つゆはある？", startMs: 11773, endMs: 13587 },
  { speaker: "A", text: "えーっと、つゆはあった。", startMs: 14447, endMs: 16719 },
  { speaker: "B", text: "じゃあ、それでいいよ。", startMs: 17019, endMs: 18832 },
  { speaker: "A", text: "あの、ねぎも切る？", startMs: 19112, endMs: 21139 },
  {
    speaker: "B",
    text: "うん。ねぎは苦手。いや、苦手じゃない。量が多いとだめなだけ。",
    startMs: 21459,
    endMs: 27475,
  },
  { speaker: "A", text: "じゃあ、少しだけにする。", startMs: 27775, endMs: 30153 },
  { speaker: "B", text: "あの、卵もある？", startMs: 30433, endMs: 32289 },
  { speaker: "A", text: "あった。いや、一個だけだ。", startMs: 32589, endMs: 36024 },
  { speaker: "A", text: "半分こにしよう。", startMs: 36264, endMs: 37757 },
  { speaker: "B", text: "えー、お茶も淹れておくね。", startMs: 38037, endMs: 40245 },
  { speaker: "A", text: "うん、お願い。", startMs: 40565, endMs: 42336 },
];

export function isShortTalkFile(fileName: string): boolean {
  const base = fileName.split(/[/\\]/).pop() ?? fileName;
  return base === SHORT_TALK_FILE;
}

export function shortTalkCues(): TranscriptCue[] {
  return SHORT_TALK_CUES.map((cue) => ({ ...cue }));
}

export function shortTalkPerception(durationMs: number): Perception {
  return {
    title: "短い対談",
    durationMs: durationMs > 0 ? durationMs : SHORT_TALK_DURATION_MS,
    language: "ja",
    summary: "昼ごはんをうどんにする。",
    storyline: "カレーをやめて、うどんにする。",
    topics: ["昼ごはん"],
    keyMoments: ["うどんにしよう"],
    participants: [
      { id: "A", role: "host" },
      { id: "B", role: "guest" },
    ],
    brollCues: [],
    source: "mock",
  };
}
