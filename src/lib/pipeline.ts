import "server-only";

import { randomUUID } from "node:crypto";
import { transcribeAudio } from "./asr";
import {
  buildTimelineIR,
  packToTargetDuration,
} from "./decide";
import { captionImportanceOf, shouldBurnIn } from "./caption";
import { runContinuityCheck } from "./continuity";
import { asrModelId, omniModelId, providerStatus } from "./env";
import { evaluateUnit } from "./jev";
import { analyzeConversationWindow, perceiveUnitStates, perceiveVideo } from "./qwen";
import {
  cacheGet,
  cacheSet,
  mediaHashOf,
  promptVersion,
} from "./persist";
import { applyAudioBoundaries } from "./boundary";
import { applySemanticSafety, buildMeaningLinks } from "./safety";
import { brollSummary, ensureBrollSlate, insertBroll } from "./broll";
import { assignCameras, decideUnits, lastDecideBackendUsed } from "./engine";
import {
  applyPreference,
  getChannelProfile,
  loadPreferenceContext,
  recordHumanOverride,
  saveChannelProfile,
} from "./preference";
import { computeJobMetrics } from "./metrics";
import { runFinalQa } from "./qa";
import { createJob, getJob, getMedia, updateJob } from "./store";
import { analyzeTopics } from "./topics";
import { buildEditUnits } from "./units";
import { sliceConversationWindows } from "./windows";
import {
  jobSourcesFromCameras,
  prepareAnalysisMedia,
  type JobMediaSource,
} from "./ingest";
import {
  asrCacheKind,
  parseSpeakerCountHint,
  perMicAsrJobs,
  planSpeakerProcessing,
  resolveTranscriptSpeakers,
  withTimelineSpeakers,
  type SpeakerPlan,
  type SpeakerSourceInput,
} from "./speaker";
import {
  buildEditedTranscript,
  evaluateEditedUnit,
  runEditedTranscriptRebuild,
} from "./transcript";
import type {
  CameraAngle,
  ChannelProfile,
  ContinuityQa,
  ConversationWindowAnalysis,
  EditProfile,
  Job,
  JevSignals,
  OmniUnitState,
  Perception,
  ScoredClip,
  SpeakerAssignment,
  TimelineIR,
  TranscriptCue,
} from "./types";

const running = new Map<string, Promise<void>>();

export type StartJobInput = {
  brief: string;
  profile: EditProfile;
  targetDurationMs: number;
  fileName: string;
  filePath?: string;
  mediaId?: string;
  durationMs: number;
  cameras?: CameraAngle[];
  channelProfile?: ChannelProfile;
  sources?: JobMediaSource[];
  manualOffsetsMs?: Record<string, number>;
  speakerCount?: number;
};

export function startJob(input: StartJobInput): Job {
  if (input.channelProfile) {
    saveChannelProfile(input.channelProfile);
  }
  const status = providerStatus();
  const cameras = input.cameras ?? [];
  const channelProfile = getChannelProfile();
  const job = createJob({
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    phase: "queued",
    brief: input.brief,
    profile: input.profile,
    targetDurationMs: input.targetDurationMs,
    mediaId: input.mediaId,
    fileName: input.fileName,
    sourceDurationMs: input.durationMs,
    cameras,
    speakers: [],
    speakerCountHint: parseSpeakerCountHint(input.speakerCount),
    transcript: [],
    clips: [],
    links: [],
    qwenMode: status.qwen,
    asrMode: status.asr,
    jevProvider: status.jev,
    notes: cameras.length > 1 ? [`カメラ ${cameras.map((cam) => cam.id).join(" / ")}`] : [],
    pass: 0,
    chapters: [],
    cacheHits: 0,
    channelProfile,
  });
  const work = runJob(job.id, input).catch((error: unknown) => {
    updateJob(job.id, {
      phase: "error",
      error: error instanceof Error ? error.message : String(error),
    });
  });
  running.set(job.id, work);
  void work.finally(() => running.delete(job.id));
  return job;
}

