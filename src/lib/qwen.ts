import "server-only";

import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { omniModelId, qwenEnv } from "./env";
import { asBoolean, asNumber, asString, extractJsonObject } from "./json";
import { mockPerception } from "./sample";
import { parseOmniBrollCues } from "./broll";
import { compressVideo } from "./ffmpeg";
import type {
  ContinuityQa,
  ConversationWindow,
  ConversationWindowAnalysis,
  EditUnit,
  OmniCameraVisual,
  OmniEditState,
  OmniPauseLabel,
  OmniSession,
  OmniUnitState,
  OmniVisualState,
  Perception,
  ScoredClip,
  SemanticRole,
  SpeakerId,
  TranscriptCue,
  WatchQa,
} from "./types";
import { mockWatchQa, watchQuestionsPrompt } from "./watch";
import { formatWindowPrompt, mockConversationWindow } from "./windows";

const MAX_INLINE_BYTES = 7_500_000;
const SESSION_CACHE_HEADER = "x-dashscope-session-cache";
const TECHNICAL_PAUSE_RE =
  /Qwen|Jev|実装|TypeScript|FFmpeg|ASR|Omni|モデル|推論|エンコード|プロトコル|レイテンシ|API/;

type OmniSessionRecord = OmniSession & {
  videoUrl?: string;
};

type ResponsesCallResult = {
  text: string;
  responseId?: string;
  cachedTokens: number;
};

const sessions = new Map<string, OmniSessionRecord>();

export function omniMediaKey(input: {
  filePath?: string;
  fileName?: string;
}): string {
  return input.filePath?.trim() || input.fileName?.trim() || "no-media";
}

export function getOmniSession(mediaKey: string): OmniSession | undefined {
  const row = sessions.get(mediaKey);
  if (!row) {
    return undefined;
  }
  return {
    mediaKey: row.mediaKey,
    previousResponseId: row.previousResponseId,
  };
}

export function clearOmniSessions(): void {
  sessions.clear();
}

export async function perceiveVideo(input: {
  filePath?: string;
  fileName: string;
  durationMs: number;
  brief: string;
}): Promise<{ perception: Perception; notes: string[] }> {
  const notes: string[] = [];
  const env = qwenEnv();
  if (!env.live) {
    notes.push("DASHSCOPE_API_KEY がないため、Qwen はモック知覚です。");
    return {
      perception: mockPerception({
        durationMs: input.durationMs,
        fileName: input.fileName,
        brief: input.brief,
      }),
      notes,
    };
  }

  if (!input.filePath) {
    notes.push("動画バイトが無いため、Qwen はモック知覚です。");
    return {
      perception: mockPerception({
        durationMs: input.durationMs,
        fileName: input.fileName,
        brief: input.brief,
      }),
      notes,
    };
  }

  try {
    const mediaKey = omniMediaKey(input);
    const raw = await omniText({
      prompt: buildPerceptionPrompt(input),
      mediaKey,
      filePath: input.filePath,
      notes,
    });
    const perception = normalizePerception(
      extractJsonObject(raw),
      input,
      "live",
    );
    const session = sessions.get(mediaKey);
    if (session?.previousResponseId) {
      perception.omniResponseId = session.previousResponseId;
    }
    return { perception, notes };
  } catch (error) {
    notes.push(
      `Qwen の呼び出しに失敗したためモック知覚に切り替えました: ${errorMessage(error)}`,
    );
    return {
      perception: mockPerception({
        durationMs: input.durationMs,
        fileName: input.fileName,
        brief: input.brief,
      }),
      notes,
    };
  }
}

