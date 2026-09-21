import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { allowsJevCache } from "./jev";
import { cacheGet, cacheSet, promptVersion, resetPersist } from "./persist";
import { mockSignals } from "./sample";

describe("jev cache", () => {
  it("does not store mock signals under a live model key", () => {
    assert.equal(allowsJevCache("jev:vercel", { provider: "mock" }), false);
    assert.equal(allowsJevCache("jev:cloudflare", { provider: "mock" }), false);
    assert.equal(allowsJevCache("jev:mock", { provider: "mock" }), true);
    assert.equal(allowsJevCache("jev:vercel", { provider: "vercel" }), true);
    resetPersist();
    process.env.CUTLINE_DB_PATH = path.join(
      mkdtempSync(path.join(os.tmpdir(), "cutline-jev-")),
      "cutline.db",
    );
    const lookup = {
      mediaHash: "media",
      timeRange: "0-1000",
      modelVersion: "jev:vercel",
      promptVersion: promptVersion(),
      kind: "jev:u1",
    };
    const mock = mockSignals({
      id: "u1",
      speaker: "A",
      text: "今年の2月から始めました",
      startMs: 0,
      endMs: 1000,
      role: "content",
    });
    cacheSet(lookup, mock);
    assert.equal(cacheGet(lookup), undefined);
    cacheSet(lookup, { ...mock, provider: "vercel" });
    assert.equal(cacheGet<{ provider: string }>(lookup)?.provider, "vercel");
  });
});
