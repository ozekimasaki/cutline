import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  applyAudioBoundaries,
  isUninformativeWaveform,
  loadWaveform,
  MOCK_SPEECH_INSET_MS,
  mockWaveform,
  PCM_MAX_BUFFER,
  PCM_SLICE_MS,
  pcmByteLength,
  planPcmSlices,
  nearestZeroCrossing,
  parseSilenceDetect,
  PCM_SAMPLE_RATE,
  resolveBoundary,
  snapKeepClips,
  speechFromEnergy,
  waveformFromPcm,
} from "./boundary";
import { POST_HANDLE_MS, PRE_HANDLE_MS, withHandles } from "./ffmpeg";
import type { BoundaryClip } from "./boundary";

const execFileAsync = promisify(execFile);

describe("parseSilenceDetect", () => {
  it("reads ffmpeg silencedetect start/end pairs", () => {
    const ranges = parseSilenceDetect(`
[silencedetect @ 0x] silence_start: 0.400
[silencedetect @ 0x] silence_end: 0.900 | silence_duration: 0.500
[silencedetect @ 0x] silence_start: 1.2
[silencedetect @ 0x] silence_end: 1.5 | silence_duration: 0.3
`);
    assert.equal(ranges.length, 2);
    assert.equal(ranges[0]?.startMs, 400);
    assert.equal(ranges[0]?.endMs, 900);
    assert.equal(ranges[1]?.startMs, 1200);
    assert.equal(ranges[1]?.endMs, 1500);
  });
});

describe("VAD and zero crossing", () => {
  it("finds speech bursts from PCM energy", () => {
    const wave = mockWaveform({
      durationMs: 2000,
      units: [{ startMs: 400, endMs: 1600, role: "content" }],
    });
    const speech = speechFromEnergy(wave.samples, wave.sampleRate);
    assert.ok(speech.length >= 1);
    const first = speech[0];
    assert.ok((first?.startMs ?? 0) >= 360);
    assert.ok((first?.startMs ?? 0) < 500);
    assert.ok((first?.endMs ?? 0) > 1500);
    assert.ok((first?.endMs ?? 0) <= 1680);
  });

  it("snaps to a sample at or next to a sign change", () => {
    const samples = new Int16Array(PCM_SAMPLE_RATE);
    for (let index = 0; index < samples.length; index += 1) {
      samples[index] = index < 80 ? 1200 : index === 80 ? 0 : -1200;
    }
    const timeMs = nearestZeroCrossing(samples, PCM_SAMPLE_RATE, 6, 20);
    assert.equal(timeMs, Math.round((80 / PCM_SAMPLE_RATE) * 1000));
  });
});

describe("mock waveform chain", () => {
  it("is deterministic for the same units", () => {
    const input = {
      durationMs: 24_000,
      units: [
        { startMs: 3500, endMs: 6200, role: "content" },
        { startMs: 6200, endMs: 8200, role: "pause" },
        { startMs: 8200, endMs: 8800, role: "backchannel" },
      ],
    };
    const a = mockWaveform(input);
    const b = mockWaveform(input);
    assert.equal(a.source, "mock");
    assert.equal(a.samples.length, b.samples.length);
    assert.deepEqual([...a.samples.slice(0, 64)], [...b.samples.slice(0, 64)]);
    assert.deepEqual(a.speech, b.speech);
    assert.deepEqual(a.silences, b.silences);
  });

  it("moves KEEP off the semantic timestamp through VAD → silence → zero-cross", () => {
    const waveform = mockWaveform({
      durationMs: 8000,
      units: [
        { startMs: 1000, endMs: 3000, role: "content" },
        { startMs: 3000, endMs: 4500, role: "pause" },
      ],
    });
    const start = resolveBoundary({
      semanticMs: 1000,
      side: "start",
      waveform,
      minMs: 0,
      maxMs: 2500,
    });
    const end = resolveBoundary({
      semanticMs: 3000,
      side: "end",
      waveform,
      minMs: 1500,
      maxMs: 4500,
    });
    assert.notEqual(start.actualMs, start.semanticMs);
    assert.notEqual(end.actualMs, end.semanticMs);
    assert.notEqual(start.vadMs, start.semanticMs);
    assert.ok(start.actualMs >= 1000);
    assert.ok(start.actualMs <= 1000 + MOCK_SPEECH_INSET_MS + 20);
    assert.ok(end.actualMs <= 3000);
    assert.ok(end.actualMs >= 3000 - MOCK_SPEECH_INSET_MS - 20);
    assert.ok(start.silenceMs <= start.vadMs);
    assert.ok(end.silenceMs >= end.vadMs);
    assert.ok(Math.abs(start.zeroCrossMs - start.silenceMs) <= 12);
    assert.ok(Math.abs(end.zeroCrossMs - end.silenceMs) <= 12);
  });
});