export async function analyzeConversationWindow(input: {
  filePath?: string;
  fileName: string;
  durationMs: number;
  brief: string;
  window: ConversationWindow;
  cues: TranscriptCue[];
  storyline?: string;
  perception?: Perception;
}): Promise<{ analysis: ConversationWindowAnalysis; notes: string[] }> {
  const notes: string[] = [];
  const fallback = mockConversationWindow({
    window: input.window,
    cues: input.cues,
  });
  const env = qwenEnv();
  if (!env.live) {
    notes.push("キーが無いため PASS 2 の Omni 会話解析はモックです。");
    return { analysis: fallback, notes };
  }
  const mediaKey = omniMediaKey(input);
  seedSessionFromPerception(mediaKey, input.perception);
  try {
    const raw = await omniText({
      prompt: formatWindowPrompt({
        window: input.window,
        cues: input.cues,
        fileName: input.fileName,
        durationMs: input.durationMs,
        brief: input.brief,
        storyline: input.storyline,
      }),
      mediaKey,
      filePath: input.filePath,
      notes,
    });
    return {
      analysis: normalizeWindowAnalysis(extractJsonObject(raw), fallback),
      notes,
    };
  } catch (error) {
    notes.push(
      `PASS 2 Omni に失敗したためモック会話解析に切り替えました: ${errorMessage(error)}`,
    );
    return { analysis: fallback, notes };
  }
}

export async function watchEditedVideo(input: {
  filePath: string;
  clips: ScoredClip[];
  continuity?: ContinuityQa;
}): Promise<{ watch: WatchQa; notes: string[] }> {
  const notes: string[] = [];
  const fallback = mockWatchQa({
    clips: input.clips,
    continuity: input.continuity,
  });
  const env = qwenEnv();
  if (!env.live) {
    notes.push("キーが無いため完成映像の Omni 再視聴はモックです。");
    return { watch: fallback, notes };
  }
  try {
    const raw = await omniText({
      prompt: watchQuestionsPrompt(),
      mediaKey: omniMediaKey({ filePath: input.filePath }),
      filePath: input.filePath,
      notes,
    });
    return { watch: normalizeWatchQa(extractJsonObject(raw), fallback), notes };
  } catch (error) {
    notes.push(
      `Omni 再視聴に失敗したためモックに切り替えました: ${errorMessage(error)}`,
    );
    return { watch: fallback, notes };
  }
}

/** Spec §19 / §35 / §37. Pipeline can call this after PASS 0/2 without re-sending video. */
export async function perceiveUnitStates(input: {
  units: EditUnit[];
  perception?: Perception;
  filePath?: string;
  fileName?: string;
}): Promise<{ states: OmniUnitState[]; notes: string[] }> {
  const notes: string[] = [];
  const mocked = mockOmniUnitStates(input.units, input.perception);
  const env = qwenEnv();
  if (!env.live) {
    notes.push("キーが無いため Omni の単位 Edit / Visual State はモックです。");
    return { states: mocked, notes };
  }

  const mediaKey = omniMediaKey(input);
  seedSessionFromPerception(mediaKey, input.perception);
  if (!input.filePath && !sessions.get(mediaKey)?.previousResponseId) {
    notes.push("動画も Responses session も無いため単位 State はモックです。");
    return { states: mocked, notes };
  }

  try {
    const raw = await omniText({
      prompt: buildUnitStatePrompt(input.units, input.perception),
      mediaKey,
      filePath: input.filePath,
      notes,
    });
    return {
      states: normalizeOmniUnitStates(
        extractJsonObject(raw),
        input.units,
        input.perception,
      ),
      notes,
    };
  } catch (error) {
    notes.push(
      `単位 State の取得に失敗したためモックに切り替えました: ${errorMessage(error)}`,
    );
    return { states: mocked, notes };
  }
}

export function mockOmniUnitStates(
  units: EditUnit[],
  perception?: Perception,
): OmniUnitState[] {
  return units.map((unit) => mockOmniUnitState(unit, perception));
}

export function mockOmniUnitState(
  unit: EditUnit,
  perception?: Perception,
): OmniUnitState {
  return {
    edit: mockOmniEditState(unit, perception),
    visual: mockOmniVisualState(unit),
    pauseLabel: mockOmniPauseLabel(unit),
  };
}

export function mockOmniEditState(
  unit: EditUnit,
  perception?: Perception,
): OmniEditState {
  return {
    target: {
      id: unit.id,
      speaker: unit.speaker,
      text: unit.text,
      start: unit.startMs / 1000,
      end: unit.endMs / 1000,
    },
    semantic: {
      role: unit.role,
      topic: topicOf(unit, perception),
      contains_new_information: unit.role === "content",
    },
    conversation: {
      previous: unit.previous ?? "",
      next: unit.next ?? "",
    },
    visual: {
      speaker_camera: speakerCameraOf(unit.speaker),
      listener_reaction: listenerReactionLabelOf(unit),
    },
  };
}

