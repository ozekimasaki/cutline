import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import {
  assignCameras as assignCamerasTs,
} from "./camera";
import {
  computeKeepScore,
  decideVerdict,
} from "./decide";
import {
  detectVideoEncoder as detectVideoEncoderTs,
  loudnessForPreset,
  loudnormFilter,
  parseExportPreset,
  parseLoudness,
  measureCameraOffsetsMs,
  renderKeptClips as renderKeptClipsTs,
  targetLufs,
  withHandles,
} from "./ffmpeg";
import { validateRender as validateRenderTs } from "./validate";
import type {
  EditProfile,
  ExportValidation,
  JevSignals,
  LoudnessProfile,
  ScoredClip,
  Verdict,
} from "./types";

export type DecideBackend = "rust" | "ts";
export type WorkerBackend = "python" | "ts";

export type EngineDecision = {
  id: string;
  keepScore: number;
  verdict: Verdict;
  autoMarker: boolean;
};

type RenderInput = Parameters<typeof renderKeptClipsTs>[0];

let lastDecideBackend: DecideBackend = "ts";
let lastWorkerBackend: WorkerBackend = "ts";
let cachedPythonBin: string | null | undefined;
let cachedEncoder: string | undefined;

export function lastDecideBackendUsed(): DecideBackend {
  return lastDecideBackend;
}

export function lastWorkerBackendUsed(): WorkerBackend {
  return lastWorkerBackend;
}

export function rustBinaryPath(): string {
  if (process.env.CUTLINE_ENGINE_BIN) {
    return process.env.CUTLINE_ENGINE_BIN;
  }
  const name =
    process.platform === "win32" ? "cutline-engine.exe" : "cutline-engine";
  return path.join(process.cwd(), "engine-rs", "target", "release", name);
}

export function pythonWorkerPath(): string {
  return path.join(process.cwd(), "engine", "worker.py");
}

export function rustEngineAvailable(): boolean {
  if (process.env.CUTLINE_SKIP_ENGINE === "1") {
    return false;
  }
  return existsSync(rustBinaryPath());
}

export function pythonWorkerAvailable(): boolean {
  if (process.env.CUTLINE_SKIP_WORKER === "1") {
    return false;
  }
  return existsSync(pythonWorkerPath()) && Boolean(pythonBin());
}

export { withHandles, parseLoudness, parseExportPreset };

export function decideUnits(
  units: { id: string; signals: JevSignals }[],
  profile: EditProfile,
): EngineDecision[] {
  if (rustEngineAvailable()) {
    try {
      const raw = runRust("decide", {
        profile,
        units: units.map((unit) => ({
          id: unit.id,
          signals: unit.signals,
        })),
      });
      const parsed = parseDecideOut(raw);
      if (parsed && parsed.length === units.length) {
        const byId = new Map(parsed.map((item) => [item.id, item]));
        const merged = units.map((unit) => {
          const hit = byId.get(unit.id);
          if (!hit) {
            throw new Error(`missing decision ${unit.id}`);
          }
          return hit;
        });
        lastDecideBackend = "rust";
        return merged;
      }
    } catch {
      // TypeScript keepScore / verdict
    }
  }
  lastDecideBackend = "ts";
  return decideUnitsTs(units, profile);
}

export function decideVerdictWithEngine(
  signals: JevSignals,
  keepScore: number,
  profile: EditProfile,
  id = "unit",
): { verdict: Verdict; autoMarker: boolean; keepScore: number } {
  const [decision] = decideUnits([{ id, signals }], profile);
  if (decision) {
    return {
      verdict: decision.verdict,
      autoMarker: decision.autoMarker,
      keepScore: decision.keepScore,
    };
  }
  const fallback = decideVerdict(signals, keepScore);
  return { ...fallback, keepScore };
}

export function computeKeepScoreWithEngine(
  signals: JevSignals,
  profile: EditProfile,
  id = "unit",
): number {
  const [decision] = decideUnits([{ id, signals }], profile);
  return decision?.keepScore ?? computeKeepScore(signals, profile);
}

export function assignCameras(clips: ScoredClip[]): ScoredClip[] {
  if (rustEngineAvailable() && clips.length > 0) {
    try {
      const raw = runRust("cameras", {
        clips: clips.map((clip) => ({
          id: clip.id,
          speaker: clip.speaker,
          role: clip.role,
          startMs: clip.startMs,
          endMs: clip.endMs,
          verdict: clip.verdict,
          signals: { reactionValue: clip.signals.reactionValue },
          omni: omniVisualForCameras(clip),
        })),
      });
      const assigned = parseCameraOut(raw);
      if (assigned) {
        lastDecideBackend = "rust";
        return clips.map((clip) => {
          const hit = assigned.get(clip.id);
          if (!hit) {
            return clip;
          }
          return {
            ...clip,
            camera: hit.camera ?? clip.camera,
            punchIn: hit.punchIn,
            morph: hit.morph,
            cameraReason: hit.cameraReason ?? clip.cameraReason,
          };
        });
      }
    } catch {
      // TypeScript camera solver
    }
  }
  lastDecideBackend = "ts";
  return assignCamerasTs(clips);
}

