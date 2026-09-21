import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  SAMPLE_DURATION_MS,
  clampTargetMinutes,
  minutesFromSourceMs,
  resolveTargetDurationMs,
} from "./target-duration";

describe("minutesFromSourceMs", () => {
  it("ceils the 24s sample to 1 minute", () => {
    assert.equal(minutesFromSourceMs(SAMPLE_DURATION_MS), 1);
  });

  it("keeps a 60 minute source at 60", () => {
    assert.equal(minutesFromSourceMs(60 * 60_000), 60);
  });

  it("ceils 90 seconds to 2 minutes", () => {
    assert.equal(minutesFromSourceMs(90_000), 2);
  });
});

describe("clampTargetMinutes", () => {
  it("caps at the source length", () => {
    assert.equal(clampTargetMinutes(180, 60), 60);
    assert.equal(clampTargetMinutes(30, 60), 30);
  });

  it("falls back to the source length when the value is not a number", () => {
    assert.equal(clampTargetMinutes(Number.NaN, 60), 60);
  });
});

describe("resolveTargetDurationMs", () => {
  it("uses the source length when the request is missing", () => {
    assert.equal(resolveTargetDurationMs(Number.NaN, 60 * 60_000), 60 * 60_000);
  });

  it("clamps a 1 minute request down to a 24s sample", () => {
    assert.equal(resolveTargetDurationMs(60_000, SAMPLE_DURATION_MS), SAMPLE_DURATION_MS);
  });

  it("keeps a shorter target on a 60 minute source", () => {
    assert.equal(resolveTargetDurationMs(30 * 60_000, 60 * 60_000), 30 * 60_000);
  });

  it("drops a target longer than the source", () => {
    assert.equal(resolveTargetDurationMs(180 * 60_000, 60 * 60_000), 60 * 60_000);
  });
});