export function mockOmniVisualState(unit: EditUnit): OmniVisualState {
  const speaker = (unit.speaker.trim() || "A") as SpeakerId;
  const strength = listenerReactionStrengthOf(unit);
  const listenerExpression = expressionOf(strength);
  const speaking = speaker.trim().toUpperCase();
  return {
    speaker,
    camera_a: {
      subject: "A",
      usable: true,
      expression: speaking === "A" ? "neutral" : listenerExpression,
    },
    camera_b: {
      subject: "B",
      usable: true,
      expression: speaking === "B" ? "neutral" : listenerExpression,
    },
    wide: { usable: true },
    listener_reaction: { strength },
  };
}

export function mockOmniPauseLabel(unit: EditUnit): OmniPauseLabel | undefined {
  if (unit.role !== "pause") {
    return undefined;
  }
  const duration = Math.max(0, unit.endMs - unit.startMs);
  const previous = (unit.previous ?? "").trim();
  const next = (unit.next ?? "").trim();
  if (/[？?]$/.test(previous) && duration >= 1000) {
    return "dramatic_pause";
  }
  if (TECHNICAL_PAUSE_RE.test(previous) || TECHNICAL_PAUSE_RE.test(next)) {
    return "technical_pause";
  }
  if (unit.pauseClass === "thinking" || (duration >= 700 && duration < 2000)) {
    return "thinking_pause";
  }
  return "awkward_pause";
}

export function parseOmniPauseLabel(value: unknown): OmniPauseLabel | undefined {
  switch (value) {
    case "dramatic_pause":
    case "thinking_pause":
    case "awkward_pause":
    case "technical_pause":
      return value;
    default:
      return undefined;
  }
}

export function parseSemanticRole(
  value: unknown,
  fallback: SemanticRole,
): SemanticRole {
  switch (value) {
    case "content":
    case "filler":
    case "false_start":
    case "self_correction":
    case "pause":
    case "backchannel":
      return value;
    default:
      return fallback;
  }
}

export function normalizeOmniEditState(
  raw: unknown,
  unit: EditUnit,
  perception?: Perception,
): OmniEditState {
  const fallback = mockOmniEditState(unit, perception);
  const record = recordOf(raw);
  const targetRaw = recordOf(record.target);
  const semanticRaw = recordOf(record.semantic);
  const conversationRaw = recordOf(record.conversation);
  const visualRaw = recordOf(record.visual);
  const topic = asString(semanticRaw.topic, fallback.semantic.topic ?? "");
  return {
    target: {
      id: asString(targetRaw.id ?? record.id, fallback.target.id),
      speaker: asString(
        targetRaw.speaker ?? record.speaker,
        fallback.target.speaker,
      ),
      text: asString(targetRaw.text ?? record.text, fallback.target.text),
      start: asNumber(targetRaw.start ?? record.start, fallback.target.start),
      end: asNumber(targetRaw.end ?? record.end, fallback.target.end),
    },
    semantic: {
      role: parseSemanticRole(
        semanticRaw.role ?? record.role,
        fallback.semantic.role,
      ),
      topic: topic || undefined,
      contains_new_information: asBoolean(
        semanticRaw.contains_new_information ??
          semanticRaw.containsNewInformation,
        fallback.semantic.contains_new_information,
      ),
    },
    conversation: {
      previous: asString(
        conversationRaw.previous ?? record.previous,
        fallback.conversation.previous,
      ),
      next: asString(
        conversationRaw.next ?? record.next,
        fallback.conversation.next,
      ),
    },
    visual: {
      speaker_camera: normalizeSpeakerCamera(
        visualRaw.speaker_camera ??
          visualRaw.speakerCamera ??
          record.speaker_camera,
        fallback.visual.speaker_camera,
      ),
      listener_reaction: listenerReactionLabel(
        visualRaw.listener_reaction ??
          visualRaw.listenerReaction ??
          record.listener_reaction,
        fallback.visual.listener_reaction,
      ),
    },
  };
}