export function pythonRenderPayload(input: RenderInput) {
  const preset = parseExportPreset(input.preset);
  const loudness = loudnessForPreset(preset, input.loudness);
  return {
    command: "render" as const,
    sourcePath: input.sourcePath,
    outputPath: input.outputPath,
    clips: input.clips,
    sourceDurationMs: input.sourceDurationMs ?? 0,
    cameraPaths: input.cameraPaths ?? {},
    cameraOffsetsMs: input.cameraOffsetsMs ?? {},
    micPaths: input.micPaths ?? {},
    loudness,
    preset,
  };
}

export async function renderKeptClips(input: RenderInput): Promise<void> {
  const cameraOffsetsMs =
    input.cameraOffsetsMs ??
    (await measureCameraOffsetsMs({
      sourcePath: input.sourcePath,
      cameraPaths: input.cameraPaths,
    }));
  const next = { ...input, cameraOffsetsMs };
  if (pythonWorkerAvailable()) {
    try {
      const result = runPython(pythonRenderPayload(next));
      if (result.ok === true) {
        lastWorkerBackend = "python";
        if (typeof result.encoder === "string") {
          cachedEncoder = result.encoder;
        }
        return;
      }
    } catch {
      // TypeScript ffmpeg
    }
  }
  lastWorkerBackend = "ts";
  await renderKeptClipsTs(next);
}

export async function validateRender(input: {
  filePath: string;
  expectedDurationMs: number;
}): Promise<ExportValidation> {
  if (pythonWorkerAvailable()) {
    try {
      const result = runPython({
        command: "validate",
        filePath: input.filePath,
        expectedDurationMs: input.expectedDurationMs,
      });
      const parsed = parseValidation(result, input.expectedDurationMs);
      if (parsed) {
        lastWorkerBackend = "python";
        return parsed;
      }
    } catch {
      // TypeScript validate
    }
  }
  lastWorkerBackend = "ts";
  return validateRenderTs(input);
}

export async function detectVideoEncoder(): Promise<string> {
  if (cachedEncoder) {
    return cachedEncoder;
  }
  if (pythonWorkerAvailable()) {
    try {
      const result = runPython({ command: "render", probeOnly: true });
      if (typeof result.encoder === "string" && result.encoder.length > 0) {
        cachedEncoder = result.encoder;
        lastWorkerBackend = "python";
        return cachedEncoder;
      }
    } catch {
      // TypeScript encoder probe
    }
  }
  lastWorkerBackend = "ts";
  cachedEncoder = await detectVideoEncoderTs();
  return cachedEncoder;
}

export async function loudnessSettings(profile: LoudnessProfile): Promise<{
  profile: LoudnessProfile;
  targetLufs: number;
  filter: string;
  backend: WorkerBackend;
}> {
  if (pythonWorkerAvailable()) {
    try {
      const result = runPython({ command: "loudness", profile });
      if (result.ok === true && typeof result.filter === "string") {
        lastWorkerBackend = "python";
        return {
          profile,
          targetLufs: Number(result.targetLufs),
          filter: result.filter,
          backend: "python",
        };
      }
    } catch {
      // TypeScript loudness
    }
  }
  lastWorkerBackend = "ts";
  return {
    profile,
    targetLufs: targetLufs(profile),
    filter: loudnormFilter(profile),
    backend: "ts",
  };
}

function omniVisualForCameras(clip: ScoredClip) {
  const visual = clip.omni?.visual;
  if (!visual) {
    return undefined;
  }
  return {
    visual: {
      camera_a: {
        usable: visual.camera_a.usable,
        expression: visual.camera_a.expression,
      },
      camera_b: {
        usable: visual.camera_b.usable,
        expression: visual.camera_b.expression,
      },
      wide: {
        usable: visual.wide.usable,
        expression: visual.wide.expression,
      },
      listener_reaction: { strength: visual.listener_reaction.strength },
    },
  };
}

function decideUnitsTs(
  units: { id: string; signals: JevSignals }[],
  profile: EditProfile,
): EngineDecision[] {
  return units.map((unit) => {
    const keepScore = computeKeepScore(unit.signals, profile);
    const decision = decideVerdict(unit.signals, keepScore);
    return {
      id: unit.id,
      keepScore,
      verdict: decision.verdict,
      autoMarker: decision.autoMarker,
    };
  });
}

