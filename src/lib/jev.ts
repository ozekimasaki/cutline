import "server-only";

import { experimental_evaluate as evaluate } from "ai";
import { mockSignals } from "./sample";
import { jevEnv } from "./env";
import type { EditUnit, JevProvider, JevSignals, SignalKey } from "./types";
import { SIGNAL_KEYS } from "./types";

const VERCEL_MODEL = "typesafe-ai/jev";
const CLOUDFLARE_MODEL = "typesafe/jev";

export async function evaluateUnit(unit: EditUnit): Promise<JevSignals> {
  const env = jevEnv();
  if (!env.live) {
    return mockSignals(unit);
  }
  try {
    if (env.preferred === "cloudflare") {
      return await evaluateViaCloudflare(unit, env.accountId, env.cloudflareToken);
    }
    return await evaluateViaVercel(unit);
  } catch {
    try {
      if (env.preferred === "cloudflare" && env.vercelKey) {
        return await evaluateViaVercel(unit);
      }
      if (env.preferred === "vercel" && env.cloudflareToken) {
        return await evaluateViaCloudflare(
          unit,
          env.accountId,
          env.cloudflareToken,
        );
      }
    } catch {
      // mock fallback
    }
    return mockSignals(unit);
  }
}

async function evaluateViaVercel(unit: EditUnit): Promise<JevSignals> {
  const result = await evaluate({
    model: VERCEL_MODEL,
    state: unitState(unit),
    questions: vercelQuestions(),
    providerOptions: {
      gateway: { zeroDataRetention: true },
    },
  });
  const confidenceMeta = result.providerMetadata?.typesafe?.confidence as
    | Record<string, number>
    | undefined;
  const signals = emptySignals("vercel");
  for (const key of SIGNAL_KEYS) {
    const answer = result.answers[key];
    signals[key] = clamp01(answer.probability);
  }
  signals.confidence = median([
    ...SIGNAL_KEYS.map((key) => confidenceMeta?.[key] ?? signals[key]),
  ]);
  return signals;
}

async function evaluateViaCloudflare(
  unit: EditUnit,
  accountId: string,
  token: string,
): Promise<JevSignals> {
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: CLOUDFLARE_MODEL,
        input: {
          state: unitState(unit),
          questions: cloudflareQuestions(),
        },
      }),
      signal: AbortSignal.timeout(30_000),
    },
  );
  const payload = (await response.json()) as unknown;
  if (!response.ok) {
    throw new Error(`Cloudflare Jev ${response.status}`);
  }
  const answers = unwrapCloudflareAnswers(payload);
  const signals = emptySignals("cloudflare");
  const confidences: number[] = [];
  for (const key of SIGNAL_KEYS) {
    signals[key] = readProbability(answers[key]);
    const confidence = readConfidence(answers[key]);
    if (typeof confidence === "number") {
      confidences.push(confidence);
    }
  }
  signals.confidence = confidences.length ? median(confidences) : 0.8;
  return signals;
}

function unitState(unit: EditUnit) {
  return {
    speaker: unit.speaker,
    text: unit.text,
    roleHint: unit.role,
    pauseClass: unit.pauseClass ?? null,
    previous: unit.previous ?? "",
    next: unit.next ?? "",
    startMs: unit.startMs,
    endMs: unit.endMs,
  };
}

function vercelQuestions() {
  return Object.fromEntries(
    SIGNAL_KEYS.map((key) => [
      key,
      {
        type: "boolean" as const,
        instructions: questionCopy(key),
      },
    ]),
  );
}

function cloudflareQuestions() {
  return Object.fromEntries(
    SIGNAL_KEYS.map((key) => [
      key,
      {
        type: "noul",
        instructions: questionCopy(key),
      },
    ]),
  );
}

function questionCopy(key: SignalKey): string {
  switch (key) {
    case "importance":
      return "Is this edit unit important to the conversation?";
    case "novelty":
      return "Does it add new information?";
    case "redundancy":
      return "Is it redundant with nearby units?";
    case "contextRequired":
      return "Is it required as context for a later claim or answer?";
    case "filler":
      return "Is it a filler such as えー or あの?";
    case "falseStart":
      return "Is it a false start that is later corrected?";
    case "selfCorrection":
      return "Is it a self-correction that discards a previous start?";
    case "tangent":
      return "Is it a tangent off the current topic?";
    case "humanTexture":
      return "Does it carry human texture that should usually remain?";
    case "removalNatural":
      return "Would removing it sound natural?";
    case "reactionValue":
      return "Does it have listener reaction value?";
    case "reviewRequired":
      return "Should a human review this unit instead of auto-applying?";
    default: {
      const _never: never = key;
      return _never;
    }
  }
}

function emptySignals(provider: JevProvider): JevSignals {
  return {
    importance: 0.5,
    novelty: 0.5,
    redundancy: 0.5,
    contextRequired: 0.5,
    filler: 0.5,
    falseStart: 0.5,
    selfCorrection: 0.5,
    tangent: 0.5,
    humanTexture: 0.5,
    removalNatural: 0.5,
    reactionValue: 0.5,
    reviewRequired: 0.5,
    confidence: 0.5,
    provider,
  };
}

function unwrapCloudflareAnswers(payload: unknown): Record<string, unknown> {
  if (!payload || typeof payload !== "object") {
    return {};
  }
  const record = payload as Record<string, unknown>;
  const result = record.result;
  if (result && typeof result === "object") {
    const nested = result as Record<string, unknown>;
    const response = nested.response;
    if (response && typeof response === "object") {
      const answers = (response as { answers?: unknown }).answers;
      if (answers && typeof answers === "object") {
        return answers as Record<string, unknown>;
      }
    }
    if (nested.answers && typeof nested.answers === "object") {
      return nested.answers as Record<string, unknown>;
    }
  }
  if (record.answers && typeof record.answers === "object") {
    return record.answers as Record<string, unknown>;
  }
  return record;
}

function readProbability(answer: unknown): number {
  if (!answer || typeof answer !== "object") {
    return 0.5;
  }
  const record = answer as Record<string, unknown>;
  if (typeof record.probability === "number") {
    return clamp01(record.probability);
  }
  if (typeof record.noul === "number") {
    return clamp01(record.noul);
  }
  return 0.5;
}

function readConfidence(answer: unknown): number | undefined {
  if (!answer || typeof answer !== "object") {
    return undefined;
  }
  const record = answer as Record<string, unknown>;
  return typeof record.confidence === "number" ? record.confidence : undefined;
}

function median(values: number[]): number {
  if (values.length === 0) {
    return 0.8;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

export function allowsJevCache(modelVersion: string, value: unknown): boolean {
  if (!modelVersion.startsWith("jev:") || modelVersion === "jev:mock") {
    return true;
  }
  if (!value || typeof value !== "object") {
    return true;
  }
  return (value as { provider?: unknown }).provider !== "mock";
}

export function resolveJevProvider(): JevProvider {
  const env = jevEnv();
  return env.live ? env.preferred : "mock";
}
