import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  cameraIdFromRole,
  classifyMediaRole,
  collectDroppedFiles,
  jobSourcesFromCameras,
  parseFfprobeJson,
  parseFrameRate,
  parseSmpteTimecodeMs,
  prepareAnalysisMedia,
  probeMediaMetadata,
  type FfprobeJson,
} from "./ingest";

const FIXTURE: FfprobeJson = {
  format: {
    duration: "24.042",
    tags: { timecode: "01:00:00:00" },
  },
  streams: [
    {
      codec_type: "video",
      codec_name: "h264",
      avg_frame_rate: "30/1",
      r_frame_rate: "30/1",
      width: 1280,
      height: 720,
      tags: { timecode: "01:00:00:00" },
    },
    {
      codec_type: "audio",
      codec_name: "aac",
      channels: 2,
      sample_rate: "48000",
      tags: { timecode: "01:00:00:12" },
    },
  ],
};

describe("classifyMediaRole", () => {
  it("maps CAM / MIC filenames", () => {
    assert.equal(classifyMediaRole("CAM_A.mp4"), "cam_a");
    assert.equal(classifyMediaRole("cam-b.mov"), "cam_b");
    assert.equal(classifyMediaRole("CAM_WIDE.mp4"), "cam_wide");
    assert.equal(classifyMediaRole("MIC_A.wav"), "mic_a");
    assert.equal(classifyMediaRole("mic-b.wav"), "mic_b");
    assert.equal(classifyMediaRole("interview.mp4"), "unknown");
  });
});

describe("parseFfprobeJson", () => {
  it("reads duration, fps, timecode, codec, channels, sample rate", () => {
    const meta = parseFfprobeJson(FIXTURE, "/tmp/CAM_A.mp4", "CAM_A.mp4");
    assert.equal(meta.role, "cam_a");
    assert.equal(meta.durationMs, 24042);
    assert.equal(meta.fps, 30);
    assert.equal(meta.width, 1280);
    assert.equal(meta.height, 720);
    assert.equal(meta.videoCodec, "h264");
    assert.equal(meta.audioCodec, "aac");
    assert.equal(meta.audioChannels, 2);
    assert.equal(meta.sampleRate, 48000);
    assert.equal(meta.embeddedTimecode, "01:00:00:00");
    assert.equal(meta.audioTimecode, "01:00:00:12");
  });

  it("reads BWF time_reference as audio clock", () => {
    const meta = parseFfprobeJson(
      {
        format: {
          duration: "1.0",
          tags: { time_reference: "48000" },
        },
        streams: [
          {
            codec_type: "audio",
            codec_name: "pcm_s24le",
            channels: 1,
            sample_rate: "48000",
          },
        ],
      },
      "/tmp/MIC_A.wav",
      "MIC_A.wav",
    );
    assert.equal(meta.role, "mic_a");
    assert.equal(meta.audioTimeReferenceSamples, 48000);
    assert.equal(meta.videoCodec, null);
  });
});

describe("timecode helpers", () => {
  it("parses SMPTE to milliseconds", () => {
    assert.equal(parseSmpteTimecodeMs("01:00:00:00", 30), 3_600_000);
    assert.equal(parseSmpteTimecodeMs("00:00:01:15", 30), 1500);
    assert.equal(parseFrameRate("30000/1001")?.toFixed(3), "29.970");
  });
});

describe("probeMediaMetadata", () => {
  it("uses a mocked ffprobe runner", async () => {
    const meta = await probeMediaMetadata("/ignored/CAM_B.mp4", {
      probe: async () => FIXTURE,
      fileName: "CAM_B.mp4",
    });
    assert.equal(meta.role, "cam_b");
    assert.equal(meta.videoCodec, "h264");
    assert.equal(meta.audioChannels, 2);
  });
});

