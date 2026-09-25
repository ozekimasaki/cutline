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
  type AsrSocket,
  type AsrSocketEvent,
} from "./asr";
import { messageAsrWebSocketUrl } from "./maas";

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
    assert.equal(
      filetransApiRoot(
        "https://workspace.ap-southeast-1.maas.aliyuncs.com/api/v1",
      ),
      "https://workspace.ap-southeast-1.maas.aliyuncs.com/api/v1",
    );
    assert.equal(
      messageAsrWebSocketUrl(
        "https://workspace.ap-southeast-1.maas.aliyuncs.com/api/v1",
      ),
      "wss://workspace.ap-southeast-1.maas.aliyuncs.com/api-ws/v1/inference",
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
    process.env.QWEN_ASR_MODEL = "qwen-audio-asr-flash-filetrans";
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
    process.env.QWEN_ASR_MODEL = "qwen-audio-asr-flash-filetrans";
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
    process.env.QWEN_ASR_MODEL = "qwen-audio-asr-flash-filetrans";
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
    process.env.QWEN_ASR_MODEL = "qwen-audio-asr-flash-filetrans";
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

  it("keeps Filetrans on the MaaS host for filetrans models", async () => {
    process.env.DASHSCOPE_API_KEY = "sk-test";
    process.env.DASHSCOPE_BASE_URL =
      "https://workspace.ap-southeast-1.maas.aliyuncs.com/api/v1";
    process.env.QWEN_ASR_MODEL = "qwen3-asr-flash-filetrans";
    const { fetchImpl, calls } = mockFiletransHttp();
    const result = await transcribeAudio(
      {
        filePath: audioPath,
        fileName: "talk.bin",
        durationMs: 4_000,
        pollIntervalMs: 0,
      },
      { fetch: fetchImpl, sleep: async () => undefined },
    );
    assert.equal(result.mode, "live");
    const submit = calls.find((call) =>
      call.url.endsWith("/services/audio/asr/transcription"),
    );
    assert.equal(
      submit?.url,
      "https://workspace.ap-southeast-1.maas.aliyuncs.com/api/v1/services/audio/asr/transcription",
    );
    assert.equal(
      calls.some((call) => call.url.includes("dashscope")),
      false,
    );
  });

  it("transcribes qwen-audio-3.1-asr-flash-message over MaaS inference", async () => {
    process.env.DASHSCOPE_API_KEY = "sk-maas";
    process.env.DASHSCOPE_BASE_URL =
      "https://workspace.ap-southeast-1.maas.aliyuncs.com/api/v1";
    process.env.QWEN_ASR_MODEL = "qwen-audio-3.1-asr-flash-message";
    const { fetchImpl, calls } = mockFiletransHttp();
    const socket = new FakeAsrSocket("ok");
    let connected = "";
    let apiKey = "";
    const result = await transcribeAudio(
      {
        filePath: audioPath,
        fileName: "talk.mp4",
        durationMs: 4_000,
        pollTimeoutMs: 1_000,
      },
      {
        fetch: fetchImpl,
        sleep: async () => undefined,
        loadWav: async () => Uint8Array.from([1, 2, 3, 4]),
        connect: (url, key) => {
          connected = url;
          apiKey = key;
          queueMicrotask(() => socket.open());
          return socket;
        },
      },
    );
    assert.equal(result.mode, "live");
    assert.deepEqual(
      result.cues.map((cue) => `${cue.startMs}:${cue.text}`),
      ["100:こんにちは", "900:はい"],
    );
    assert.equal(calls.length, 0);
    assert.equal(
      connected,
      "wss://workspace.ap-southeast-1.maas.aliyuncs.com/api-ws/v1/inference",
    );
    assert.equal(apiKey, "sk-maas");
    assert.equal(connected.includes("dashscope"), false);
    const frames = socket.sent.map((frame) =>
      typeof frame === "string" ? (JSON.parse(frame) as Record<string, unknown>) : frame,
    );
    const run = frames.find(
      (frame) =>
        typeof frame === "object" &&
        !ArrayBuffer.isView(frame) &&
        (frame.header as { action?: string } | undefined)?.action === "run-task",
    ) as { payload?: Record<string, unknown> } | undefined;
    assert.equal(run?.payload?.model, "qwen-audio-3.1-asr-flash-message");
    assert.equal(run?.payload?.task_group, "audio");
    assert.equal(run?.payload?.task, "asr");
    assert.equal(run?.payload?.function, "recognition");
    assert.deepEqual(run?.payload?.parameters, {
      format: "wav",
      sample_rate: 16000,
    });
    assert.deepEqual(run?.payload?.input, {});
    assert.ok(
      frames.some(
        (frame) =>
          typeof frame === "object" &&
          !ArrayBuffer.isView(frame) &&
          (frame.header as { action?: string } | undefined)?.action ===
            "finish-task",
      ),
    );
    assert.ok(frames.some((frame) => frame instanceof Uint8Array));
  });

  it("does not mock when the message model key is present and the task fails", async () => {
    process.env.DASHSCOPE_API_KEY = "sk-maas";
    process.env.DASHSCOPE_BASE_URL =
      "https://workspace.ap-southeast-1.maas.aliyuncs.com/api/v1";
    process.env.QWEN_ASR_MODEL = "qwen-audio-3.1-asr-flash-message";
    const socket = new FakeAsrSocket("fail");
    await assert.rejects(
      () =>
        transcribeAudio(
          {
            filePath: audioPath,
            fileName: "talk.mp4",
            durationMs: 4_000,
            pollTimeoutMs: 1_000,
          },
          {
            loadWav: async () => Uint8Array.from([1, 2, 3, 4]),
            connect: () => {
              queueMicrotask(() => socket.open());
              return socket;
            },
          },
        ),
      /InvalidApiKey/,
    );
  });

  it("stays on mock for the message model when the key is missing", async () => {
    delete process.env.DASHSCOPE_API_KEY;
    process.env.QWEN_ASR_MODEL = "qwen-audio-3.1-asr-flash-message";
    let connects = 0;
    const result = await transcribeAudio(
      {
        filePath: audioPath,
        fileName: "talk.mp4",
        durationMs: 4_000,
      },
      {
        connect: () => {
          connects += 1;
          throw new Error("should not connect");
        },
      },
    );
    assert.equal(result.mode, "mock");
    assert.match(result.notes.join("\n"), /DASHSCOPE_API_KEY/);
    assert.equal(connects, 0);
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

class FakeAsrSocket implements AsrSocket {
  readonly sent: Array<string | Uint8Array> = [];
  private readonly listeners = new Map<
    string,
    Array<(event: AsrSocketEvent) => void>
  >();

  constructor(private readonly behavior: "ok" | "fail") {}

  addEventListener(
    type: "open" | "message" | "error" | "close",
    listener: (event: AsrSocketEvent) => void,
  ) {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  send(data: string | Uint8Array) {
    this.sent.push(data);
    if (typeof data !== "string") {
      return;
    }
    const message = JSON.parse(data) as { header?: { action?: string } };
    if (message.header?.action === "run-task") {
      queueMicrotask(() =>
        this.emit("message", {
          data: JSON.stringify({ header: { event: "task-started" } }),
        }),
      );
    }
    if (message.header?.action === "finish-task") {
      queueMicrotask(() => {
        if (this.behavior === "fail") {
          this.emit("message", {
            data: JSON.stringify({
              header: {
                event: "task-failed",
                error_code: "InvalidApiKey",
                error_message: "Invalid API-key provided.",
              },
            }),
          });
          return;
        }
        this.emit("message", {
          data: JSON.stringify({
            header: { event: "result-generated" },
            payload: {
              output: {
                sentence: {
                  begin_time: 0,
                  end_time: 40,
                  text: "こ",
                  sentence_end: false,
                },
              },
            },
          }),
        });
        this.emit("message", {
          data: JSON.stringify({
            header: { event: "result-generated" },
            payload: {
              output: {
                sentence: {
                  begin_time: 100,
                  end_time: 800,
                  text: "こんにちは",
                  sentence_end: true,
                },
              },
            },
          }),
        });
        this.emit("message", {
          data: JSON.stringify({
            header: { event: "result-generated" },
            payload: {
              output: {
                sentence: {
                  begin_time: 900,
                  end_time: 1500,
                  text: "はい",
                  sentence_end: true,
                },
              },
            },
          }),
        });
        this.emit("message", {
          data: JSON.stringify({ header: { event: "task-finished" } }),
        });
      });
    }
  }

  close() {}

  open() {
    this.emit("open", {});
  }

  private emit(type: string, event: AsrSocketEvent) {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }
}

function restoreEnv(name: string, value: string | undefined) {
  if (value == null) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}
