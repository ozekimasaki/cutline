import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import {
  FILETRANS_MAX_BYTES,
  FILETRANS_MAX_DURATION_MS,
  buildFiletransContext,
  buildFiletransPayload,
  filetransApiRoot,
  filetransLimitNote,
  normalizeAsrHotWords,
  transcribeAudio,
} from "./asr";

const audioPath = path.join(mkdtempSync(path.join(os.tmpdir(), "cutline-asr-")), "talk.bin");
writeFileSync(audioPath, Buffer.from("RIFF-fake-audio"));

const saved = {
  key: process.env.DASHSCOPE_API_KEY,
  base: process.env.DASHSCOPE_BASE_URL,
  model: process.env.QWEN_ASR_MODEL,
  hot: process.env.QWEN_ASR_HOTWORDS,
  prompt: process.env.QWEN_ASR_PROMPT,
};

after(() => {
  restoreEnv("DASHSCOPE_API_KEY", saved.key);
  restoreEnv("DASHSCOPE_BASE_URL", saved.base);
  restoreEnv("QWEN_ASR_MODEL", saved.model);
  restoreEnv("QWEN_ASR_HOTWORDS", saved.hot);
  restoreEnv("QWEN_ASR_PROMPT", saved.prompt);
});

describe("filetransApiRoot", () => {
  it("maps compatible-mode to native /api/v1", () => {
    assert.equal(
      filetransApiRoot("https://dashscope-intl.aliyuncs.com/compatible-mode/v1"),
      "https://dashscope-intl.aliyuncs.com/api/v1",
    );
    assert.equal(
      filetransApiRoot("https://dashscope.aliyuncs.com/api/v1"),
      "https://dashscope.aliyuncs.com/api/v1",
    );
    assert.equal(
      filetransApiRoot("https://dashscope-intl.aliyuncs.com"),
      "https://dashscope-intl.aliyuncs.com/api/v1",
    );
  });
});

describe("normalizeAsrHotWords", () => {
  it("parses lists, weights, and env-style strings", () => {
    assert.deepEqual(normalizeAsrHotWords(["CutLine", " Jev "]), {
      CutLine: 5,
      Jev: 5,
    });
    assert.deepEqual(normalizeAsrHotWords({ Omni: 4, Super: 50 }), {
      Omni: 4,
      Super: 50,
    });
    assert.deepEqual(normalizeAsrHotWords("CutLine, Jev:50"), {
      CutLine: 5,
      Jev: 50,
    });
    assert.equal(normalizeAsrHotWords(""), undefined);
  });
});

describe("buildFiletransPayload", () => {
  it("adds hot words and prompt context, and keeps diarization only when set", () => {
    const withDiarization = buildFiletransPayload({
      model: "qwen-audio-asr-flash-filetrans",
      fileUrl: "oss://dashscope-instant/talk.bin",
      parameters: {
        channel_id: [0],
        diarization_enabled: true,
        speaker_count: 3,
      },
      hotWords: { CutLine: 5 },
      promptContext: "対談。固有名詞は CutLine と Jev。",
    });
    assert.deepEqual(withDiarization.input.file_urls, [
      "oss://dashscope-instant/talk.bin",
    ]);
    assert.equal(withDiarization.parameters.diarization_enabled, true);
    assert.equal(withDiarization.parameters.speaker_count, 3);
    assert.deepEqual(withDiarization.parameters.vocabulary, { CutLine: 5 });
    assert.equal(
      withDiarization.input.context?.[0]?.content[0]?.text,
      "対談。固有名詞は CutLine と Jev。",
    );
    assert.equal(
      withDiarization.parameters.text,
      "対談。固有名詞は CutLine と Jev。",
    );

    const mix = buildFiletransPayload({
      model: "qwen-audio-asr-flash-filetrans",
      fileUrl: "https://example.test/mix.wav",
      parameters: { channel_id: [0] },
    });
    assert.equal("diarization_enabled" in mix.parameters, false);
    assert.equal(mix.input.context, undefined);
    assert.equal(mix.parameters.vocabulary, undefined);
  });
});