export function normalizeOmniVisualState(
  raw: unknown,
  unit: EditUnit,
): OmniVisualState {
  const fallback = mockOmniVisualState(unit);
  const record = recordOf(raw);
  const nested = recordOf(record.visual);
  const listener = listenerReactionObject(
    record.listener_reaction ?? record.listenerReaction,
    nested.listener_reaction ?? nested.listenerReaction,
  );
  return {
    speaker: asString(record.speaker ?? nested.speaker, fallback.speaker),
    camera_a: normalizeCameraVisual(
      record.camera_a ?? record.cameraA ?? nested.camera_a,
      fallback.camera_a,
    ),
    camera_b: normalizeCameraVisual(
      record.camera_b ?? record.cameraB ?? nested.camera_b,
      fallback.camera_b,
    ),
    wide: normalizeCameraVisual(record.wide ?? nested.wide, fallback.wide),
    listener_reaction: {
      strength: clamp01(
        asNumber(listener.strength, fallback.listener_reaction.strength),
      ),
    },
  };
}

export function normalizeOmniUnitStates(
  raw: unknown,
  units: EditUnit[],
  perception?: Perception,
): OmniUnitState[] {
  const record = recordOf(raw);
  const rows = Array.isArray(record.units)
    ? record.units
    : Array.isArray(record.edit_states)
      ? record.edit_states
      : Array.isArray(raw)
        ? raw
        : [];
  const byId = new Map<string, Record<string, unknown>>();
  for (const item of rows) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const row = item as Record<string, unknown>;
    const target = recordOf(row.target);
    const id = asString(row.id, asString(target.id, ""));
    if (id) {
      byId.set(id, row);
    }
  }
  return units.map((unit) => {
    const row = byId.get(unit.id);
    const fallback = mockOmniUnitState(unit, perception);
    if (!row) {
      return fallback;
    }
    return {
      edit: normalizeOmniEditState(row, unit, perception),
      visual: normalizeOmniVisualState(row, unit),
      pauseLabel:
        parseOmniPauseLabel(
          row.pause_label ?? row.pauseLabel ?? row.pause_type ?? row.pauseType,
        ) ?? fallback.pauseLabel,
    };
  });
}

function seedSessionFromPerception(
  mediaKey: string,
  perception?: Perception,
): void {
  const responseId = perception?.omniResponseId?.trim();
  if (!responseId) {
    return;
  }
  const existing = sessions.get(mediaKey);
  if (existing?.previousResponseId) {
    return;
  }
  sessions.set(mediaKey, {
    mediaKey,
    previousResponseId: responseId,
    videoUrl: existing?.videoUrl,
  });
}

async function omniText(input: {
  prompt: string;
  mediaKey: string;
  filePath?: string;
  notes: string[];
}): Promise<string> {
  const env = qwenEnv();
  const session = sessions.get(input.mediaKey) ?? { mediaKey: input.mediaKey };
  let videoUrl = session.videoUrl;

  const runResponses = async (previousResponseId?: string) => {
    const reuse = Boolean(previousResponseId);
    if (!reuse && !videoUrl) {
      if (!input.filePath) {
        throw new Error("動画が無く Responses session を開始できません");
      }
      videoUrl = await toInlineVideoUrl(input.filePath, input.notes);
    }
    return perceiveViaResponses({
      baseUrl: env.baseUrl,
      apiKey: env.apiKey,
      prompt: input.prompt,
      videoUrl: reuse ? undefined : videoUrl,
      previousResponseId,
    });
  };

  try {
    let result: ResponsesCallResult;
    try {
      result = await runResponses(session.previousResponseId);
      if (session.previousResponseId) {
        const cached =
          result.cachedTokens > 0
            ? ` · cached_tokens ${result.cachedTokens}`
            : "";
        input.notes.push(
          `Omni Responses session で video + global state を再利用しました${cached}。`,
        );
      }
    } catch (error) {
      if (!session.previousResponseId) {
        throw error;
      }
      input.notes.push(
        `Responses session を再利用できなかったため動画を再入力します: ${errorMessage(error)}`,
      );
      session.previousResponseId = undefined;
      result = await runResponses(undefined);
    }
    sessions.set(input.mediaKey, {
      mediaKey: input.mediaKey,
      previousResponseId: result.responseId ?? session.previousResponseId,
      videoUrl,
    });
    return result.text;
  } catch (error) {
    input.notes.push(
      `Responses API を使えないため Chat Completions に切り替えました: ${errorMessage(error)}`,
    );
    if (!videoUrl) {
      if (!input.filePath) {
        throw error;
      }
      videoUrl = await toInlineVideoUrl(input.filePath, input.notes);
    }
    const text = await perceiveViaChat(
      env.baseUrl,
      env.apiKey,
      input.prompt,
      videoUrl,
    );
    sessions.set(input.mediaKey, {
      mediaKey: input.mediaKey,
      previousResponseId: undefined,
      videoUrl,
    });
    return text;
  }
}

