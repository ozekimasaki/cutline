import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createContext, runInNewContext } from "node:vm";

type ReviewApi = {
  projectClips: (value: unknown) => Array<{ verdict?: string }> | null;
  countReviews: (value: unknown) => number;
};

function loadPanel(): ReviewApi {
  const source = readFileSync(
    path.join(process.cwd(), "premiere-uxp", "main.js"),
    "utf8",
  );
  const sandbox: {
    require: (id: string) => unknown;
    document: { getElementById: () => null };
    module: { exports: ReviewApi };
    exports: ReviewApi;
    console: Console;
  } = {
    require(id: string) {
      if (id === "uxp") {
        throw new Error("uxp missing");
      }
      throw new Error(id);
    },
    document: { getElementById: () => null },
    module: { exports: {} as ReviewApi },
    exports: {} as ReviewApi,
    console,
  };
  sandbox.exports = sandbox.module.exports;
  runInNewContext(source, createContext(sandbox), { filename: "main.js" });
  return sandbox.module.exports;
}

describe("Premiere review counts", () => {
  it("counts clips only from project.json that has a clips array", () => {
    const api = loadPanel();
    const project = {
      clips: [
        { verdict: "review", text: "確認" },
        { verdict: "keep", text: "残す" },
      ],
    };
    assert.equal(api.countReviews(project), 1);
    assert.equal(api.projectClips(project)?.length, 2);
    const otio = {
      OTIO_SCHEMA: "Timeline.1",
      tracks: { children: [{ children: [{ name: "A" }, { name: "B" }] }] },
    };
    assert.equal(api.projectClips(otio), null);
    assert.equal(api.countReviews(otio), 0);
    assert.equal(api.countReviews({ clips: "nope" }), 0);
    assert.equal(api.countReviews(null), 0);
  });
});
