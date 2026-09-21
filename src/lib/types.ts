export type EditProfile = "natural" | "standard" | "tight" | "short";

export type LoudnessProfile = "youtube" | "podcast";

export type ExportPreset =
  | "youtube-1080p"
  | "youtube-4k"
  | "podcast-video"
  | "shorts"
  | "archive-prores";

export type PauseClass = "micro" | "normal" | "thinking" | "long";

/** Spec §35. Omni pause labels — distinct from duration PauseClass. */
export const OMNI_PAUSE_LABELS = [
  "dramatic_pause",
  "thinking_pause",
  "awkward_pause",
  "technical_pause",
] as const;

export type OmniPauseLabel = (typeof OMNI_PAUSE_LABELS)[number];

export type SemanticRole =
  | "content"
  | "filler"
  | "false_start"
  | "self_correction"
  | "pause"
  | "backchannel";

export const CHANNEL_RULE_KEYS = [
  "笑い",
  "沈黙",
  "相槌",
  "技術説明",
  "脱線",
] as const;

export type ChannelRuleKey = (typeof CHANNEL_RULE_KEYS)[number];

export const CHANNEL_POLICIES = [
  "残す",
  "短くする",
  "少し残す",
  "ほぼ削らない",
  "積極削除",
] as const;

export type ChannelRulePolicy = (typeof CHANNEL_POLICIES)[number];

export type ChannelProfile = {
  id: string;
  name: string;
  rules: Record<ChannelRuleKey, ChannelRulePolicy>;
};

export const DEFAULT_CHANNEL_PROFILE: ChannelProfile = {
  id: "default",
  name: "既定",
  rules: {
    笑い: "残す",
    沈黙: "短くする",
    相槌: "少し残す",
    技術説明: "ほぼ削らない",
    脱線: "積極削除",
  },
};

export function parseChannelPolicy(
  value: unknown,
  fallback: ChannelRulePolicy = "残す",
): ChannelRulePolicy {
  switch (value) {
    case "残す":
    case "短くする":
    case "少し残す":
    case "ほぼ削らない":
    case "積極削除":
      return value;
    default:
      return fallback;
  }
}

export function parseChannelProfile(value: unknown): ChannelProfile {
  const fallback = DEFAULT_CHANNEL_PROFILE;
  if (!value || typeof value !== "object") {
    return fallback;
  }
  const raw = value as Record<string, unknown>;
  const rulesSource =
    raw.rules && typeof raw.rules === "object"
      ? (raw.rules as Record<string, unknown>)
      : raw;
  const rules = { ...fallback.rules };
  for (const key of CHANNEL_RULE_KEYS) {
    if (key in rulesSource) {
      rules[key] = parseChannelPolicy(rulesSource[key], fallback.rules[key]);
    }
  }
  return {
    id: typeof raw.id === "string" && raw.id.trim() ? raw.id.trim() : fallback.id,
    name:
      typeof raw.name === "string" && raw.name.trim()
        ? raw.name.trim()
        : fallback.name,
    rules,
  };
}

export type JevProvider = "vercel" | "cloudflare" | "mock";

export type CameraId = "A" | "B" | "WIDE";

export type CameraAngle = {
  id: CameraId;
  mediaId: string;
  fileName: string;
  label: string;
};

export type Verdict = "keep" | "cut" | "review";

export type JobPhase =
  | "queued"
  | "transcribing"
  | "understanding"
  | "deciding"
  | "building_timeline"
  | "qa"
  | "rendering_proxy"
  | "watching"
  | "final_render"
  | "ready"
  | "error";

export type JevSignals = {
  importance: number;
  novelty: number;
  redundancy: number;
  contextRequired: number;
  filler: number;
  falseStart: number;
  selfCorrection: number;
  tangent: number;
  humanTexture: number;
  removalNatural: number;
  reactionValue: number;
  reviewRequired: number;
  confidence: number;
  provider: JevProvider;
};

/** Spec §8. Letters A, B, C… — not limited to two speakers. */
export type SpeakerId = string;

export type SpeakerAssignmentSource = "mic" | "diarization" | "mix";

export type SpeakerAssignment = {
  id: SpeakerId;
  source: SpeakerAssignmentSource;
  fileName?: string;
  filePath?: string;
  micIndex?: number;
};

export type TranscriptCue = {
  speaker: SpeakerId;
  text: string;
  startMs: number;
  endMs: number;
};

export type EditUnit = {
  id: string;
  speaker: SpeakerId;
  text: string;
  startMs: number;
  endMs: number;
  role: SemanticRole;
  pauseClass?: PauseClass;
  previous?: string;
  next?: string;
};