async function runJob(id: string, input: StartJobInput): Promise<void> {
  const existing = getJob(id);
  const sources = jobSourcesFromCameras(
    existing?.cameras ?? input.cameras ?? [],
    (mediaId) => getMedia(mediaId),
    input.sources ?? [],
  );
  let durationMs = input.durationMs;
  let analysisPath = input.filePath;
  let ingestNotes: string[] = [];
  let speakerSources: SpeakerSourceInput[] = sources.map((item) => ({
    fileName: item.fileName,
    filePath: item.filePath,
    role: item.role,
  }));
  let mixChannels: number | null | undefined;
  try {
    const prepared = await prepareAnalysisMedia({
      filePath: input.filePath,
      fileName: input.fileName,
      durationMs: input.durationMs,
      sources: sources.length ? sources : undefined,
      manualOffsetsMs: input.manualOffsetsMs,
      jobId: id,
    });
    durationMs = prepared.durationMs || durationMs;
    analysisPath = prepared.analysisPath ?? analysisPath;
    ingestNotes = prepared.notes;
    mixChannels = prepared.mix?.audioChannels;
    if (prepared.sources.length) {
      speakerSources = prepared.sources.map((item) => ({
        fileName: item.fileName,
        filePath: item.filePath,
        role: item.role,
        audioChannels: item.audioChannels,
      }));
    }
  } catch (error) {
    ingestNotes = [
      `ingest: 失敗したため原盤で続行 (${error instanceof Error ? error.message : String(error)})`,
    ];
  }
  const speakerPlan = planSpeakerProcessing({
    sources: speakerSources,
    mixChannels,
    speakerCountHint: input.speakerCount,
    durationMs,
  });
  updateJob(id, {
    phase: "transcribing",
    pass: 0,
    sourceDurationMs: durationMs,
    speakers: publicSpeakers(speakerPlan.speakers),
    speakerCountHint: speakerPlan.speakerCount,
    notes: [...(existing?.notes ?? []), ...ingestNotes, ...speakerPlan.notes],
  });
  const mediaHash = await mediaHashOf(input.filePath);
  let cacheHits = 0;
  const asrLookup = {
    mediaHash,
    timeRange: `0-${durationMs}`,
    modelVersion: asrModelId(),
    promptVersion: promptVersion(),
    kind: asrCacheKind(speakerPlan),
  };
  const cachedAsr = cacheGet<{
    cues: TranscriptCue[];
    mode: "live" | "mock";
    notes: string[];
  }>(asrLookup);
  const asr =
    cachedAsr ??
    (await transcribeWithSpeakers({
      filePath: analysisPath,
      fileName: input.fileName,
      durationMs,
      plan: speakerPlan,
    }));
  if (cachedAsr) {
    cacheHits += 1;
  } else {
    cacheSet(asrLookup, asr);
  }
  updateJob(id, {
    transcript: asr.cues,
    asrMode: asr.mode,
    speakers: publicSpeakers(speakerPlan.speakers),
    notes: [...ingestNotes, ...speakerPlan.notes, ...asr.notes],
    cacheHits,
    phase: "understanding",
    pass: 0,
  });

  const omniLookup = {
    mediaHash,
    timeRange: `0-${durationMs}`,
    modelVersion: omniModelId(),
    promptVersion: promptVersion(),
    kind: "perception",
  };
  const cachedOmni = cacheGet<{ perception: Perception; notes: string[] }>(
    omniLookup,
  );
  const perceived =
    cachedOmni ??
    (await perceiveVideo({
      filePath: analysisPath,
      fileName: input.fileName,
      durationMs,
      brief: input.brief,
    }));
  if (cachedOmni) {
    cacheHits += 1;
  } else {
    cacheSet(omniLookup, perceived);
  }
  const chapters = analyzeTopics({
    cues: asr.cues,
    titles: perceived.perception.topics,
    durationMs: perceived.perception.durationMs || durationMs,
  });
  updateJob(id, {
    perception: perceived.perception,
    qwenMode: perceived.perception.source,
    notes: [
      ...ingestNotes,
      ...speakerPlan.notes,
      ...asr.notes,
      ...perceived.notes,
      `PASS 0 全体把握 / PASS 1 トピック ${chapters.length}`,
    ],
    sourceDurationMs: perceived.perception.durationMs || durationMs,
    chapters,
    cacheHits,
    phase: "understanding",
    pass: 1,
  });

  const sourceDurationMs = perceived.perception.durationMs || durationMs;
  const conversationWindows = sliceConversationWindows({
    durationMs: sourceDurationMs,
    cues: asr.cues,
    topics: chapters,
  });
  const windowAnalyses: ConversationWindowAnalysis[] = [];
  const windowNotes: string[] = [];
  updateJob(id, { pass: 2, phase: "understanding" });
  for (const window of conversationWindows) {
    const windowLookup = {
      mediaHash,
      timeRange: `${window.contextStartMs}-${window.contextEndMs}`,
      modelVersion: omniModelId(),
      promptVersion: promptVersion(),
      kind: `pass2:${window.id}`,
    };
    const cachedWindow = cacheGet<{
      analysis: ConversationWindowAnalysis;
      notes: string[];
    }>(windowLookup);
    const analyzed =
      cachedWindow ??
      (await analyzeConversationWindow({
        filePath: analysisPath,
        fileName: input.fileName,
        durationMs: sourceDurationMs,
        brief: input.brief,
        window,
        cues: asr.cues,
        storyline: perceived.perception.storyline,
        perception: perceived.perception,
      }));
    if (cachedWindow) {
      cacheHits += 1;
    } else {
      cacheSet(windowLookup, analyzed);
    }
    windowAnalyses.push(analyzed.analysis);
    for (const note of analyzed.notes) {
      if (!windowNotes.includes(note)) {
        windowNotes.push(note);
      }
    }
  }
  const liveWindows = windowAnalyses.filter((item) => item.source === "live").length;
  const mockWindows = windowAnalyses.length - liveWindows;
  const pass2Note = `PASS 2 会話窓 ${windowAnalyses.length}（30–90s · ±30s）· Omni live ${liveWindows} / mock ${mockWindows}`;
  const units = buildEditUnits(asr.cues);
  const links = buildMeaningLinks(units);
  const unitStateLookup = {
    mediaHash,
    timeRange: `0-${sourceDurationMs}`,
    modelVersion: omniModelId(),
    promptVersion: promptVersion(),
    kind: "omni-unit-states",
  };
  const cachedUnitStates = cacheGet<{
    states: OmniUnitState[];
    notes: string[];
  }>(unitStateLookup);
  const unitStates =
    cachedUnitStates ??
    (await perceiveUnitStates({
      units,
      perception: perceived.perception,
      filePath: analysisPath,
      fileName: input.fileName,
    }));
  if (cachedUnitStates) {
    cacheHits += 1;
  } else {
    cacheSet(unitStateLookup, unitStates);
  }
  const omniById = new Map(
    units.map((unit, index) => [unit.id, unitStates.states[index]]),
  );
  const omniStateNote = `Omni 単位 State ${unitStates.states.length}（Edit / Visual）`;
  updateJob(id, {
    windows: windowAnalyses,
    links,
    cacheHits,
    notes: [
      ...ingestNotes,
      ...speakerPlan.notes,
      ...asr.notes,
      ...perceived.notes,
      ...windowNotes,
      ...unitStates.notes,
      `PASS 0 全体把握 / PASS 1 トピック ${chapters.length}`,
      pass2Note,
      omniStateNote,
    ],
    phase: "deciding",
    pass: 2,
  });

  const drafted: { unit: (typeof units)[number]; signals: JevSignals }[] = [];
  for (const unit of units) {
    const jevLookup = {
      mediaHash,
      timeRange: `${unit.startMs}-${unit.endMs}`,
      modelVersion: `jev:${providerStatus().jev}`,
      promptVersion: promptVersion(),
      kind: `jev:${unit.id}`,
    };
    const cachedSignals = cacheGet<JevSignals>(jevLookup);
    const signals = cachedSignals ?? (await evaluateUnit(unit));
    if (cachedSignals) {
      cacheHits += 1;
    } else {
      cacheSet(jevLookup, signals);
    }
    drafted.push({ unit, signals });
  }
  const decided = decideUnits(
    drafted.map(({ unit, signals }) => ({ id: unit.id, signals })),
    input.profile,
  );
  const byId = new Map(decided.map((item) => [item.id, item]));
  const preference = loadPreferenceContext();
  let preferenceHits = 0;
  const clips: ScoredClip[] = drafted.map(({ unit, signals }) => {
    const decision = byId.get(unit.id);
    const scored: ScoredClip = {
      ...unit,
      signals,
      keepScore: decision?.keepScore ?? 0,
      autoMarker: decision?.autoMarker ?? false,
      verdict: decision?.verdict ?? "keep",
      verdictSource: "code",
      reason: reasonOf(unit),
      captionImportance: captionImportanceOf({ signals }),
      omni: omniById.get(unit.id),
    };
    const adjusted = applyPreference(scored, preference);
    if (
      adjusted.keepScore !== scored.keepScore ||
      adjusted.verdict !== scored.verdict
    ) {
      preferenceHits += 1;
    }
    adjusted.burnIn = shouldBurnIn(adjusted);
    return adjusted;
  });

  updateJob(id, { phase: "building_timeline", cacheHits, pass: 2 });
  const packed = packToTargetDuration(clips, input.targetDurationMs);
  const rebuilt = await runEditedTranscriptRebuild({
    clips: packed,
    profile: input.profile,
    evaluateUnit: async (unit) => {
      const jevLookup = {
        mediaHash,
        timeRange: `${unit.startMs}-${unit.endMs}`,
        modelVersion: `jev:${providerStatus().jev}`,
        promptVersion: promptVersion(),
        kind: `jev2:${unit.id}`,
      };
      const cachedSignals = cacheGet<JevSignals>(jevLookup);
      if (cachedSignals) {
        cacheHits += 1;
        return cachedSignals;
      }
      const signals = await evaluateEditedUnit(unit);
      cacheSet(jevLookup, signals);
      return signals;
    },
  });
  const packedAfter = packToTargetDuration(
    rebuilt.clips,
    input.targetDurationMs,
  );
  updateJob(id, {
    phase: "qa",
    pass: 3,
    editedTranscript: rebuilt.editedTranscript,
    cacheHits,
  });
  const safe = applySemanticSafety(packedAfter, links, input.profile);
  const framed = assignCameras(safe).map((clip) => ({
    ...clip,
    captionImportance: clip.captionImportance ?? captionImportanceOf(clip),
    burnIn: shouldBurnIn(clip),
  }));
  let qa = runFinalQa(framed);
  let continuity: ContinuityQa = runContinuityCheck(framed);
  let working = framed;
  for (let iteration = 0; iteration < 2 && continuity.issues.length > 0; iteration += 1) {
    working = patchContinuity(working, continuity);
    continuity = runContinuityCheck(working);
    qa = runFinalQa(working);
  }
  const extraRisks = continuity.issues
    .filter(
      (issue) =>
        !qa.meaningRisks.some(
          (risk) => risk.clipId === (issue.clipId ?? "") && risk.issue === issue.issue,
        ),
    )
    .map((issue) => ({
      clipId: issue.clipId ?? "",
      issue: issue.issue,
    }));
  qa = {
    ...qa,
    meaningRisks: [...qa.meaningRisks, ...extraRisks],
  };
  working = await applyAudioBoundaries(working, {
    filePath: input.filePath,
    durationMs,
  });
  let slateSource: string | undefined;
  try {
    slateSource = await ensureBrollSlate();
  } catch {
    // IR still gets a color-slate filename; do not fetch stock
  }
  const timeline = timelineWithBroll({
    timelineId: id,
    fileName: input.fileName,
    clips: working,
    chapters,
    perception: perceived.perception,
    slateSource,
    speakers: publicSpeakers(speakerPlan.speakers),
  });
  const metrics = computeJobMetrics({
    clips: working,
    sourceDurationMs: durationMs,
    timeline,
    qa,
    continuity,
    aiReviewMs: getJob(id)?.metrics?.humanCorrectionTime?.aiReviewMs,
  });
  const jevProvider = working[0]?.signals.provider ?? providerStatus().jev;
  const brollNote = brollSummary(timeline);
  updateJob(id, {
    clips: working,
    links,
    timeline,
    qa,
    continuity,
    metrics,
    chapters,
    windows: windowAnalyses,
    editedTranscript: rebuilt.editedTranscript,
    speakers: publicSpeakers(speakerPlan.speakers),
    jevProvider,
    cacheHits,
    pass: 3,
    notes: [
      ...ingestNotes,
      ...speakerPlan.notes,
      ...asr.notes,
      ...perceived.notes,
      ...windowNotes,
      ...unitStates.notes,
      `PASS 0 全体把握 / PASS 1 トピック ${chapters.length}`,
      pass2Note,
      omniStateNote,
      ...rebuilt.notes,
      `PASS 0–3 完了 · キャッシュヒット ${cacheHits} · 判定 ${lastDecideBackendUsed() === "rust" ? "Rust" : "TS"} · preference ${preferenceHits}`,
      "Audio Boundary: KEEP の切点は波形（VAD → 無音 → ゼロクロス）",
      ...(brollNote ? [brollNote] : []),
    ],
    phase: "ready",
  });
}

