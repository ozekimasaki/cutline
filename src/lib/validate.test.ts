import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseDetectLog } from "./validate";

describe("parseDetectLog", () => {
  it("flags black, freeze, and long silence", () => {
    const parsed = parseDetectLog(`
[blackdetect @ 0x] black_start:0.1 black_end:0.8 black_duration:0.7
[silencedetect @ 0x] silence_start: 1.0
[silencedetect @ 0x] silence_end: 4.2 | silence_duration: 3.2
lavfi.freezedetect.freeze_start: 2.0
`);
    assert.equal(parsed.blackFrames, true);
    assert.equal(parsed.frozenFrames, true);
    assert.equal(parsed.silenceAnomaly, true);
  });

  it("ignores short silence", () => {
    const parsed = parseDetectLog(
      "[silencedetect @ 0x] silence_end: 0.5 | silence_duration: 0.4\n",
    );
    assert.equal(parsed.blackFrames, false);
    assert.equal(parsed.frozenFrames, false);
    assert.equal(parsed.silenceAnomaly, false);
  });
});
