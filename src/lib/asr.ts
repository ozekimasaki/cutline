import "server-only";

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { asrModelId, qwenEnv } from "./env";
import {
  isMaasBase,
  isMessageAsrModel,
  isRouteMismatchError,
  messageAsrWebSocketUrl,
} from "./maas";
import { mockTranscript } from "./sample";
import { isShortTalkFile, shortTalkCues } from "./short-talk";
import {
  cuesFromTranscription,
  filetransParameters,
  type FiletransParameters,
} from "./speaker";
import type { TranscriptCue } from "./types";

/** Spec §7 Filetrans: max 12 hours of audio. */
export const FILETRANS_MAX_DURATION_MS = 12 * 60 * 60 * 1000;
/** Spec §7 Filetrans: max 2 GB per file. */
export const FILETRANS_MAX_BYTES = 2 * 1024 * 1024 * 1024;

const CONTEXT_MAX_CHARS = 400;
const DEFAULT_POLL_MS = 2_000;
const DEFAULT_POLL_TIMEOUT_MS = 15 * 60 * 1000;
const HTTP_TIMEOUT_MS = 60_000;
const UPLOAD_TIMEOUT_MS = 180_000;
const MESSAGE_CHUNK_BYTES = 64 * 1024;
const WAV_TIMEOUT_MS = 10 * 60 * 1000;
const execFileAsync = promisify(execFile);

type AsrRoute = "filetrans" | "message";

export type AsrSocketEvent = { data?: unknown; error?: Error };

export type AsrSocket = {
  send(data: string | Uint8Array): void;
  close(): void;
  addEventListener(
    type: "open" | "message" | "error" | "close",
    listener: (event: AsrSocketEvent) => void,
  ): void;
};

export type AsrHotWords = string[] | Record<string, number>;

export type FiletransContextMessage = {
  role: "user" | "assistant";
  content: Array<{ type: "input_text" | "text"; text: string }>;
};

export type FiletransPayload = {
  model: string;
  input: {
    file_urls: string[];
    context?: FiletransContextMessage[];
  };
  parameters: FiletransParameters & {
    vocabulary?: Record<string, number>;
    text?: string;
  };
};

export type TranscribeAudioInput = {
  filePath?: string;
  fileName: string;
  durationMs: number;
  diarizationEnabled?: boolean;
  speakerCount?: number;
  channelId?: number[];
  speaker?: string;
  hotWords?: AsrHotWords;
  promptContext?: string;
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
};

export type FiletransDeps = {
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  connect?: (url: string, apiKey: string) => AsrSocket;
  loadWav?: (filePath: string) => Promise<Uint8Array>;
};

export function filetransApiRoot(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/$/, "");
  if (!trimmed) {
    return "https://dashscope-intl.aliyuncs.com/api/v1";
  }
  if (trimmed.includes("/compatible-mode/")) {
    return trimmed.replace(/\/compatible-mode\/v\d+$/, "/api/v1");
  }
  if (/\/api\/v1$/.test(trimmed)) {
    return trimmed;
  }
  try {
    const url = new URL(trimmed);
    return `${url.origin}/api/v1`;
  } catch {
    return `${trimmed}/api/v1`;
  }
}

export function normalizeAsrHotWords(
  value?: AsrHotWords | string | null,
): Record<string, number> | undefined {
  if (value == null || value === "") {
    return undefined;
  }
  const weights: Record<string, number> = {};
  if (typeof value === "string") {
    for (const part of value.split(/[,|\n]/)) {
      const trimmed = part.trim();
      if (!trimmed) {
        continue;
      }
      const split = trimmed.match(/^(.+?)(?::(\d+))?$/);
      const word = split?.[1]?.trim();
      if (!word) {
        continue;
      }
      weights[word] = clampHotWordWeight(
        split?.[2] != null ? Number(split[2]) : 5,
      );
    }
  } else if (Array.isArray(value)) {
    for (const word of value) {
      const trimmed = word.trim();
      if (trimmed) {
        weights[trimmed] = 5;
      }
    }
  } else {
    for (const [word, weight] of Object.entries(value)) {
      const trimmed = word.trim();
      if (trimmed) {
        weights[trimmed] = clampHotWordWeight(weight);
      }
    }
  }
  return Object.keys(weights).length > 0 ? weights : undefined;
}

