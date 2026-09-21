import type { ScoredClip } from "./types";

export const CAPTION_IMPORTANCE_MIN = 0.75;

export function captionImportanceOf(clip: Pick<ScoredClip, "signals">): number {
  return clip.signals.importance;
}

export function shouldBurnIn(clip: ScoredClip): boolean {
  const importance = clip.captionImportance ?? captionImportanceOf(clip);
  return (
    clip.verdict === "keep" &&
    importance >= CAPTION_IMPORTANCE_MIN &&
    clip.text.trim().length >= 8
  );
}

export function escapeDrawtext(text: string): string {
  return text
    .replaceAll("\\", "\\\\")
    .replaceAll("'", "\\'")
    .replaceAll(":", "\\:")
    .replaceAll("%", "\\%");
}

export const BURN_IN_FONT =
  "/usr/share/fonts/truetype/droid/DroidSansFallbackFull.ttf";

export function burnInFilter(textFile: string, fontFile = BURN_IN_FONT): string {
  return `drawtext=fontfile=${escapeDrawtext(fontFile)}:textfile=${escapeDrawtext(textFile)}:expansion=none:x=(w-text_w)/2:y=h-72:fontsize=28:fontcolor=white:box=1:boxcolor=black@0.62`;
}
