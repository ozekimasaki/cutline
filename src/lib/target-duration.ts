export const SAMPLE_DURATION_MS = 24_000;
export const MIN_TARGET_MINUTES = 1;
const MIN_TARGET_MS = MIN_TARGET_MINUTES * 60_000;

export function minutesFromSourceMs(durationMs: number): number {
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    return MIN_TARGET_MINUTES;
  }
  return Math.max(MIN_TARGET_MINUTES, Math.ceil(durationMs / 60_000));
}

export function clampTargetMinutes(value: number, maxMinutes: number): number {
  const max =
    Number.isFinite(maxMinutes) && maxMinutes >= MIN_TARGET_MINUTES
      ? Math.round(maxMinutes)
      : MIN_TARGET_MINUTES;
  if (!Number.isFinite(value)) {
    return max;
  }
  return Math.min(max, Math.max(MIN_TARGET_MINUTES, Math.round(value)));
}

export function resolveTargetDurationMs(
  requestedMs: number,
  sourceDurationMs: number,
): number {
  const source =
    Number.isFinite(sourceDurationMs) && sourceDurationMs > 0
      ? sourceDurationMs
      : 0;
  if (source <= 0) {
    return Number.isFinite(requestedMs) && requestedMs > 0 ? requestedMs : 0;
  }
  if (!Number.isFinite(requestedMs) || requestedMs <= 0) {
    return source;
  }
  const floor = Math.min(MIN_TARGET_MS, source);
  return Math.min(source, Math.max(floor, requestedMs));
}