function normalizeWatchQa(raw: unknown, fallback: WatchQa): WatchQa {
  const record = (raw ?? {}) as Record<string, unknown>;
  const issues = Array.isArray(record.issues)
    ? record.issues
        .map((item) => {
          if (!item || typeof item !== "object") {
            return null;
          }
          const row = item as Record<string, unknown>;
          const issue = asString(row.issue, "");
          if (!issue) {
            return null;
          }
          return {
            atMs: asNumber(row.atMs, 0) || undefined,
            issue,
            restoreClipId: asString(row.restoreClipId, "") || undefined,
          };
        })
        .filter(
          (item): item is WatchQa["issues"][number] => item !== null,
        )
    : fallback.issues;
  const flags = {
    brokenConversations: asBoolean(
      record.brokenConversations,
      fallback.brokenConversations,
    ),
    abruptTopicChanges: asBoolean(
      record.abruptTopicChanges,
      fallback.abruptTopicChanges,
    ),
    obviousBadCuts: asBoolean(record.obviousBadCuts, fallback.obviousBadCuts),
    audioDiscontinuities: asBoolean(
      record.audioDiscontinuities,
      fallback.audioDiscontinuities,
    ),
    missingContext: asBoolean(record.missingContext, fallback.missingContext),
    awkwardCameraSwitching: asBoolean(
      record.awkwardCameraSwitching,
      fallback.awkwardCameraSwitching,
    ),
  };
  return {
    source: "live",
    iterations: 1,
    ...flags,
    issues,
    ok: issues.length === 0 && !Object.values(flags).some(Boolean),
  };
}

function buildPerceptionPrompt(input: {
  fileName: string;
  durationMs: number;
  brief: string;
}): string {
  const brief = input.brief.trim() || "見どころを残し、間と繰り返しを落とす。";
  return [
    "You are CutLine's perception model. Read the video in chronological order.",
    "Return JSON only. No markdown.",
    `Source file: ${input.fileName}`,
    `Duration ms: ${input.durationMs}`,
    `Editor brief: ${brief}`,
    "Schema:",
    JSON.stringify({
      title: "string",
      durationMs: 0,
      language: "ja",
      summary: "string",
      storyline: "chronological storyline",
      topics: ["topic"],
      keyMoments: ["highlight"],
      participants: [{ id: "A", role: "host" }],
      brollCues: [
        {
          tag: "B_ROLL_RECOMMENDED",
          startMs: 0,
          endMs: 0,
          topic: "optional",
        },
      ],
    }),
    "Do not propose cut points. Summarize speakers, topics, and storyline only.",
    "Do not generate B-roll, stock, slides, or imagery. If talking-head needs cover, emit brollCues with tag B_ROLL_RECOMMENDED only.",
    "Prefer Japanese in title and summary.",
  ].join("\n");
}