function runRust(command: "decide" | "cameras", payload: unknown): unknown {
  const result = spawnSync(rustBinaryPath(), [command], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
    timeout: 15_000,
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || `engine ${command} failed`);
  }
  return JSON.parse(result.stdout) as unknown;
}

function runPython(payload: unknown): Record<string, unknown> {
  const bin = pythonBin();
  if (!bin) {
    throw new Error("python が見つかりません");
  }
  const result = spawnSync(bin, [pythonWorkerPath()], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
    timeout: 180_000,
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || "python worker failed");
  }
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

function pythonBin(): string | undefined {
  if (cachedPythonBin !== undefined) {
    return cachedPythonBin ?? undefined;
  }
  if (process.env.CUTLINE_PYTHON) {
    cachedPythonBin = process.env.CUTLINE_PYTHON;
    return cachedPythonBin;
  }
  for (const name of ["python3", "python"]) {
    const probe = spawnSync(name, ["-c", "import sys; print(sys.executable)"], {
      encoding: "utf8",
      timeout: 5_000,
    });
    if (probe.status === 0) {
      cachedPythonBin = name;
      return name;
    }
  }
  cachedPythonBin = null;
  return undefined;
}

function parseDecideOut(raw: unknown): EngineDecision[] | undefined {
  if (!raw || typeof raw !== "object") {
    return undefined;
  }
  const decisions = (raw as { decisions?: unknown }).decisions;
  if (!Array.isArray(decisions)) {
    return undefined;
  }
  const parsed: EngineDecision[] = [];
  for (const item of decisions) {
    if (!item || typeof item !== "object") {
      return undefined;
    }
    const row = item as Record<string, unknown>;
    const verdict = parseVerdict(row.verdict);
    if (!verdict || typeof row.id !== "string") {
      return undefined;
    }
    parsed.push({
      id: row.id,
      keepScore: Number(row.keepScore),
      verdict,
      autoMarker: Boolean(row.autoMarker),
    });
  }
  return parsed;
}

function parseCameraOut(
  raw: unknown,
): Map<string, { camera?: ScoredClip["camera"]; punchIn?: boolean; morph?: boolean; cameraReason?: string }> | undefined {
  if (!raw || typeof raw !== "object") {
    return undefined;
  }
  const clips = (raw as { clips?: unknown }).clips;
  if (!Array.isArray(clips)) {
    return undefined;
  }
  const assigned = new Map<
    string,
    { camera?: ScoredClip["camera"]; punchIn?: boolean; morph?: boolean; cameraReason?: string }
  >();
  for (const item of clips) {
    if (!item || typeof item !== "object") {
      return undefined;
    }
    const row = item as Record<string, unknown>;
    if (typeof row.id !== "string") {
      return undefined;
    }
    assigned.set(row.id, {
      camera: parseCameraId(row.camera),
      punchIn: typeof row.punchIn === "boolean" ? row.punchIn : undefined,
      morph: typeof row.morph === "boolean" ? row.morph : undefined,
      cameraReason:
        typeof row.cameraReason === "string" ? row.cameraReason : undefined,
    });
  }
  return assigned;
}

function parseValidation(
  raw: Record<string, unknown>,
  expectedDurationMs: number,
): ExportValidation | undefined {
  if (typeof raw.durationMs !== "number" || typeof raw.hasAudio !== "boolean") {
    return undefined;
  }
  return {
    durationMs: Number(raw.durationMs),
    expectedDurationMs: Number(raw.expectedDurationMs ?? expectedDurationMs),
    hasAudio: Boolean(raw.hasAudio),
    hasVideo: Boolean(raw.hasVideo),
    blackFrames: Boolean(raw.blackFrames),
    frozenFrames: Boolean(raw.frozenFrames),
    silenceAnomaly: Boolean(raw.silenceAnomaly),
    avSyncOk: Boolean(raw.avSyncOk),
    ok: Boolean(raw.ok),
    notes: Array.isArray(raw.notes)
      ? raw.notes.filter((note): note is string => typeof note === "string")
      : [],
  };
}

function parseVerdict(value: unknown): Verdict | undefined {
  switch (value) {
    case "keep":
    case "cut":
    case "review":
      return value;
    default:
      return undefined;
  }
}

function parseCameraId(value: unknown): ScoredClip["camera"] | undefined {
  switch (value) {
    case "A":
    case "B":
    case "WIDE":
      return value;
    default:
      return undefined;
  }
}