export type ScoredClip = EditUnit & {
  signals: JevSignals;
  keepScore: number;
  autoMarker: boolean;
  verdict: Verdict;
  verdictSource: "code" | "user";
  reason: string;
  camera?: CameraId;
  punchIn?: boolean;
  morph?: boolean;
  cameraReason?: string;
  captionImportance?: number;
  burnIn?: boolean;
  semanticStartMs?: number;
  semanticEndMs?: number;
  /** Spec §19 / §37. Omni Edit / Visual State — observation, not a cut. */
  omni?: OmniUnitState;
};

export const BROLL_TAG = "B_ROLL_RECOMMENDED" as const;

export type BrollTag = typeof BROLL_TAG;

export type BrollMotive = "jump_cut" | "topic_visual" | "omni_cue";

export type BrollCue = {
  tag: BrollTag;
  startMs?: number;
  endMs?: number;
  topic?: string;
};

export type TimelineClipKind = "talking_head" | "broll";

export type TimelineBroll = {
  tag: BrollTag;
  motive: BrollMotive;
  placeholder: boolean;
  label?: string;
};

export type TimelineClip = {
  source: string;
  sourceIn: number;
  sourceOut: number;
  timelineIn: number;
  camera: string;
  speaker: SpeakerId;
  decision: {
    reason: string;
    confidence: number;
  };
  kind?: TimelineClipKind;
  track?: "V1" | "V2";
  broll?: TimelineBroll;
};

export type TimelineRemoval = {
  type: "remove";
  start: number;
  end: number;
  reason: string;
  confidence: number;
};

export type TimelineIR = {
  timelineId: string;
  clips: TimelineClip[];
  removals: TimelineRemoval[];
  /** Spec §8. Speaker ids are A, B, C… not hardcoded to two. */
  speakers?: SpeakerAssignment[];
  /** V2 overlays. V1 talking-head clips stay sequential. */
  broll?: TimelineClip[];
};

export type MeaningLinkType =
  | "question_answer"
  | "correction"
  | "contrast"
  | "setup_punchline"
  | "claim_reason";

export type MeaningLink = {
  type: MeaningLinkType;
  fromId: string;
  toId: string;
};

export type FinalQa = {
  meaningRisks: { clipId: string; issue: string }[];
  cutCount: number;
  keepCount: number;
  reviewCount: number;
  finalDurationMs: number;
  humanCorrections: number;
  cameraSwitchCount: number;
  averageShotLengthMs: number;
  jumpCutCount: number;
  cameraSwitchRate: number;
};

export type TopicImportance = "low" | "medium" | "high";

export type Topic = {
  id: string;
  title: string;
  importance: TopicImportance;
  startMs: number;
  endMs: number;
  redundancy: number;
  narrativeDependency: number;
  viewerValue: number;
  removability: number;
};

export type ContinuityQa = {
  conversationMakesSense: boolean;
  missingReferences: boolean;
  pronounLostAntecedent: boolean;
  questionLostAnswer: boolean;
  unnecessaryRepetition: boolean;
  issues: { clipId?: string; issue: string }[];
};

export type Perception = {
  title: string;
  durationMs: number;
  language: string;
  summary: string;
  storyline: string;
  topics: string[];
  keyMoments: string[];
  participants: { id: string; role: string }[];
  brollCues?: BrollCue[];
  source: "live" | "mock";
  /** Spec §14. DashScope Responses id to reuse video + global state. */
  omniResponseId?: string;
};

/** Spec §14. In-process Responses session for video + global state reuse. */
export type OmniSession = {
  mediaKey: string;
  previousResponseId?: string;
};

/** Spec §19. Per-Edit-Unit multimodal state from Omni. */
export type OmniEditState = {
  target: {
    id: string;
    speaker: SpeakerId;
    text: string;
    start: number;
    end: number;
  };
  semantic: {
    role: SemanticRole;
    topic?: string;
    contains_new_information: boolean;
  };
  conversation: {
    previous: string;
    next: string;
  };
  visual: {
    speaker_camera: string;
    listener_reaction: string;
  };
};

/** Spec §37. Per-camera usable / expression. */
export type OmniCameraVisual = {
  subject?: SpeakerId;
  usable: boolean;
  expression?: string;
};

/** Spec §37. Visual State from Omni — observation only, not a camera cut. */
export type OmniVisualState = {
  speaker: SpeakerId;
  camera_a: OmniCameraVisual;
  camera_b: OmniCameraVisual;
  wide: OmniCameraVisual;
  listener_reaction: {
    strength: number;
  };
};

export type OmniUnitState = {
  edit: OmniEditState;
  visual: OmniVisualState;
  pauseLabel?: OmniPauseLabel;
};

/** Spec §16. Target is 30–90s; context is ±30s around the target. */
export type ConversationWindow = {
  id: string;
  targetStartMs: number;
  targetEndMs: number;
  contextStartMs: number;
  contextEndMs: number;
  topicId?: string;
};

