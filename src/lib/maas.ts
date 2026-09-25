const DEFAULT_COMPATIBLE_BASE =
  "https://dashscope-intl.aliyuncs.com/compatible-mode/v1";

/** Workspace host such as `{id}.ap-southeast-1.maas.aliyuncs.com`. */
export function isMaasBase(baseUrl: string): boolean {
  try {
    return new URL(baseUrl).hostname.endsWith(".maas.aliyuncs.com");
  } catch {
    return false;
  }
}

/**
 * Omni Chat Completions and Responses live on compatible-mode.
 * A MaaS base of `{origin}/api/v1` does not serve those routes.
 */
export function compatibleModeBase(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/$/, "");
  if (!trimmed) {
    return DEFAULT_COMPATIBLE_BASE;
  }
  if (trimmed.includes("/compatible-mode/")) {
    return trimmed;
  }
  if (!isMaasBase(trimmed)) {
    return trimmed;
  }
  return `${new URL(trimmed).origin}/compatible-mode/v1`;
}

/** Qwen-Audio-ASR inference socket. Model name goes in run-task, not the URL. */
export function messageAsrWebSocketUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/$/, "");
  const url = new URL(trimmed || DEFAULT_COMPATIBLE_BASE);
  const protocol = url.protocol === "http:" ? "ws:" : "wss:";
  return `${protocol}//${url.host}/api-ws/v1/inference`;
}

/** `qwen-audio-3.1-asr-flash-message` is not the Filetrans API. */
export function isMessageAsrModel(model: string): boolean {
  return /asr-flash-message(?:$|[-_])/i.test(model.trim());
}

/** Key is present, but the call hit a route this base does not serve. */
export function isRouteMismatchError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    /Unexpected end of JSON input/.test(message) ||
    /InvalidApiKey/i.test(message) ||
    /Invalid API-key/i.test(message) ||
    /Chat Completions 404\b/.test(message) ||
    /Responses 404\b/.test(message) ||
    /Responses 401\b/.test(message) ||
    /Filetrans submit 401\b/.test(message) ||
    /Filetrans upload policy 401\b/.test(message)
  );
}
