import { classifyPause } from "./decide";
import type { EditUnit, TranscriptCue } from "./types";

const PAUSE_GAP_MS = 250;

const FILLER_PREFIX = /^(えっと|えっと|えー+|うーん|あのー?|まあ)[、,，]?/;
const SENTENCE_PUNCT = /[。．.！？!?]+/g;
const ELLIPSIS = /(?:……+|…+|\.{3,})/g;
const COMMA_THEN_BOUNDARY =
  /[、,，]\s*(?=いや|いえ|じゃなくて|違う|訂正|ではなく|そして|それで|それから|でも|だけど|ただし|ただ(?:、|\s)|だから|なので|けれども|けど|一方)/;
const FALSE_START_THEN_CORRECTION =
  /^(去年|来年|昨日|今日|さっき)(?=いや|じゃなくて|違う|訂正|ではなく)/;

type CueSegment = {
  speaker: string;
  text: string;
  startMs: number;
  endMs: number;
};

type TextPiece = {
  raw: string;
  text: string;
};

export function buildEditUnits(cues: TranscriptCue[]): EditUnit[] {
  const spoken: CueSegment[] = [];
  for (const cue of cues) {
    spoken.push(...splitCue(cue));
  }

  const units: EditUnit[] = [];
  for (let index = 0; index < spoken.length; index += 1) {
    const segment = spoken[index];
    const previous = spoken[index - 1];
    if (previous) {
      const gap = segment.startMs - previous.endMs;
      if (gap >= PAUSE_GAP_MS) {
        units.push({
          id: `pause_${units.length + 1}`,
          speaker: previous.speaker,
          text: "",
          startMs: previous.endMs,
          endMs: segment.startMs,
          role: "pause",
          pauseClass: classifyPause(gap),
        });
      }
    }
    units.push({
      id: `eu_${units.length + 1}`,
      speaker: segment.speaker,
      text: segment.text,
      startMs: segment.startMs,
      endMs: segment.endMs,
      role: inferRole(segment.text),
    });
  }
  return attachNeighbors(units);
}

function splitCue(cue: TranscriptCue): CueSegment[] {
  const pieces = splitText(cue.text);
  if (pieces.length <= 1) {
    return [
      {
        speaker: cue.speaker,
        text: cue.text,
        startMs: cue.startMs,
        endMs: cue.endMs,
      },
    ];
  }
  return allocateTimes(cue, pieces);
}

function splitText(text: string): TextPiece[] {
  const raws: string[] = [];
  let rest = text;
  while (rest.length > 0) {
    const cut = nextCut(rest);
    if (cut === undefined) {
      raws.push(rest);
      break;
    }
    raws.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  return raws
    .map((raw) => ({ raw, text: cleanSegment(raw) }))
    .filter((piece) => piece.text.length > 0);
}

function nextCut(text: string): number | undefined {
  const cuts: number[] = [];
  const add = (index: number) => {
    if (index > 0 && index < text.length) {
      cuts.push(index);
    }
  };

  const filler = text.match(FILLER_PREFIX);
  if (filler && filler[0].length < text.length) {
    add(filler[0].length);
  }

  SENTENCE_PUNCT.lastIndex = 0;
  const sentence = SENTENCE_PUNCT.exec(text);
  if (sentence) {
    add(sentence.index + sentence[0].length);
  }

  ELLIPSIS.lastIndex = 0;
  const ellipsis = ELLIPSIS.exec(text);
  if (ellipsis) {
    const end = ellipsis.index + ellipsis[0].length;
    const left = cleanSegment(text.slice(0, ellipsis.index));
    const right = cleanSegment(text.slice(end));
    if (left.length > 0 && right.length > 0) {
      add(end);
    }
  }

  COMMA_THEN_BOUNDARY.lastIndex = 0;
  const comma = COMMA_THEN_BOUNDARY.exec(text);
  if (comma) {
    add(comma.index + 1);
  }

  const falseStart = text.match(FALSE_START_THEN_CORRECTION);
  if (falseStart) {
    add(falseStart[0].length);
  }

  return cuts.length > 0 ? Math.min(...cuts) : undefined;
}

function cleanSegment(text: string): string {
  return text
    .replace(/^(?:……+|…+|\.{3,})+/u, "")
    .replace(/^[\s、,，]+/u, "")
    .replace(/(?:……+|…+|\.{3,})+$/u, "")
    .replace(/[、,，。．.]+$/u, "")
    .trim();
}

function allocateTimes(cue: TranscriptCue, pieces: TextPiece[]): CueSegment[] {
  const total = pieces.reduce((sum, piece) => sum + Math.max(1, piece.raw.length), 0);
  const span = Math.max(0, cue.endMs - cue.startMs);
  let cursor = cue.startMs;
  return pieces.map((piece, index) => {
    const weight = Math.max(1, piece.raw.length) / total;
    const end =
      index === pieces.length - 1
        ? cue.endMs
        : Math.min(cue.endMs, cursor + Math.max(1, Math.round(span * weight)));
    const startMs = cursor;
    const endMs = Math.max(startMs, end);
    cursor = endMs;
    return {
      speaker: cue.speaker,
      text: piece.text,
      startMs,
      endMs,
    };
  });
}

function attachNeighbors(units: EditUnit[]): EditUnit[] {
  return units.map((unit, index) => ({
    ...unit,
    previous: findSpoken(units, index, -1)?.text,
    next: findSpoken(units, index, 1)?.text,
  }));
}

function findSpoken(
  units: EditUnit[],
  from: number,
  step: 1 | -1,
): EditUnit | undefined {
  for (let index = from + step; index >= 0 && index < units.length; index += step) {
    if (units[index]?.role !== "pause") {
      return units[index];
    }
  }
  return undefined;
}

function inferRole(text: string): EditUnit["role"] {
  const trimmed = text.trim();
  if (!trimmed) {
    return "pause";
  }
  if (/^(えー|あの|その|まあ|えっと|えーっと|うーん)$/.test(trimmed)) {
    return "filler";
  }
  if (/^(へえ|うん|はい|そうですね|なるほど)$/.test(trimmed)) {
    return "backchannel";
  }
  if (/いや|じゃなくて|違う|訂正/.test(trimmed)) {
    return "self_correction";
  }
  if (trimmed.length <= 4 && /去年|来年|昨日/.test(trimmed)) {
    return "false_start";
  }
  return "content";
}
