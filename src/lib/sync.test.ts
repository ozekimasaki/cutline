import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  alignWaveforms,
  crossCorrelateLag,
  pickSyncMethod,
  resolveTrackSync,
  syncTracks,
  type SyncableTrack,
} from "./sync";

function track(partial: Partial<SyncableTrack> & { id: string }): SyncableTrack {
  return {
    embeddedTimecodeMs: null,
    audioTimecodeMs: null,
    ...partial,
  };
}

describe("pickSyncMethod", () => {
  it("prefers embedded timecode over waveform and manual", () => {
    const reference = track({
      id: "cam_a",
      embeddedTimecodeMs: 3_600_000,
      waveform: new Float32Array([1, 0, 0]),
      manualOffsetMs: 999,
    });
    const other = track({
      id: "cam_b",
      embeddedTimecodeMs: 3_600_400,
      waveform: new Float32Array([0, 0, 1]),
      manualOffsetMs: 999,
    });
    assert.equal(pickSyncMethod(reference, other, true), "embedded_timecode");
    const resolved = resolveTrackSync(reference, other, { canWaveform: true });
    assert.equal(resolved.method, "embedded_timecode");
    assert.equal(resolved.offsetMs, 400);
  });

  it("uses audio timecode when video timecode is missing", () => {
    const reference = track({
      id: "cam_a",
      audioTimecodeMs: 1_000,
      audioTimeReferenceSamples: 48000,
      sampleRate: 48000,
    });
    const other = track({
      id: "mic_a",
      audioTimecodeMs: 1_250,
      audioTimeReferenceSamples: 60000,
      sampleRate: 48000,
      manualOffsetMs: 5,
    });
    assert.equal(pickSyncMethod(reference, other, true), "audio_timecode");
    assert.equal(resolveTrackSync(reference, other).offsetMs, 250);
  });

  it("falls back to manual offset", () => {
    const reference = track({ id: "cam_a" });
    const other = track({ id: "cam_b", manualOffsetMs: -80 });
    assert.equal(pickSyncMethod(reference, other, false), "manual");
    assert.equal(resolveTrackSync(reference, other).offsetMs, -80);
  });
});

describe("waveform xcorr", () => {
  it("finds a delayed impulse", () => {
    const reference = new Float32Array(80);
    const delayed = new Float32Array(80);
    reference[10] = 1;
    reference[11] = 0.4;
    delayed[25] = 1;
    delayed[26] = 0.4;
    const result = crossCorrelateLag(reference, delayed);
    assert.equal(result.lag, 15);
    const aligned = alignWaveforms(reference, delayed, 1000);
    assert.equal(aligned.offsetMs, 15);
  });
});

describe("syncTracks", () => {
  it("keeps priority 1-4 across a set", async () => {
    const result = await syncTracks([
      track({ id: "cam_a", embeddedTimecodeMs: 0 }),
      track({ id: "cam_b", embeddedTimecodeMs: 200 }),
      track({
        id: "mic_a",
        audioTimecodeMs: 40,
        waveform: new Float32Array([1, 0]),
      }),
      track({ id: "cam_wide", manualOffsetMs: 12 }),
    ]);
    assert.equal(result.referenceId, "cam_a");
    assert.equal(
      result.offsets.find((item) => item.id === "cam_b")?.method,
      "embedded_timecode",
    );
    assert.equal(
      result.offsets.find((item) => item.id === "cam_wide")?.method,
      "manual",
    );
    assert.equal(
      result.offsets.find((item) => item.id === "cam_wide")?.offsetMs,
      12,
    );
  });
});