export function buildFiletransContext(
  promptContext?: string,
): FiletransContextMessage[] | undefined {
  const text = (promptContext ?? "").trim().slice(0, CONTEXT_MAX_CHARS);
  if (!text) {
    return undefined;
  }
  return [
    {
      role: "user",
      content: [{ type: "input_text", text }],
    },
  ];
}

export function buildFiletransPayload(input: {
  model: string;
  fileUrl: string;
  parameters: FiletransParameters;
  hotWords?: AsrHotWords;
  promptContext?: string;
}): FiletransPayload {
  const parameters: FiletransPayload["parameters"] = {
    ...input.parameters,
  };
  const vocabulary = normalizeAsrHotWords(input.hotWords);
  if (vocabulary) {
    parameters.vocabulary = vocabulary;
  }
  const context = buildFiletransContext(input.promptContext);
  if (context?.[0]?.content[0]?.text) {
    parameters.text = context[0].content[0].text;
  }
  return {
    model: input.model,
    input: {
      file_urls: [input.fileUrl],
      ...(context ? { context } : {}),
    },
    parameters,
  };
}

export function filetransLimitNote(input: {
  durationMs: number;
  byteLength?: number;
}): string | undefined {
  if (input.durationMs > FILETRANS_MAX_DURATION_MS) {
    return "Filetrans 上限は 12 時間です。";
  }
  if (input.byteLength != null && input.byteLength > FILETRANS_MAX_BYTES) {
    return "Filetrans 上限は 2GB です。";
  }
  return undefined;
}

export async function transcribeAudio(
  input: TranscribeAudioInput,
  deps: FiletransDeps = {},
): Promise<{ cues: TranscriptCue[]; mode: "live" | "mock"; notes: string[] }> {
  const notes: string[] = [];
  const env = qwenEnv();
  const parameters = filetransParameters({
    diarizationEnabled: input.diarizationEnabled === true,
    speakerCount: input.speakerCount,
    channelId: input.channelId ?? [0],
  });
  if (!env.live || !input.filePath) {
    notes.push(
      env.live
        ? "音声ファイルが無いため ASR はモックです。"
        : "DASHSCOPE_API_KEY が無いため ASR はモックです。",
    );
    return {
      cues: labelCues(fallbackTranscript(input), input.speaker),
      mode: "mock",
      notes,
    };
  }

  const route = asrRoute(asrModelId());
  try {
    const cues = await transcribeOnRoute(route, input, parameters, env, deps);
    if (cues.length === 0) {
      throw new Error("空の文字起こし");
    }
    return { cues: labelCues(cues, input.speaker), mode: "live", notes };
  } catch (error) {
    if (route === "message" || isRouteMismatchError(error)) {
      throw error instanceof Error ? error : new Error(String(error));
    }
    notes.push(
      `ASR Filetrans に失敗したためモックに切り替えました: ${error instanceof Error ? error.message : String(error)}`,
    );
    return {
      cues: labelCues(fallbackTranscript(input), input.speaker),
      mode: "mock",
      notes,
    };
  }
}

function fallbackTranscript(input: TranscribeAudioInput): TranscriptCue[] {
  return isShortTalkFile(input.fileName)
    ? shortTalkCues()
    : mockTranscript(input.durationMs);
}

function asrRoute(model: string): AsrRoute {
  return isMessageAsrModel(model) ? "message" : "filetrans";
}

async function transcribeOnRoute(
  route: AsrRoute,
  input: TranscribeAudioInput,
  parameters: FiletransParameters,
  env: { apiKey: string; baseUrl: string },
  deps: FiletransDeps,
): Promise<TranscriptCue[]> {
  switch (route) {
    case "message":
      return transcribeViaMessage(input, env, deps);
    case "filetrans":
      return transcribeViaFiletrans(input, parameters, env, deps);
    default: {
      const _never: never = route;
      throw new Error(String(_never));
    }
  }
}