function buildUnitStatePrompt(
  units: EditUnit[],
  perception?: Perception,
): string {
  return [
    "You already have this video and the global storyline/topics in session cache.",
    "Do not request the video again. Observe each Edit Unit.",
    "Return JSON only. No markdown.",
    "Do not decide KEEP, CUT, SHORTEN, or which camera the edit should use.",
    "Do not answer camera choice or CUT. Report observed state only.",
    perception
      ? `Global title: ${perception.title}. Storyline: ${perception.storyline}. Topics: ${perception.topics.join(", ")}.`
      : "",
    "Schema:",
    JSON.stringify({
      units: [
        {
          id: "eu_148",
          target: {
            id: "eu_148",
            speaker: "B",
            text: "いや、去年じゃないですね",
            start: 481.42,
            end: 483.73,
          },
          semantic: {
            role: "self_correction",
            topic: "開発開始時期",
            contains_new_information: false,
          },
          conversation: {
            previous: "去年くらいからですね",
            next: "今年の2月から始めました",
          },
          visual: {
            speaker_camera: "cam_b",
            listener_reaction: "none",
          },
          pause_label: "thinking_pause",
          speaker: "A",
          camera_a: {
            subject: "A",
            usable: true,
            expression: "neutral",
          },
          camera_b: {
            subject: "B",
            usable: true,
            expression: "surprised",
          },
          wide: { usable: true },
          listener_reaction: { strength: 0.87 },
        },
      ],
    }),
    "pause_label is only for pause units: dramatic_pause, thinking_pause, awkward_pause, or technical_pause.",
    "semantic.role is content, filler, false_start, self_correction, pause, or backchannel.",
    "Units:",
    JSON.stringify(
      units.map((unit) => ({
        id: unit.id,
        speaker: unit.speaker,
        text: unit.text,
        start: unit.startMs / 1000,
        end: unit.endMs / 1000,
        roleHint: unit.role,
        pauseClass: unit.pauseClass ?? null,
        previous: unit.previous ?? "",
        next: unit.next ?? "",
      })),
    ),
  ]
    .filter((line) => line.length > 0)
    .join("\n");
}

