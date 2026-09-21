import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildEditUnits } from "./units";
import type { TranscriptCue } from "./types";

const cues: TranscriptCue[] = [
  { speaker: "A", text: "えー", startMs: 0, endMs: 700 },
  { speaker: "A", text: "去年", startMs: 700, endMs: 1400 },
  { speaker: "A", text: "いや去年じゃないですね", startMs: 1500, endMs: 3400 },
  { speaker: "A", text: "今年の2月から始めました", startMs: 3500, endMs: 6200 },
  { speaker: "B", text: "へえ", startMs: 8200, endMs: 8800 },
];

describe("buildEditUnits", () => {
  it("tags filler, false start, self correction, and pauses", () => {
    const units = buildEditUnits(cues);
    assert.equal(units.find((unit) => unit.text === "えー")?.role, "filler");
    assert.equal(units.find((unit) => unit.text === "去年")?.role, "false_start");
    assert.equal(
      units.find((unit) => unit.text === "いや去年じゃないですね")?.role,
      "self_correction",
    );
    const pause = units.find((unit) => unit.role === "pause");
    assert.ok(pause);
    assert.equal(pause?.pauseClass, "long");
    assert.equal(pause?.startMs, 6200);
    assert.equal(pause?.endMs, 8200);
  });

  it("splits a long cue on punctuation, self-correction, and semantic boundary", () => {
    const units = buildEditUnits([
      {
        speaker: "A",
        text: "えー、去年……いや去年じゃないですね。今年の2月から始めました。",
        startMs: 0,
        endMs: 6200,
      },
      { speaker: "B", text: "へえ", startMs: 8200, endMs: 8800 },
    ]);
    const spoken = units
      .filter((unit) => unit.role !== "pause")
      .map((unit) => unit.text);
    assert.deepEqual(spoken, [
      "えー",
      "去年",
      "いや去年じゃないですね",
      "今年の2月から始めました",
      "へえ",
    ]);
    assert.equal(units.find((unit) => unit.text === "えー")?.role, "filler");
    assert.equal(units.find((unit) => unit.text === "去年")?.role, "false_start");
    assert.equal(
      units.find((unit) => unit.text === "いや去年じゃないですね")?.role,
      "self_correction",
    );
    assert.equal(
      units.find((unit) => unit.text === "今年の2月から始めました")?.role,
      "content",
    );
    const pause = units.find((unit) => unit.role === "pause");
    assert.ok(pause);
    assert.equal(pause?.pauseClass, "long");
    assert.equal(pause?.startMs, 6200);
    assert.equal(pause?.endMs, 8200);
    const times = units.map((unit) => [unit.startMs, unit.endMs]);
    for (let index = 1; index < times.length; index += 1) {
      assert.ok((times[index - 1]?.[1] ?? 0) <= (times[index]?.[0] ?? 0));
    }
  });

  it("splits on a conjunction after a comma", () => {
    const units = buildEditUnits([
      {
        speaker: "A",
        text: "役割は決まっていて、そして実装に入りました",
        startMs: 0,
        endMs: 4000,
      },
    ]);
    assert.deepEqual(
      units.map((unit) => unit.text),
      ["役割は決まっていて", "そして実装に入りました"],
    );
    assert.equal(units[0]?.endMs, units[1]?.startMs);
    assert.equal(units[0]?.endMs && units[0].endMs > 0, true);
    assert.equal(units[1]?.endMs, 4000);
  });

  it("does not split a cue with no edit boundary", () => {
    const units = buildEditUnits([
      { speaker: "A", text: "今年の2月から始めました", startMs: 0, endMs: 2700 },
    ]);
    assert.equal(units.length, 1);
    assert.equal(units[0]?.text, "今年の2月から始めました");
    assert.equal(units[0]?.startMs, 0);
    assert.equal(units[0]?.endMs, 2700);
  });

  it("does not split listing commas into word-sized units", () => {
    const units = buildEditUnits([
      {
        speaker: "A",
        text: "知覚は Qwen、判断は Jev に分けています",
        startMs: 9000,
        endMs: 13200,
      },
    ]);
    assert.equal(units.length, 1);
    assert.equal(units[0]?.text, "知覚は Qwen、判断は Jev に分けています");
  });

  it("does not insert pause units for gaps under 250ms", () => {
    const units = buildEditUnits([
      { speaker: "A", text: "えー", startMs: 0, endMs: 700 },
      { speaker: "A", text: "去年", startMs: 700, endMs: 1400 },
    ]);
    assert.equal(
      units.filter((unit) => unit.role === "pause").length,
      0,
    );
  });

  it("keeps original text when a cue is already atomic", () => {
    const units = buildEditUnits([
      { speaker: "A", text: "……あります。", startMs: 5000, endMs: 6200 },
    ]);
    assert.equal(units.length, 1);
    assert.equal(units[0]?.text, "……あります。");
  });
});
