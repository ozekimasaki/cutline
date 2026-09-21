import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  chooseAudioMode,
  ensureProxy,
  proxyFfmpegArgs,
  shouldSkipProxyEncode,
} from "./proxy";

describe("shouldSkipProxyEncode", () => {
  it("skips 720p H264 sample jobs", () => {
    assert.equal(
      shouldSkipProxyEncode({ height: 720, videoCodec: "h264" }, 720),
      true,
    );
    assert.equal(
      shouldSkipProxyEncode({ height: 1080, videoCodec: "h264" }, 720),
      false,
    );
    assert.equal(
      shouldSkipProxyEncode({ height: 2160, videoCodec: "prores" }, 720),
      false,
    );
  });
});

describe("proxyFfmpegArgs", () => {
  it("builds 720p H264 with copied high-quality audio", () => {
    const args = proxyFfmpegArgs({
      sourcePath: "/src/4k.mov",
      outputPath: "/tmp/proxy.mp4",
      height: 720,
      audio: "copy",
    });
    assert.ok(args.includes("scale=-2:720"));
    assert.equal(args[args.indexOf("-c:v") + 1], "libx264");
    assert.equal(args[args.indexOf("-c:a") + 1], "copy");
  });

  it("encodes high-bitrate AAC when copy is not suitable", () => {
    assert.equal(chooseAudioMode("aac"), "copy");
    assert.equal(chooseAudioMode("pcm_s24le"), "copy");
    assert.equal(chooseAudioMode("mp3"), "aac_high");
    const args = proxyFfmpegArgs({
      sourcePath: "/src/4k.mp4",
      outputPath: "/tmp/proxy.mp4",
      height: 1080,
      audio: "aac_high",
    });
    assert.ok(args.includes("scale=-2:1080"));
    assert.equal(args[args.indexOf("-b:a") + 1], "192k");
  });
});

describe("ensureProxy", () => {
  it("returns the source path for 720p H264", async () => {
    const result = await ensureProxy({
      sourcePath: "/tmp/sample.mp4",
      metadata: {
        width: 1280,
        height: 720,
        videoCodec: "h264",
        audioCodec: "aac",
      },
    });
    assert.equal(result.skipped, true);
    assert.equal(result.reason, "already_proxy");
    assert.equal(result.path, "/tmp/sample.mp4");
  });

  it("encodes 4K through a mocked ffmpeg runner", async () => {
    const seen: string[][] = [];
    const result = await ensureProxy({
      sourcePath: "/tmp/cam4k.mov",
      outputPath: "/tmp/cutline-proxy-test.mp4",
      height: 720,
      metadata: {
        width: 3840,
        height: 2160,
        videoCodec: "prores",
        audioCodec: "pcm_s24le",
      },
      runFfmpeg: async (args) => {
        seen.push(args);
      },
    });
    assert.equal(result.skipped, false);
    assert.equal(result.reason, "encoded");
    assert.equal(result.path, "/tmp/cutline-proxy-test.mp4");
    assert.ok(seen[0]?.includes("scale=-2:720"));
    assert.equal(seen[0]?.[seen[0].indexOf("-c:a") + 1], "copy");
  });
});