export function applyManualVerdict(
  jobId: string,
  clipId: string,
  verdict: "keep" | "cut" | "shorten",
): Job | undefined {
  const job = getJob(jobId);
  if (!job) {
    return undefined;
  }
  const target = job.clips.find((clip) => clip.id === clipId);
  if (target) {
    const human = verdict === "shorten" ? "keep" : verdict;
    if ((human === "keep" || human === "cut") && target.verdict !== human) {
      recordHumanOverride({
        text: target.text,
        speaker: target.speaker,
        role: target.role,
        aiVerdict: target.verdict,
        humanVerdict: human,
      });
    }
  }
  const clips = job.clips.map((clip) => {
    if (clip.id !== clipId) {
      return clip;
    }
    if (verdict === "shorten") {
      const mid = clip.startMs + Math.round((clip.endMs - clip.startMs) * 0.6);
      return {
        ...clip,
        endMs: Math.max(clip.startMs + 80, mid),
        verdict: "keep" as const,
        verdictSource: "user" as const,
      };
    }
    return {
      ...clip,
      verdict,
      verdictSource: "user" as const,
    };
  });
  const links = job.links.length ? job.links : buildMeaningLinks(clips);
  const safe = applySemanticSafety(clips, links, job.profile);
  const framed = assignCameras(safe).map((clip) => ({
    ...clip,
    burnIn: shouldBurnIn(clip),
  }));
  const qa = runFinalQa(framed);
  const continuity = runContinuityCheck(framed);
  const timeline = timelineWithBroll({
    timelineId: job.id,
    fileName: job.fileName,
    clips: framed,
    chapters: job.chapters,
    perception: job.perception,
    speakers: job.speakers,
  });
  const metrics = computeJobMetrics({
    clips: framed,
    sourceDurationMs: job.sourceDurationMs,
    timeline,
    qa,
    watchQa: job.watchQa,
    continuity,
    aiReviewMs: job.metrics?.humanCorrectionTime?.aiReviewMs,
  });
  return updateJob(jobId, {
    clips: framed,
    links,
    timeline,
    qa,
    continuity,
    metrics,
    renderPath: undefined,
    renderQa: undefined,
    editedTranscript: buildEditedTranscript(framed, {
      source: job.editedTranscript?.source ?? "mock",
      notes: job.editedTranscript?.notes ?? [],
      rescoreCount: job.editedTranscript?.rescoreCount ?? 0,
    }),
  });
}