async function perceiveViaResponses(input: {
  baseUrl: string;
  apiKey: string;
  prompt: string;
  videoUrl?: string;
  previousResponseId?: string;
}): Promise<ResponsesCallResult> {
  const content: Array<Record<string, unknown>> = [
    { type: "input_text", text: input.prompt },
  ];
  if (input.videoUrl) {
    content.push({ type: "input_video", video_url: input.videoUrl });
  }
  const body: Record<string, unknown> = {
    model: omniModelId(),
    reasoning_effort: "low",
    stream: false,
    store: true,
    input: [
      {
        role: "user",
        content,
      },
    ],
  };
  if (input.previousResponseId) {
    body.previous_response_id = input.previousResponseId;
  }
  const response = await fetch(`${input.baseUrl}/responses`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${input.apiKey}`,
      "Content-Type": "application/json",
      [SESSION_CACHE_HEADER]: "enable",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(90_000),
  });
  const payload = (await response.json()) as unknown;
  if (!response.ok) {
    throw new Error(`Responses ${response.status}: ${summarizeError(payload)}`);
  }
  const text = textFromResponses(payload);
  if (!text) {
    throw new Error("Responses のテキストが空です");
  }
  return {
    text,
    responseId: responseIdOf(payload),
    cachedTokens: cachedTokensOf(payload),
  };
}

async function perceiveViaChat(
  baseUrl: string,
  apiKey: string,
  prompt: string,
  videoUrl?: string,
): Promise<string> {
  const content: Array<Record<string, unknown>> = [
    { type: "text", text: prompt },
  ];
  if (videoUrl) {
    content.push({ type: "video_url", video_url: { url: videoUrl } });
  }
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: omniModelId(),
      reasoning_effort: "low",
      stream: true,
      messages: [
        {
          role: "user",
          content,
        },
      ],
    }),
    signal: AbortSignal.timeout(90_000),
  });
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as unknown;
    throw new Error(
      `Chat Completions ${response.status}: ${summarizeError(payload)}`,
    );
  }
  if (!response.body) {
    throw new Error("Chat Completions のストリームが空です");
  }
  return readChatStream(response.body);
}

async function readChatStream(body: ReadableStream<Uint8Array>): Promise<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) {
        continue;
      }
      const data = trimmed.slice(5).trim();
      if (data === "[DONE]") {
        continue;
      }
      try {
        const json = JSON.parse(data) as {
          choices?: Array<{
            delta?: { content?: string; reasoning_content?: string };
          }>;
        };
        const delta = json.choices?.[0]?.delta?.content;
        if (typeof delta === "string") {
          content += delta;
        }
      } catch {
        // ignore malformed sse chunks
      }
    }
  }
  return content;
}

function textFromResponses(payload: unknown): string {
  if (!payload || typeof payload !== "object") {
    return "";
  }
  const record = payload as Record<string, unknown>;
  if (typeof record.output_text === "string") {
    return record.output_text;
  }
  const output = record.output;
  if (Array.isArray(output)) {
    const pieces: string[] = [];
    for (const item of output) {
      if (!item || typeof item !== "object") {
        continue;
      }
      const content = (item as { content?: unknown }).content;
      if (!Array.isArray(content)) {
        continue;
      }
      for (const part of content) {
        if (!part || typeof part !== "object") {
          continue;
        }
        const typed = part as { type?: string; text?: string };
        if (
          (typed.type === "output_text" || typed.type === "text") &&
          typeof typed.text === "string"
        ) {
          pieces.push(typed.text);
        }
      }
    }
    return pieces.join("");
  }
  return "";
}

function responseIdOf(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object") {
    return undefined;
  }
  const id = (payload as { id?: unknown }).id;
  return typeof id === "string" && id.trim() ? id.trim() : undefined;
}

function cachedTokensOf(payload: unknown): number {
  if (!payload || typeof payload !== "object") {
    return 0;
  }
  const usage = (payload as { usage?: unknown }).usage;
  if (!usage || typeof usage !== "object") {
    return 0;
  }
  const record = usage as Record<string, unknown>;
  const details =
    record.input_tokens_details && typeof record.input_tokens_details === "object"
      ? (record.input_tokens_details as Record<string, unknown>)
      : undefined;
  return Math.max(
    0,
    asNumber(details?.cached_tokens, asNumber(record.cached_tokens, 0)),
  );
}

async function toInlineVideoUrl(
  filePath: string,
  notes: string[],
): Promise<string> {
  const original = await stat(filePath);
  if (original.size <= MAX_INLINE_BYTES) {
    const bytes = await readFile(filePath);
    return `data:;base64,${bytes.toString("base64")}`;
  }

  const compressed = path.join(
    os.tmpdir(),
    "cutline",
    `compressed-${path.basename(filePath)}`,
  );
  await compressVideo(filePath, compressed);
  const after = await stat(compressed);
  if (after.size > MAX_INLINE_BYTES) {
    throw new Error(
      `圧縮後も ${after.size} bytes あり、インライン送信上限を超えています`,
    );
  }
  notes.push("動画が大きいため低解像度プロキシを Qwen に渡しました。");
  const bytes = await readFile(compressed);
  return `data:;base64,${bytes.toString("base64")}`;
}

function normalizePerception(
  raw: unknown,
  input: { fileName: string; durationMs: number; brief: string },
  source: Perception["source"],
): Perception {
  const record = (raw ?? {}) as Record<string, unknown>;
  const durationMs =
    asNumber(record.durationMs, input.durationMs) || input.durationMs;
  const participants = Array.isArray(record.participants)
    ? record.participants
        .map((item) => {
          if (!item || typeof item !== "object") {
            return null;
          }
          const row = item as Record<string, unknown>;
          return {
            id: asString(row.id, "A"),
            role: asString(row.role, "speaker"),
          };
        })
        .filter((item): item is { id: string; role: string } => item !== null)
    : mockPerception(input).participants;
  const topics = Array.isArray(record.topics)
    ? record.topics
        .map((item) => asString(item, ""))
        .filter((item) => item.length > 0)
    : mockPerception(input).topics;
  const keyMoments = Array.isArray(record.keyMoments)
    ? record.keyMoments
        .map((item) => asString(item, ""))
        .filter((item) => item.length > 0)
    : mockPerception(input).keyMoments;
  const brollCues = parseOmniBrollCues({
    brollCues: record.brollCues,
    keyMoments,
    topics,
    durationMs,
  });

  return {
    title: asString(record.title, input.fileName.replace(/\.[^.]+$/, "")),
    durationMs,
    language: asString(record.language, "ja"),
    summary: asString(record.summary, input.brief),
    storyline: asString(record.storyline, asString(record.summary, input.brief)),
    topics,
    keyMoments,
    participants,
    brollCues: brollCues.length > 0 ? brollCues : undefined,
    source,
  };
}

function normalizeWindowAnalysis(
  raw: unknown,
  fallback: ConversationWindowAnalysis,
): ConversationWindowAnalysis {
  const record = (raw ?? {}) as Record<string, unknown>;
  const turns = Array.isArray(record.turns)
    ? record.turns
        .map((item) => {
          if (!item || typeof item !== "object") {
            return null;
          }
          const row = item as Record<string, unknown>;
          const text = asString(row.text, "");
          if (!text) {
            return null;
          }
          return {
            speaker: asString(row.speaker, "A"),
            text,
            startMs: asNumber(row.startMs, fallback.targetStartMs),
            endMs: asNumber(row.endMs, fallback.targetEndMs),
          };
        })
        .filter((item): item is ConversationWindowAnalysis["turns"][number] => item !== null)
    : fallback.turns;
  const speakers = Array.isArray(record.speakers)
    ? record.speakers
        .map((item) => asString(item, ""))
        .filter((item) => item.length > 0)
    : fallback.speakers;
  const summaryText =
    typeof record.summary === "string" ? record.summary.trim() : "";
  const summaryFromModel = summaryText.length > 0;
  const turnsFromModel = Array.isArray(record.turns) && turns.length > 0;
  const speakersFromModel = Array.isArray(record.speakers) && speakers.length > 0;
  const fellBack = !summaryFromModel || !turnsFromModel || !speakersFromModel;
  return {
    ...fallback,
    source: fellBack ? "mock" : "live",
    summary: summaryFromModel ? summaryText : fallback.summary,
    speakers: speakers.length > 0 ? speakers : fallback.speakers,
    turns: turns.length > 0 ? turns : fallback.turns,
  };
}

function normalizeCameraVisual(
  raw: unknown,
  fallback: OmniCameraVisual,
): OmniCameraVisual {
  const record = recordOf(raw);
  const expression = asString(record.expression, fallback.expression ?? "");
  const subject = asString(record.subject, fallback.subject ?? "");
  return {
    subject: subject || fallback.subject,
    usable: asBoolean(record.usable, fallback.usable),
    expression: expression || fallback.expression,
  };
}

function normalizeSpeakerCamera(value: unknown, fallback: string): string {
  const raw = asString(value, "").trim().toLowerCase().replace(/\s+/g, "_");
  if (!raw) {
    return fallback;
  }
  if (raw === "wide" || raw === "w" || raw === "cam_wide" || raw === "camera_wide") {
    return "cam_wide";
  }
  const letter = raw.replace(/^(cam_|camera_)/, "");
  if (!letter) {
    return fallback;
  }
  return `cam_${letter}`;
}

function listenerReactionLabel(value: unknown, fallback: string): string {
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  const record = recordOf(value);
  const labeled = asString(record.label ?? record.type ?? record.kind, "");
  return labeled || fallback;
}

function listenerReactionObject(
  ...values: unknown[]
): Record<string, unknown> {
  for (const value of values) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const record = value as Record<string, unknown>;
      if ("strength" in record) {
        return record;
      }
    }
  }
  return {};
}

function speakerCameraOf(speaker: string): string {
  const letter = speaker.trim().toLowerCase() || "a";
  return `cam_${letter}`;
}

function listenerReactionLabelOf(unit: EditUnit): string {
  if (unit.role === "backchannel") {
    return "nod";
  }
  return "none";
}

function listenerReactionStrengthOf(unit: EditUnit): number {
  if (unit.role === "backchannel") {
    return 0.7;
  }
  if (mockOmniPauseLabel(unit) === "dramatic_pause") {
    return 0.87;
  }
  if (unit.role === "pause") {
    return 0.2;
  }
  return 0.12;
}

function expressionOf(strength: number): string {
  return strength >= 0.7 ? "surprised" : "neutral";
}

function topicOf(unit: EditUnit, perception?: Perception): string | undefined {
  const topics = perception?.topics ?? [];
  if (topics.length === 0) {
    return undefined;
  }
  const start = unit.startMs;
  if (start >= 17_000) {
    return topics[2] ?? topics[topics.length - 1];
  }
  if (start >= 8_000) {
    return topics[1] ?? topics[0];
  }
  return topics[0];
}

function recordOf(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.min(1, Math.max(0, value));
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
