import type { Topic, TopicImportance, TranscriptCue } from "./types";

export function analyzeTopics(input: {
  cues: TranscriptCue[];
  titles: string[];
  durationMs: number;
}): Topic[] {
  const titles = input.titles.length > 0 ? input.titles : ["本題"];
  const durationMs = Math.max(1, input.durationMs);
  return titles.map((title, index) => {
    const startMs = Math.round((index / titles.length) * durationMs);
    const endMs = Math.round(((index + 1) / titles.length) * durationMs);
    const windowText = input.cues
      .filter((cue) => cue.endMs > startMs && cue.startMs < endMs)
      .map((cue) => cue.text)
      .join(" ");
    const importance = topicImportanceOf(title, windowText, index, titles.length);
    const viewerValue =
      importance === "high" ? 0.86 : importance === "medium" ? 0.62 : 0.34;
    const redundancy = /えー|えーっと|あの/.test(windowText) ? 0.28 : 0.12;
    const narrativeDependency = /？|\?|だから|なので/.test(windowText)
      ? 0.8
      : 0.45;
    return {
      id: `topic_${String(index + 1).padStart(2, "0")}`,
      title,
      importance,
      startMs,
      endMs,
      redundancy,
      narrativeDependency,
      viewerValue,
      removability: Math.max(0.05, 1 - viewerValue - narrativeDependency * 0.2),
    };
  });
}

function topicImportanceOf(
  title: string,
  text: string,
  index: number,
  total: number,
): TopicImportance {
  if (/プロダクト|判断|実装|核/.test(title) || /Jev|Qwen|役割/.test(text)) {
    return "high";
  }
  if (/転職|会社|きっかけ/.test(title) || /会社|辞め/.test(text)) {
    return "high";
  }
  if (index === 0 && total > 1) {
    return "medium";
  }
  return "medium";
}