export function rebuildFromClips(
  jobId: string,
  clips: ScoredClip[],
): Job | undefined {
  const job = getJob(jobId);
  if (!job) {
    return undefined;
  }
  const links = job.links.length ? job.links : buildMeaningLinks(clips);
  const safe = applySemanticSafety(clips, links, job.profile);
  const framed = assignCameras(safe).map((clip) => ({
    ...clip,
    burnIn: shouldBurnIn(clip),
  }));
  const qa = runFinalQa(framed);
  const continuity = runContinuityCheck(framed);
  const timeline = timelineWithBroll({
    timelineId: job.id,
    fileName: job.fileName,
    clips: framed,
    chapters: job.chapters,
    perception: job.perception,
    speakers: job.speakers,
  });
  const metrics = computeJobMetrics({
    clips: framed,
    sourceDurationMs: job.sourceDurationMs,
    timeline,
    qa,
    watchQa: job.watchQa,
    continuity,
    aiReviewMs: job.metrics?.humanCorrectionTime?.aiReviewMs,
  });
  return updateJob(jobId, {
    clips: framed,
    links,
    timeline,
    qa,
    continuity,
    metrics,
    editedTranscript: buildEditedTranscript(framed, {
      source: job.editedTranscript?.source ?? "mock",
      notes: job.editedTranscript?.notes ?? [],
      rescoreCount: job.editedTranscript?.rescoreCount ?? 0,
    }),
  });
}

