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