async function transcribeViaMessage(
  input: TranscribeAudioInput,
  env: { apiKey: string; baseUrl: string },
  deps: FiletransDeps,
): Promise<TranscriptCue[]> {
  const filePath = input.filePath;
  if (!filePath) {
    throw new Error("音声ファイルが無い");
  }
  if (filePath.startsWith("oss://")) {
    throw new Error("ASR はローカル音声が必要です");
  }
  const url = messageAsrWebSocketUrl(env.baseUrl);
  if (isDashScopeHost(url) && isMaasBase(env.baseUrl)) {
    throw new Error("MaaS のキーを Filetrans ホストへ送れません");
  }
  const wav = deps.loadWav
    ? await deps.loadWav(filePath)
    : await wav16kFromMedia(filePath);
  if (wav.byteLength === 0) {
    throw new Error("ASR 用の wav が空です");
  }
  const socket = (deps.connect ?? defaultMessageSocket)(url, env.apiKey);
  return runMessageTask({
    socket,
    taskId: randomUUID().replaceAll("-", ""),
    model: asrModelId(),
    wav,
    timeoutMs: input.pollTimeoutMs ?? DEFAULT_POLL_TIMEOUT_MS,
  });
}

function isDashScopeHost(endpoint: string): boolean {
  try {
    return new URL(endpoint).hostname.includes("dashscope");
  } catch {
    return endpoint.includes("dashscope");
  }
}

function defaultMessageSocket(url: string, apiKey: string): AsrSocket {
  const Socket = WebSocket as unknown as new (
    endpoint: string,
    options?: { headers?: Record<string, string> },
  ) => WebSocket;
  const socket = new Socket(url, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  return {
    send(data) {
      socket.send(data);
    },
    close() {
      socket.close();
    },
    addEventListener(type, listener) {
      socket.addEventListener(type, (event) => {
        if (type === "message") {
          listener({ data: (event as MessageEvent).data });
          return;
        }
        if (type === "error") {
          const errorEvent = event as ErrorEvent;
          const error =
            errorEvent.error instanceof Error
              ? errorEvent.error
              : new Error(errorEvent.message || "ASR の接続に失敗しました");
          listener({ error });
          return;
        }
        listener({});
      });
    },
  };
}

function runMessageTask(input: {
  socket: AsrSocket;
  taskId: string;
  model: string;
  wav: Uint8Array;
  timeoutMs: number;
}): Promise<TranscriptCue[]> {
  const { socket, taskId, model, wav, timeoutMs } = input;
  return new Promise((resolve, reject) => {
    const sentences: unknown[] = [];
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const finish = (settle: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      try {
        socket.close();
      } catch {
        // already closed
      }
      settle();
    };
    const fail = (error: Error) => finish(() => reject(error));
    const succeed = (cues: TranscriptCue[]) => finish(() => resolve(cues));
    timer = setTimeout(() => {
      fail(new Error("ASR がタイムアウトしました"));
    }, timeoutMs);

    socket.addEventListener("error", (event) => {
      fail(event.error ?? new Error("ASR の接続に失敗しました"));
    });
    socket.addEventListener("close", () => {
      fail(new Error("ASR の接続が切れました"));
    });
    socket.addEventListener("open", () => {
      socket.send(
        JSON.stringify({
          header: {
            action: "run-task",
            task_id: taskId,
            streaming: "duplex",
          },
          payload: {
            task_group: "audio",
            task: "asr",
            function: "recognition",
            model,
            parameters: {
              format: "wav",
              sample_rate: 16000,
            },
            input: {},
          },
        }),
      );
    });
    socket.addEventListener("message", (event) => {
      void onMessage(event.data);
    });

    async function onMessage(data: unknown) {
      if (settled) {
        return;
      }
      let message: unknown;
      try {
        message = JSON.parse(await frameText(data));
      } catch {
        return;
      }
      const header = asRecord(asRecord(message)?.header);
      const eventName =
        typeof header?.event === "string" ? header.event : "";
      if (eventName === "task-started") {
        sendWav(socket, wav);
        socket.send(
          JSON.stringify({
            header: {
              action: "finish-task",
              task_id: taskId,
              streaming: "duplex",
            },
            payload: { input: {} },
          }),
        );
        return;
      }
      if (eventName === "result-generated") {
        for (const sentence of sentencesFrom(message)) {
          if (asRecord(sentence)?.sentence_end === false) {
            continue;
          }
          sentences.push(sentence);
        }
        return;
      }
      if (eventName === "task-finished") {
        const cues = cuesFromTranscription({
          transcripts: [{ sentences }],
        });
        if (cues.length === 0) {
          fail(new Error("空の文字起こし"));
          return;
        }
        succeed(cues);
        return;
      }
      if (eventName === "task-failed") {
        const code =
          typeof header?.error_code === "string" ? header.error_code : "FAILED";
        const text =
          typeof header?.error_message === "string" ? header.error_message : "";
        fail(new Error(`ASR ${code}: ${text || "failed"}`.trim()));
      }
    }
  });
}

function sendWav(socket: AsrSocket, wav: Uint8Array): void {
  for (let offset = 0; offset < wav.byteLength; offset += MESSAGE_CHUNK_BYTES) {
    socket.send(wav.subarray(offset, offset + MESSAGE_CHUNK_BYTES));
  }
}

function sentencesFrom(message: unknown): unknown[] {
  const payload = asRecord(asRecord(message)?.payload);
  const output = asRecord(payload?.output);
  const sentence = output?.sentence;
  if (Array.isArray(sentence)) {
    return sentence;
  }
  if (sentence && typeof sentence === "object") {
    return [sentence];
  }
  return [];
}

async function frameText(data: unknown): Promise<string> {
  if (typeof data === "string") {
    return data;
  }
  if (data instanceof ArrayBuffer) {
    return Buffer.from(data).toString("utf8");
  }
  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString(
      "utf8",
    );
  }
  if (typeof Blob !== "undefined" && data instanceof Blob) {
    return data.text();
  }
  return String(data ?? "");
}