function timelineWithBroll(input: {
  timelineId: string;
  fileName: string;
  clips: ScoredClip[];
  chapters?: Job["chapters"];
  perception?: Perception;
  slateSource?: string;
  speakers?: SpeakerAssignment[];
}): TimelineIR {
  return withTimelineSpeakers(
    insertBroll(
      buildTimelineIR({
        timelineId: input.timelineId,
        fileName: input.fileName,
        clips: input.clips,
      }),
      {
        clips: input.clips,
        chapters: input.chapters,
        perception: input.perception,
        slateSource: input.slateSource,
      },
    ),
    input.speakers ?? [],
  );
}

async function transcribeWithSpeakers(input: {
  filePath?: string;
  fileName: string;
  durationMs: number;
  plan: SpeakerPlan;
}): Promise<{ cues: TranscriptCue[]; mode: "live" | "mock"; notes: string[] }> {
  const mix = await transcribeAudio({
    filePath: input.filePath,
    fileName: input.fileName,
    durationMs: input.durationMs,
    diarizationEnabled: input.plan.diarizationEnabled,
    speakerCount: input.plan.speakerCount,
    channelId: input.plan.channelId,
  });
  const notes = [...mix.notes];
  let micTranscripts:
    | { speakerId: string; cues: TranscriptCue[] }[]
    | undefined;
  if (mix.mode === "live") {
    const jobs = perMicAsrJobs(input.plan);
    const tracks: { speakerId: string; cues: TranscriptCue[] }[] = [];
    let allLive = jobs.length > 0;
    for (const job of jobs) {
      const track = await transcribeAudio({
        filePath: job.filePath,
        fileName: job.fileName,
        durationMs: input.durationMs,
        diarizationEnabled: false,
        speaker: job.speakerId,
      });
      notes.push(...track.notes);
      if (track.mode !== "live") {
        allLive = false;
      }
      tracks.push({ speakerId: job.speakerId, cues: track.cues });
    }
    if (allLive) {
      micTranscripts = tracks;
    }
  }
  const resolved = resolveTranscriptSpeakers({
    cues: mix.cues,
    plan: input.plan,
    micTranscripts,
  });
  return {
    cues: resolved.cues,
    mode: mix.mode,
    notes: [...notes, ...resolved.notes],
  };
}