export type ConversationTurn = {
  speaker: SpeakerId;
  text: string;
  startMs: number;
  endMs: number;
};

export type ConversationWindowAnalysis = ConversationWindow & {
  source: "live" | "mock";
  summary: string;
  speakers: SpeakerId[];
  turns: ConversationTurn[];
};

/** Spec §30. Rebuilt conversation after 仮編集 (KEEP / REVIEW only). */
export type EditedTranscriptLine = {
  clipId: string;
  speaker: SpeakerId;
  text: string;
  startMs: number;
  endMs: number;
  previous?: string;
  next?: string;
};

export type EditedTranscript = {
  source: "live" | "mock";
  lines: EditedTranscriptLine[];
  notes: string[];
  rescoreCount: number;
};

export type PassId = 0 | 1 | 2 | 3;

export type ProviderStatus = {
  qwen: "live" | "mock";
  asr: "live" | "mock";
  asrModel: string;
  omniModel: string;
  jev: JevProvider;
  jevConfigured: boolean;
  jevPreferred: Exclude<JevProvider, "mock">;
};

export type ExportValidation = {
  durationMs: number;
  expectedDurationMs: number;
  hasAudio: boolean;
  hasVideo: boolean;
  blackFrames: boolean;
  frozenFrames: boolean;
  silenceAnomaly: boolean;
  avSyncOk: boolean;
  ok: boolean;
  notes: string[];
};

export type WatchQa = {
  source: "live" | "mock";
  iterations: number;
  brokenConversations: boolean;
  abruptTopicChanges: boolean;
  obviousBadCuts: boolean;
  audioDiscontinuities: boolean;
  missingContext: boolean;
  awkwardCameraSwitching: boolean;
  issues: { atMs?: number; issue: string; restoreClipId?: string }[];
  ok: boolean;
};

/** Spec §93–97. North star is meaning / texture / watchability, not auto-edit-rate. */
export type JobMetrics = {
  northStar: {
    meaningContinuity: number;
    humanTexture: number;
    watchability: number;
  };
  semantic: {
    criticalDeletionRate: number;
    falseCutRate: number;
    missedCutRate: number;
    continuityError: number;
    meaningChangeRate: number;
  };
  editing: {
    finalDurationMs: number;
    cutCount: number;
    averageShotLengthMs: number;
    cameraSwitchRate: number;
    jumpCutCount: number;
    humanCorrections: number;
  };
  watch: {
    brokenConversations: boolean;
    abruptTopicChanges: boolean;
    obviousBadCuts: boolean;
    audioDiscontinuities: boolean;
    missingContext: boolean;
  };
  keepRatio: number;
  humanTextureRetention: number;
  /** Spec §96. AI-none edit estimate vs measured AI review session. */
  humanCorrectionTime?: HumanCorrectionTime;
};

export type HumanCorrectionTime = {
  sourceDurationMs: number;
  aiNoneEditMs: number;
  aiReviewMs: number;
  savedMs: number;
};

export type Job = {
  id: string;
  createdAt: string;
  phase: JobPhase;
  error?: string;
  brief: string;
  profile: EditProfile;
  targetDurationMs: number;
  mediaId?: string;
  fileName: string;
  sourceDurationMs: number;
  cameras: CameraAngle[];
  /** Spec §8. A, B, C… from per-mic tracks or mix diarization. */
  speakers?: SpeakerAssignment[];
  speakerCountHint?: number;
  perception?: Perception;
  transcript: TranscriptCue[];
  clips: ScoredClip[];
  links: MeaningLink[];
  timeline?: TimelineIR;
  qa?: FinalQa;
  qwenMode: "live" | "mock";
  asrMode: "live" | "mock";
  jevProvider: JevProvider;
  notes: string[];
  pass: PassId;
  chapters: Topic[];
  /** Spec §16 PASS 2. Omni conversation windows (30–90s + ±30s context). */
  windows?: ConversationWindowAnalysis[];
  /** Spec §30. Edited transcript rebuilt after PASS 2 / decide. */
  editedTranscript?: EditedTranscript;
  continuity?: ContinuityQa;
  cacheHits: number;
  renderPath?: string;
  renderQa?: ExportValidation;
  watchQa?: WatchQa;
  metrics?: JobMetrics;
  encoder?: string;
  channelProfile?: ChannelProfile;
};

export const SIGNAL_KEYS = [
  "importance",
  "novelty",
  "redundancy",
  "contextRequired",
  "filler",
  "falseStart",
  "selfCorrection",
  "tangent",
  "humanTexture",
  "removalNatural",
  "reactionValue",
  "reviewRequired",
] as const;

export type SignalKey = (typeof SIGNAL_KEYS)[number];