async function wav16kFromMedia(filePath: string): Promise<Uint8Array> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "cutline-asr-"));
  const out = path.join(dir, "speech.wav");
  try {
    await execFileAsync(
      "ffmpeg",
      [
        "-y",
        "-i",
        filePath,
        "-vn",
        "-ac",
        "1",
        "-ar",
        "16000",
        "-c:a",
        "pcm_s16le",
        "-f",
        "wav",
        out,
      ],
      { timeout: WAV_TIMEOUT_MS },
    );
    return await readFile(out);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`ASR 用の wav 変換に失敗しました: ${detail.slice(0, 180)}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function transcribeViaFiletrans(
  input: TranscribeAudioInput,
  parameters: FiletransParameters,
  env: { apiKey: string; baseUrl: string },
  deps: FiletransDeps,
): Promise<TranscriptCue[]> {
  const filePath = input.filePath;
  if (!filePath) {
    throw new Error("音声ファイルが無い");
  }
  const http = deps.fetch ?? fetch;
  const sleep = deps.sleep ?? defaultSleep;
  const apiRoot = filetransApiRoot(env.baseUrl);
  const model = asrModelId();
  let byteLength: number | undefined;
  if (!isRemoteMedia(filePath)) {
    const info = await stat(filePath);
    byteLength = info.size;
  }
  const limit = filetransLimitNote({
    durationMs: input.durationMs,
    byteLength,
  });
  if (limit) {
    throw new Error(limit);
  }

  const fileUrl = isRemoteMedia(filePath)
    ? filePath
    : await uploadAudioBytes({
        apiRoot,
        apiKey: env.apiKey,
        model,
        filePath,
        fileName: input.fileName,
        http,
      });

  const hotWords = mergeHotWords(
    normalizeAsrHotWords(process.env.QWEN_ASR_HOTWORDS),
    normalizeAsrHotWords(input.hotWords),
  );
  const promptContext =
    input.promptContext?.trim() ||
    process.env.QWEN_ASR_PROMPT?.trim() ||
    undefined;
  const payload = buildFiletransPayload({
    model,
    fileUrl,
    parameters,
    hotWords,
    promptContext,
  });

  const headers: Record<string, string> = {
    Authorization: `Bearer ${env.apiKey}`,
    "Content-Type": "application/json",
    "X-DashScope-Async": "enable",
  };
  if (fileUrl.startsWith("oss://")) {
    headers["X-DashScope-OssResourceResolve"] = "enable";
  }

  const submitted = await readJson(
    await http(`${apiRoot}/services/audio/asr/transcription`, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    }),
    "Filetrans submit",
  );
  const taskId = taskIdOf(submitted);
  if (!taskId) {
    throw new Error(`Filetrans task_id が無い: ${summarizeError(submitted)}`);
  }
  const finished = await pollFiletransTask({
    apiRoot,
    apiKey: env.apiKey,
    taskId,
    http,
    sleep,
    pollIntervalMs: input.pollIntervalMs ?? DEFAULT_POLL_MS,
    pollTimeoutMs: input.pollTimeoutMs ?? DEFAULT_POLL_TIMEOUT_MS,
    first: submitted,
  });
  const transcription = await loadTranscription(finished, http);
  return cuesFromTranscription(transcription);
}

async function uploadAudioBytes(input: {
  apiRoot: string;
  apiKey: string;
  model: string;
  filePath: string;
  fileName: string;
  http: typeof fetch;
}): Promise<string> {
  const bytes = await readFile(input.filePath);
  if (bytes.byteLength > FILETRANS_MAX_BYTES) {
    throw new Error("Filetrans 上限は 2GB です。");
  }
  const policyUrl = new URL(`${input.apiRoot}/uploads`);
  policyUrl.searchParams.set("action", "getPolicy");
  policyUrl.searchParams.set("model", input.model);
  const policyPayload = await readJson(
    await input.http(policyUrl, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${input.apiKey}`,
        "Content-Type": "application/json",
      },
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    }),
    "Filetrans upload policy",
  );
  const data = policyDataOf(policyPayload);
  const fileName = safeFileName(input.fileName, input.filePath);
  const uploadDir = policyField(data, "upload_dir", "uploadDir");
  const uploadHost = policyField(data, "upload_host", "uploadHost");
  const key = `${uploadDir.replace(/\/$/, "")}/${fileName}`;
  const form = new FormData();
  form.set(
    "OSSAccessKeyId",
    policyField(data, "oss_access_key_id", "ossAccessKeyId", "OSSAccessKeyId"),
  );
  form.set("Signature", policyField(data, "signature", "Signature"));
  form.set("policy", policyField(data, "policy", "Policy"));
  form.set(
    "x-oss-object-acl",
    optionalPolicyField(data, "x_oss_object_acl", "xOssObjectAcl") ?? "private",
  );
  form.set(
    "x-oss-forbid-overwrite",
    optionalPolicyField(data, "x_oss_forbid_overwrite", "xOssForbidOverwrite") ??
      "true",
  );
  form.set("key", key);
  form.set("success_action_status", "200");
  form.set("file", new Blob([bytes]), fileName);
  const uploaded = await input.http(uploadHost, {
    method: "POST",
    body: form,
    signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
  });
  if (!uploaded.ok) {
    throw new Error(`Filetrans upload ${uploaded.status}`);
  }
  return `oss://${key}`;
}