export function publicSpeakers(speakers: SpeakerAssignment[]): SpeakerAssignment[] {
  return speakers.map((speaker) => ({
    id: speaker.id,
    source: speaker.source,
    fileName: speaker.fileName,
    filePath: speaker.filePath,
    micIndex: speaker.micIndex,
  }));
}

export function patchContinuity(
  clips: ScoredClip[],
  continuity: ContinuityQa,
): ScoredClip[] {
  const flagged = new Set(
    continuity.issues
      .map((issue) => issue.clipId)
      .filter((id): id is string => Boolean(id)),
  );
  const answered = new Set<string>();
  return clips.map((clip, index) => {
    if (clip.verdict !== "cut") {
      return clip;
    }
    if (flagged.has(clip.id)) {
      return { ...clip, verdict: "keep", reason: "PASS 3 restore" };
    }
    const questionBefore = clips
      .slice(0, index)
      .reverse()
      .find((item) => flagged.has(item.id) && /[？?]$/.test(item.text.trim()));
    if (!questionBefore || clip.role !== "content" || answered.has(questionBefore.id)) {
      return clip;
    }
    answered.add(questionBefore.id);
    return { ...clip, verdict: "keep", reason: "PASS 3 restore" };
  });
}

export function reviewBlockMessage(phase: Job["phase"]): string | undefined {
  switch (phase) {
    case "ready":
      return undefined;
    case "rendering_proxy":
    case "watching":
    case "final_render":
      return "書き出し中は判定を変えられません。";
    case "queued":
    case "transcribing":
    case "understanding":
    case "deciding":
    case "building_timeline":
    case "qa":
    case "error":
      return "判定が終わるまで確認できません。";
    default: {
      const _never: never = phase;
      return _never;
    }
  }
}

function reasonOf(unit: { role: ScoredClip["role"]; pauseClass?: ScoredClip["pauseClass"] }): string {
  switch (unit.role) {
    case "filler":
      return "filler";
    case "false_start":
      return "false_start";
    case "self_correction":
      return "self_correction";
    case "pause":
      return unit.pauseClass === "thinking" ? "thinking_pause" : "pause";
    case "backchannel":
      return "backchannel";
    case "content":
      return "content";
    default: {
      const _never: never = unit.role;
      return _never;
    }
  }
}

export function isReadyPhase(phase: Job["phase"]): boolean {
  return phase === "ready";
}

export function parseProfile(value: string): EditProfile {
  switch (value) {
    case "natural":
    case "standard":
    case "tight":
    case "short":
      return value;
    default:
      return "standard";
  }
}

export function parseVerdict(value: string): "keep" | "cut" | "shorten" | undefined {
  switch (value) {
    case "keep":
    case "cut":
    case "shorten":
      return value;
    default:
      return undefined;
  }
}