describe("prepareAnalysisMedia", () => {
  it("skips 720p H264 proxy and syncs by embedded timecode", async () => {
    const prepared = await prepareAnalysisMedia({
      fileName: "CAM_A.mp4",
      sources: [
        { filePath: "/tmp/CAM_A.mp4", fileName: "CAM_A.mp4" },
        { filePath: "/tmp/CAM_B.mp4", fileName: "CAM_B.mp4" },
      ],
      probe: async (filePath) => {
        if (filePath.endsWith("CAM_B.mp4")) {
          return {
            ...FIXTURE,
            format: {
              duration: "24.042",
              tags: { timecode: "01:00:00:10" },
            },
            streams: [
              {
                ...FIXTURE.streams?.[0],
                tags: { timecode: "01:00:00:10" },
              },
              FIXTURE.streams?.[1],
            ],
          };
        }
        return FIXTURE;
      },
    });
    assert.equal(prepared.mix?.role, "cam_a");
    assert.equal(prepared.proxies[0]?.skipped, true);
    assert.equal(prepared.proxies[0]?.reason, "already_proxy");
    assert.equal(prepared.analysisPath, "/tmp/CAM_A.mp4");
    const camB = prepared.sync?.offsets.find((offset) => offset.id === "cam_b");
    assert.equal(camB?.method, "embedded_timecode");
    assert.equal(camB?.offsetMs, Math.round((10 / 30) * 1000));
  });

  it("records a proxy encode failure instead of already_proxy", async () => {
    const prepared = await prepareAnalysisMedia({
      fileName: "CAM_A.mp4",
      sources: [{ filePath: "/tmp/CAM_A.mp4", fileName: "CAM_A.mp4" }],
      probe: async () => ({
        ...FIXTURE,
        streams: [
          {
            ...FIXTURE.streams?.[0],
            codec_name: "prores",
            width: 3840,
            height: 2160,
          },
          FIXTURE.streams?.[1],
        ],
      }) as FfprobeJson,
      runFfmpeg: async () => {
        throw new Error("libx264 boom");
      },
    });
    assert.equal(prepared.proxies[0]?.reason, "encode_failed");
    assert.equal(prepared.proxies[0]?.skipped, false);
    assert.match(prepared.proxies[0]?.error ?? "", /libx264 boom/);
    assert.match(prepared.notes.join("\n"), /encode failed 720p \(libx264 boom\)/);
    assert.doesNotMatch(prepared.notes.join("\n"), /already_proxy/);
  });
});

describe("collectDroppedFiles", () => {
  it("reads named CAM/MIC fields and manual offsets", () => {
    const form = new FormData();
    form.set(
      "cam_a",
      new File([new Uint8Array([1])], "take.mp4", { type: "video/mp4" }),
    );
    form.set(
      "files",
      new File([new Uint8Array([2])], "MIC_A.wav", { type: "audio/wav" }),
    );
    form.set("manualOffset_cam_b", "120");
    const dropped = collectDroppedFiles(form);
    assert.equal(dropped[0]?.role, "cam_a");
    assert.equal(dropped.some((item) => item.role === "mic_a"), true);
    assert.equal(cameraIdFromRole("cam_wide"), "WIDE");
    assert.equal(cameraIdFromRole("mic_a"), undefined);
  });
});

describe("jobSourcesFromCameras", () => {
  it("maps registered cameras and keeps extra mics", () => {
    const sources = jobSourcesFromCameras(
      [
        { id: "A", mediaId: "m-a", fileName: "cam-a.mp4" },
        { id: "WIDE", mediaId: "m-w", fileName: "cam-wide.mp4" },
      ],
      (id) =>
        id === "m-a"
          ? { filePath: "/tmp/a.mp4" }
          : id === "m-w"
            ? { filePath: "/tmp/wide.mp4" }
            : undefined,
      [{ filePath: "/tmp/mic.wav", fileName: "MIC_A.wav", role: "mic_a" }],
    );
    assert.equal(sources[0]?.role, "cam_a");
    assert.equal(sources[1]?.role, "cam_wide");
    assert.equal(sources[2]?.role, "mic_a");
  });
});