async function pollFiletransTask(input: {
  apiRoot: string;
  apiKey: string;
  taskId: string;
  http: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  pollIntervalMs: number;
  pollTimeoutMs: number;
  first: unknown;
}): Promise<unknown> {
  const deadline = Date.now() + input.pollTimeoutMs;
  let current = input.first;
  while (true) {
    const status = taskStatusOf(current);
    if (status === "SUCCEEDED") {
      return current;
    }
    if (status === "FAILED" || status === "CANCELED" || status === "UNKNOWN") {
      throw new Error(
        `Filetrans ${status}: ${taskMessageOf(current) || summarizeError(current)}`,
      );
    }
    if (Date.now() > deadline) {
      throw new Error("Filetrans poll がタイムアウトしました");
    }
    await input.sleep(input.pollIntervalMs);
    current = await readJson(
      await input.http(`${input.apiRoot}/tasks/${input.taskId}`, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${input.apiKey}`,
        },
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      }),
      "Filetrans poll",
    );
  }
}

async function loadTranscription(
  payload: unknown,
  http: typeof fetch,
): Promise<unknown> {
  if (hasTranscriptSentences(payload)) {
    return payload;
  }
  const root = asRecord(payload);
  const output = asRecord(root?.output) ?? root;
  if (hasTranscriptSentences(output)) {
    return output;
  }
  const results = Array.isArray(output?.results) ? output.results : [];
  for (const result of results) {
    const row = asRecord(result);
    if (!row) {
      continue;
    }
    if (hasTranscriptSentences(row)) {
      return row;
    }
    const subStatus =
      typeof row.subtask_status === "string" ? row.subtask_status : "";
    if (subStatus && subStatus !== "SUCCEEDED") {
      continue;
    }
    if (typeof row.transcription_url === "string" && row.transcription_url) {
      return readJson(
        await http(row.transcription_url, {
          method: "GET",
          signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
        }),
        "Filetrans result",
      );
    }
  }
  const failed = results
    .map((item) => asRecord(item))
    .find((row) => row && row.subtask_status === "FAILED");
  if (failed) {
    throw new Error(
      `Filetrans subtask FAILED: ${taskMessageOf(failed) || summarizeError(failed)}`,
    );
  }
  throw new Error("Filetrans の transcripts が無い");
}

function labelCues(cues: TranscriptCue[], speaker?: string): TranscriptCue[] {
  if (!speaker) {
    return cues;
  }
  return cues.map((cue) => ({ ...cue, speaker }));
}

function mergeHotWords(
  ...parts: Array<Record<string, number> | undefined>
): Record<string, number> | undefined {
  const merged: Record<string, number> = {};
  for (const part of parts) {
    if (!part) {
      continue;
    }
    Object.assign(merged, part);
  }
  return Object.keys(merged).length > 0 ? merged : undefined;
}

function clampHotWordWeight(value: number): number {
  if (value === 50) {
    return 50;
  }
  if (!Number.isFinite(value)) {
    return 5;
  }
  return Math.min(5, Math.max(1, Math.round(value)));
}

function isRemoteMedia(filePath: string): boolean {
  return /^(https?:\/\/|oss:\/\/)/i.test(filePath);
}

function safeFileName(fileName: string, filePath: string): string {
  const base =
    path.basename(fileName || filePath).replace(/[/\\]/g, "_") || "audio.bin";
  return base;
}

function policyDataOf(payload: unknown): Record<string, unknown> {
  const root = asRecord(payload);
  const data = asRecord(root?.data) ?? root;
  if (!data) {
    throw new Error(`upload policy が空です: ${summarizeError(payload)}`);
  }
  return data;
}

function policyField(
  data: Record<string, unknown>,
  ...keys: string[]
): string {
  const value = optionalPolicyField(data, ...keys);
  if (!value) {
    throw new Error(`upload policy に ${keys[0]} が無い`);
  }
  return value;
}

function optionalPolicyField(
  data: Record<string, unknown>,
  ...keys: string[]
): string | undefined {
  for (const key of keys) {
    const value = data[key];
    if (typeof value === "string" && value) {
      return value;
    }
  }
  return undefined;
}

function taskIdOf(payload: unknown): string | undefined {
  const root = asRecord(payload);
  const output = asRecord(root?.output);
  const id = output?.task_id ?? output?.taskId ?? root?.task_id;
  return typeof id === "string" && id ? id : undefined;
}

function taskStatusOf(payload: unknown): string {
  const root = asRecord(payload);
  const output = asRecord(root?.output);
  const status = output?.task_status ?? root?.task_status;
  return typeof status === "string" ? status.toUpperCase() : "PENDING";
}

function taskMessageOf(payload: unknown): string {
  const root = asRecord(payload);
  const output = asRecord(root?.output);
  const message = output?.message ?? root?.message ?? output?.code ?? root?.code;
  return typeof message === "string" ? message : "";
}

function hasTranscriptSentences(payload: unknown): boolean {
  if (!payload || typeof payload !== "object") {
    return false;
  }
  return cuesFromTranscription(payload).length > 0;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

async function readJson(response: Response, label: string): Promise<unknown> {
  const payload = (await response.json().catch(() => null)) as unknown;
  if (!response.ok) {
    throw new Error(`${label} ${response.status}: ${summarizeError(payload)}`);
  }
  return payload;
}

function summarizeError(payload: unknown): string {
  if (!payload) {
    return "unknown";
  }
  try {
    return JSON.stringify(payload).slice(0, 400);
  } catch {
    return String(payload);
  }
}

async function defaultSleep(ms: number): Promise<void> {
  if (ms <= 0) {
    return;
  }
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export { asrModelId } from "./env";