describe("filetransLimitNote", () => {
  it("guards the spec 12h / 2GB Filetrans caps", () => {
    assert.match(
      filetransLimitNote({ durationMs: FILETRANS_MAX_DURATION_MS + 1 }) ?? "",
      /12 時間/,
    );
    assert.match(
      filetransLimitNote({
        durationMs: 1_000,
        byteLength: FILETRANS_MAX_BYTES + 1,
      }) ?? "",
      /2GB/,
    );
    assert.equal(
      filetransLimitNote({
        durationMs: FILETRANS_MAX_DURATION_MS,
        byteLength: FILETRANS_MAX_BYTES,
      }),
      undefined,
    );
  });
});

describe("buildFiletransContext", () => {
  it("truncates prompt context to the Filetrans turn cap", () => {
    const long = "あ".repeat(500);
    const context = buildFiletransContext(long);
    assert.equal(context?.[0]?.content[0]?.text.length, 400);
    assert.equal(buildFiletransContext("  "), undefined);
  });
});

describe("transcribeAudio", () => {
  it("falls back to mock when DASHSCOPE_API_KEY is missing", async () => {
    delete process.env.DASHSCOPE_API_KEY;
    const { fetchImpl, calls } = mockFiletransHttp();
    const result = await transcribeAudio(
      {
        filePath: audioPath,
        fileName: "talk.bin",
        durationMs: 24_000,
      },
      { fetch: fetchImpl, sleep: async () => undefined },
    );
    assert.equal(result.mode, "mock");
    assert.match(result.notes.join("\n"), /DASHSCOPE_API_KEY/);
    assert.ok(result.cues.length > 0);
    assert.equal(calls.length, 0);
  });

  it("uploads bytes, polls the job, and maps Filetrans sentences", async () => {
    process.env.DASHSCOPE_API_KEY = "sk-test";
    process.env.DASHSCOPE_BASE_URL =
      "https://dashscope-intl.aliyuncs.com/compatible-mode/v1";
    const { fetchImpl, calls } = mockFiletransHttp();
    const result = await transcribeAudio(
      {
        filePath: audioPath,
        fileName: "talk.bin",
        durationMs: 4_000,
        diarizationEnabled: true,
        speakerCount: 2,
        hotWords: ["CutLine"],
        promptContext: "ポッドキャスト対談",
        pollIntervalMs: 0,
      },
      { fetch: fetchImpl, sleep: async () => undefined },
    );
    assert.equal(result.mode, "live");
    assert.deepEqual(
      result.cues.map((cue) => `${cue.speaker}:${cue.text}`),
      ["A:こんにちは", "B:はい"],
    );
    assert.equal(
      calls.some((call) => call.url.includes("/chat/completions")),
      false,
    );
    const policy = calls.find((call) => call.url.includes("/uploads"));
    assert.ok(policy);
    assert.equal(policy?.method, "GET");
    const upload = calls.find((call) => call.url.includes("oss.example.test"));
    assert.equal(upload?.method, "POST");
    const submit = calls.find((call) =>
      call.url.endsWith("/services/audio/asr/transcription"),
    );
    assert.equal(submit?.method, "POST");
    const body = submit?.body as {
      input?: { file_urls?: string[]; context?: unknown };
      parameters?: {
        diarization_enabled?: boolean;
        vocabulary?: Record<string, number>;
        text?: string;
      };
    };
    assert.match(body.input?.file_urls?.[0] ?? "", /^oss:\/\//);
    assert.equal(body.parameters?.diarization_enabled, true);
    assert.deepEqual(body.parameters?.vocabulary, { CutLine: 5 });
    assert.equal(body.parameters?.text, "ポッドキャスト対談");
    assert.ok(body.input?.context);
    assert.equal(
      calls.filter((call) => call.url.includes("/tasks/task-1")).length >= 1,
      true,
    );
    assert.ok(calls.some((call) => call.url.includes("result.example.test")));
  });

  it("does not send diarization_enabled on the non-mix path", async () => {
    process.env.DASHSCOPE_API_KEY = "sk-test";
    const { fetchImpl, calls } = mockFiletransHttp();
    const result = await transcribeAudio(
      {
        filePath: audioPath,
        fileName: "mic-a.wav",
        durationMs: 4_000,
        diarizationEnabled: false,
        speaker: "A",
        pollIntervalMs: 0,
      },
      { fetch: fetchImpl, sleep: async () => undefined },
    );
    assert.equal(result.mode, "live");
    assert.equal(result.cues.every((cue) => cue.speaker === "A"), true);
    const submit = calls.find((call) =>
      call.url.endsWith("/services/audio/asr/transcription"),
    );
    const body = submit?.body as { parameters?: Record<string, unknown> };
    assert.equal("diarization_enabled" in (body.parameters ?? {}), false);
  });

  it("falls back to mock past the 12h Filetrans limit", async () => {
    process.env.DASHSCOPE_API_KEY = "sk-test";
    const { fetchImpl, calls } = mockFiletransHttp();
    const result = await transcribeAudio(
      {
        filePath: audioPath,
        fileName: "talk.bin",
        durationMs: FILETRANS_MAX_DURATION_MS + 1,
      },
      { fetch: fetchImpl, sleep: async () => undefined },
    );
    assert.equal(result.mode, "mock");
    assert.match(result.notes.join("\n"), /12 時間/);
    assert.equal(calls.length, 0);
  });

  it("falls back to mock when the Filetrans job fails", async () => {
    process.env.DASHSCOPE_API_KEY = "sk-test";
    const { fetchImpl } = mockFiletransHttp({ failTask: true });
    const result = await transcribeAudio(
      {
        filePath: audioPath,
        fileName: "talk.bin",
        durationMs: 4_000,
        pollIntervalMs: 0,
      },
      { fetch: fetchImpl, sleep: async () => undefined },
    );
    assert.equal(result.mode, "mock");
    assert.match(result.notes.join("\n"), /FAILED/);
  });
});

function mockFiletransHttp(options?: { failTask?: boolean; empty?: boolean }) {
  const calls: { url: string; method: string; body?: unknown }[] = [];
  let polls = 0;
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    let body: unknown;
    if (typeof init?.body === "string") {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    } else if (init?.body) {
      body = "[form]";
    }
    calls.push({ url, method, body });
    if (url.includes("/uploads")) {
      return jsonResponse({
        data: {
          upload_dir: "dashscope-instant/test",
          oss_access_key_id: "AKI",
          signature: "sig",
          policy: "pol",
          x_oss_object_acl: "private",
          x_oss_forbid_overwrite: "true",
          upload_host: "https://oss.example.test/upload",
        },
      });
    }
    if (url.includes("oss.example.test")) {
      return new Response("", { status: 200 });
    }
    if (url.includes("/services/audio/asr/transcription")) {
      return jsonResponse({
        output: { task_id: "task-1", task_status: "PENDING" },
      });
    }
    if (url.includes("/tasks/task-1")) {
      polls += 1;
      if (options?.failTask) {
        return jsonResponse({
          output: { task_id: "task-1", task_status: "FAILED", message: "boom" },
        });
      }
      if (polls < 2) {
        return jsonResponse({
          output: { task_id: "task-1", task_status: "RUNNING" },
        });
      }
      return jsonResponse({
        output: {
          task_id: "task-1",
          task_status: "SUCCEEDED",
          results: [
            {
              subtask_status: "SUCCEEDED",
              transcription_url: "https://result.example.test/t.json",
            },
          ],
        },
      });
    }
    if (url.includes("result.example.test")) {
      if (options?.empty) {
        return jsonResponse({ transcripts: [] });
      }
      return jsonResponse({
        transcripts: [
          {
            channel_id: 0,
            sentences: [
              { begin_time: 100, end_time: 800, text: "こんにちは", speaker_id: 0 },
              { begin_time: 900, end_time: 1500, text: "はい", speaker_id: 1 },
            ],
          },
        ],
      });
    }
    throw new Error(`unexpected fetch ${method} ${url}`);
  };
  return { fetchImpl, calls };
}

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function restoreEnv(name: string, value: string | undefined) {
  if (value == null) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}
