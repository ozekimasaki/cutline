import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { describe, it } from "node:test";
import { buildEditUnits } from "./units";
import { mockTranscript } from "./sample";
import {
  SHORT_TALK_DURATION_MS,
  isShortTalkFile,
  shortTalkCues,
} from "./short-talk";

const execFileAsync = promisify(execFile);

describe("short talk sample", () => {
  it("keeps two speakers, fillers, and a retake inside 30 to 50 seconds", () => {
    const cues = shortTalkCues();
    const end = cues.at(-1)?.endMs ?? 0;
    assert.equal(end, SHORT_TALK_DURATION_MS);
    assert.ok(end >= 30_000 && end <= 50_000);
    assert.deepEqual(
      [...new Set(cues.map((cue) => cue.speaker))].sort(),
      ["A", "B"],
    );
    const units = buildEditUnits(cues);
    assert.ok(units.some((unit) => unit.role === "filler" && unit.text === "えー"));
    assert.ok(units.some((unit) => unit.role === "filler" && unit.text === "あの"));
    assert.ok(units.some((unit) => unit.role === "self_correction" && unit.text.includes("いや")));
  });

  it("does not replace the 24s sample transcript", () => {
    assert.equal(isShortTalkFile("sample.mp4"), false);
    assert.equal(mockTranscript(24_000).at(-1)?.text, "……あります。");
    assert.equal(mockTranscript(24_000).at(-1)?.endMs, 24_000);
  });

  it("ships a wav and an mp4 of the same dialogue", async () => {
    const dir = path.join(process.cwd(), "samples", "short-talk");
    const wav = path.join(dir, "dialogue.wav");
    const mp4 = path.join(dir, "dialogue.mp4");
    const wavStat = await stat(wav);
    const mp4Stat = await stat(mp4);
    assert.ok(wavStat.size > 100_000);
    assert.ok(mp4Stat.size > 50_000);
    const wavSec = await probeDurationSec(wav);
    const mp4Sec = await probeDurationSec(mp4);
    assert.ok(wavSec >= 30 && wavSec <= 50);
    assert.ok(Math.abs(wavSec - mp4Sec) < 0.2);
    assert.ok(Math.abs(wavSec * 1000 - SHORT_TALK_DURATION_MS) < 50);
  });
});

async function probeDurationSec(filePath: string): Promise<number> {
  const { stdout } = await execFileAsync("ffprobe", [
    "-v",
    "error",
    "-show_entries",
    "format=duration",
    "-of",
    "csv=p=0",
    filePath,
  ]);
  return Number(stdout.trim());
}
