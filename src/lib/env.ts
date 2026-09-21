import type { JevProvider } from "./types";

const DEFAULT_QWEN_BASE =
  "https://dashscope-intl.aliyuncs.com/compatible-mode/v1";
const DEFAULT_CF_ACCOUNT = "6f2f1ee8a618e7fcb9f6737c3a84c526";

export function qwenEnv() {
  const apiKey = process.env.DASHSCOPE_API_KEY?.trim() ?? "";
  const baseUrl = (
    process.env.DASHSCOPE_BASE_URL?.trim() || DEFAULT_QWEN_BASE
  ).replace(/\/$/, "");
  return { apiKey, baseUrl, live: apiKey.length > 0 };
}

export function jevEnv(): {
  preferred: Exclude<JevProvider, "mock">;
  live: boolean;
  vercelKey: string;
  cloudflareToken: string;
  accountId: string;
} {
  const preferred =
    process.env.JEV_PROVIDER === "cloudflare" ? "cloudflare" : "vercel";
  const vercelKey =
    process.env.AI_GATEWAY_API_KEY?.trim() ||
    process.env.VERCEL_OIDC_TOKEN?.trim() ||
    "";
  const cloudflareToken = process.env.CLOUDFLARE_API_TOKEN?.trim() || "";
  const accountId =
    process.env.CLOUDFLARE_ACCOUNT_ID?.trim() || DEFAULT_CF_ACCOUNT;
  const live =
    preferred === "cloudflare"
      ? cloudflareToken.length > 0
      : vercelKey.length > 0;
  return { preferred, live, vercelKey, cloudflareToken, accountId };
}

export function asrModelId(): string {
  return process.env.QWEN_ASR_MODEL?.trim() || "qwen-audio-asr-flash-filetrans";
}

export function omniModelId(): string {
  return process.env.QWEN_OMNI_MODEL?.trim() || "qwen3.8-omni-flash";
}

export function providerStatus() {
  const qwen = qwenEnv();
  const jev = jevEnv();
  return {
    qwen: qwen.live ? ("live" as const) : ("mock" as const),
    asr: qwen.live ? ("live" as const) : ("mock" as const),
    asrModel: asrModelId(),
    omniModel: omniModelId(),
    jev: jev.live ? jev.preferred : ("mock" as const),
    jevConfigured: jev.live,
    jevPreferred: jev.preferred,
  };
}