describe("snapKeepClips", () => {
  it("changes KEEP trim points and leaves CUT on semantic times", () => {
    const clips: BoundaryClip[] = [
      {
        startMs: 1000,
        endMs: 3000,
        role: "content",
        verdict: "keep",
        verdictSource: "code",
      },
      {
        startMs: 3000,
        endMs: 4200,
        role: "filler",
        verdict: "cut",
        verdictSource: "code",
      },
      {
        startMs: 4200,
        endMs: 6000,
        role: "content",
        verdict: "keep",
        verdictSource: "code",
      },
    ];
    const waveform = mockWaveform({ durationMs: 6000, units: clips });
    const snapped = snapKeepClips(clips, waveform);
    assert.equal(snapped[1]?.startMs, 3000);
    assert.equal(snapped[1]?.endMs, 4200);
    assert.equal(snapped[0]?.semanticStartMs, 1000);
    assert.equal(snapped[0]?.semanticEndMs, 3000);
    assert.notEqual(snapped[0]?.startMs, 1000);
    assert.notEqual(snapped[0]?.endMs, 3000);
    assert.notEqual(snapped[2]?.startMs, 4200);
    assert.ok((snapped[0]?.endMs ?? 0) <= (snapped[2]?.startMs ?? 0));
  });

  it("does not move a user-edited KEEP", () => {
    const clips: BoundaryClip[] = [
      {
        startMs: 1000,
        endMs: 3000,
        role: "content",
        verdict: "keep",
        verdictSource: "user",
      },
    ];
    const waveform = mockWaveform({ durationMs: 4000, units: clips });
    const snapped = snapKeepClips(clips, waveform);
    assert.equal(snapped[0]?.startMs, 1000);
    assert.equal(snapped[0]?.endMs, 3000);
    assert.equal(snapped[0]?.semanticStartMs, 1000);
  });

  it("is idempotent when semantic times are already stored", () => {
    const clips: BoundaryClip[] = [
      {
        startMs: 1000,
        endMs: 4000,
        role: "content",
        verdict: "keep",
        verdictSource: "code",
      },
    ];
    const waveform = mockWaveform({ durationMs: 4000, units: clips });
    const first = snapKeepClips(clips, waveform);
    const second = snapKeepClips(first, waveform);
    assert.equal(second[0]?.startMs, first[0]?.startMs);
    assert.equal(second[0]?.endMs, first[0]?.endMs);
    assert.equal(second[0]?.semanticStartMs, 1000);
  });
});

describe("applyAudioBoundaries", () => {
  it("falls back to a mock waveform when no media is given", async () => {
    const clips: BoundaryClip[] = [
      {
        startMs: 2000,
        endMs: 5000,
        role: "content",
        verdict: "keep",
        verdictSource: "code",
      },
    ];
    const snapped = await applyAudioBoundaries(clips, { durationMs: 5000 });
    assert.equal(snapped[0]?.semanticStartMs, 2000);
    assert.notEqual(snapped[0]?.startMs, 2000);
  });

  it("applies withHandles after the actual boundary", async () => {
    const clips: BoundaryClip[] = [
      {
        startMs: 2000,
        endMs: 5000,
        role: "content",
        verdict: "keep",
        verdictSource: "code",
      },
    ];
    const snapped = await applyAudioBoundaries(clips, { durationMs: 8000 });
    const handled = withHandles(snapped, 8000);
    assert.equal(handled[0]?.startMs, Math.max(0, (snapped[0]?.startMs ?? 0) - PRE_HANDLE_MS));
    assert.equal(
      handled[0]?.endMs,
      Math.min(8000, (snapped[0]?.endMs ?? 0) + POST_HANDLE_MS),
    );
    assert.notEqual(handled[0]?.startMs, 2000 - PRE_HANDLE_MS);
  });
});

describe("lavfi fallback", () => {
  it("treats a continuous tone as uninformative", () => {
    const count = PCM_SAMPLE_RATE;
    const samples = new Int16Array(count);
    for (let index = 0; index < count; index += 1) {
      samples[index] = Math.round(Math.sin((2 * Math.PI * 220 * index) / PCM_SAMPLE_RATE) * 8000);
    }
    const wave = waveformFromPcm({
      samples,
      sampleRate: PCM_SAMPLE_RATE,
      source: "ffmpeg",
    });
    assert.equal(isUninformativeWaveform(wave), true);
  });

  it("uses silencedetect and PCM zero-cross when real audio exists", async (t) => {
    if (!(await ffmpegAvailable())) {
      t.skip("ffmpeg がありません");
      return;
    }
    const dir = await mkdtemp(path.join(os.tmpdir(), "cutline-boundary-"));
    const filePath = path.join(dir, "speech.wav");
    try {
      await execFileAsync("ffmpeg", [
        "-y",
        "-f",
        "lavfi",
        "-i",
        "anullsrc=r=16000:cl=mono:d=0.4",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440:sample_rate=16000:duration=0.5",
        "-f",
        "lavfi",
        "-i",
        "anullsrc=r=16000:cl=mono:d=0.4",
        "-filter_complex",
        "[0][1][2]concat=n=3:v=0:a=1",
        "-ar",
        "16000",
        "-ac",
        "1",
        filePath,
      ]);
      const wave = await loadWaveform({
        filePath,
        durationMs: 1300,
        units: [{ startMs: 200, endMs: 1100, role: "content" }],
      });
      assert.equal(wave.source, "ffmpeg");
      assert.ok(wave.silences.length >= 1);
      const start = resolveBoundary({
        semanticMs: 200,
        side: "start",
        waveform: wave,
        minMs: 0,
        maxMs: 700,
      });
      assert.notEqual(start.actualMs, 200);
      assert.ok(start.actualMs >= 300);
      assert.ok(start.actualMs <= 500);
      const snapped = await applyAudioBoundaries(
        [
          {
            startMs: 200,
            endMs: 1100,
            role: "content",
            verdict: "keep",
            verdictSource: "code",
          },
        ],
        { filePath, durationMs: 1300 },
      );
      assert.notEqual(snapped[0]?.startMs, 200);
      assert.notEqual(snapped[0]?.endMs, 1100);
      assert.equal(snapped[0]?.semanticStartMs, 200);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("long PCM slices", () => {
  it("keeps each decode under the 32MB stdout cap and around KEEP ranges", () => {
    const full = 20 * 60 * 1000;
    assert.ok(pcmByteLength(full) > PCM_MAX_BUFFER);
    const slices = planPcmSlices({ durationMs: full });
    assert.ok(slices.length >= 2);
    for (const slice of slices) {
      assert.ok(pcmByteLength(slice.endMs - slice.startMs) <= PCM_MAX_BUFFER);
      assert.ok(slice.endMs - slice.startMs <= PCM_SLICE_MS);
    }
    const aroundKeep = planPcmSlices({
      durationMs: 2 * 60 * 60 * 1000,
      ranges: [{ startMs: 1_000, endMs: 3_000 }],
    });
    const covered = aroundKeep.reduce(
      (sum, slice) => sum + (slice.endMs - slice.startMs),
      0,
    );
    assert.ok(covered < 60_000);
    assert.equal(aroundKeep[0]?.startMs, 1_000);
  });

  it("does not fall back to a mock waveform when PCM exceeds 32MB", async (t) => {
    if (!(await ffmpegAvailable())) {
      t.skip("ffmpeg がありません");
      return;
    }
    const durationMs = 1_100_000;
    assert.ok(pcmByteLength(durationMs) > PCM_MAX_BUFFER);
    const dir = await mkdtemp(path.join(os.tmpdir(), "cutline-long-pcm-"));
    const filePath = path.join(dir, "long.wav");
    try {
      await execFileAsync("ffmpeg", [
        "-y",
        "-f",
        "lavfi",
        "-i",
        "anullsrc=r=16000:cl=mono",
        "-t",
        "1100",
        "-c:a",
        "pcm_s16le",
        filePath,
      ]);
      const wave = await loadWaveform({
        filePath,
        durationMs,
        units: [{ startMs: 0, endMs: durationMs, role: "content" }],
      });
      assert.equal(wave.source, "ffmpeg");
      assert.equal(wave.samples.length, Math.round((durationMs / 1000) * 16_000));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

async function ffmpegAvailable(): Promise<boolean> {
  try {
    await execFileAsync("ffmpeg", ["-version"]);
    return true;
  } catch {
    return false;
  }
}
