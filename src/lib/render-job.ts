import path from "node:path";
import os from "node:os";
import { mkdir } from "node:fs/promises";
import { keptClips } from "./decide";
import {
  detectVideoEncoder,
  lastWorkerBackendUsed,
  parseLoudness,
  renderKeptClips,
  validateRender,
  withHandles,
} from "./engine";
import {
  parseExportPreset,
  renderOutputDurationMs,
  toRenderGraphClips,
} from "./ffmpeg";
import { computeJobMetricsFromJob } from "./metrics";
import { rebuildFromClips } from "./pipeline";
import { getJob, getMedia, updateJob } from "./store";
import type {
  ExportPreset,
  ExportValidation,
  Job,
  LoudnessProfile,
  SpeakerAssignment,
  WatchQa,
} from "./types";
import { applyWatchFixes } from "./watch";
import { watchEditedVideo } from "./qwen";

export type RenderJobInput = {
  jobId: string;
  loudness?: string | LoudnessProfile;
  preset?: string | ExportPreset;
};

export type RenderJobSuccess = {
  ok: true;
  jobId: string;
  renderPath: string;
  validation: ExportValidation | undefined;
  watchQa: WatchQa | undefined;
  encoder: string;
  preset: ExportPreset;
  loudness: LoudnessProfile;
  worker: "python" | "ts";
};

export type RenderJobFailure = {
  ok: false;
  error: string;
  status: 404 | 409 | 500;
};

export type RenderJobResult = RenderJobSuccess | RenderJobFailure;

export type RenderJobDeps = {
  detectVideoEncoder?: typeof detectVideoEncoder;
  renderKeptClips?: typeof renderKeptClips;
  validateRender?: typeof validateRender;
  watchEditedVideo?: typeof watchEditedVideo;
  lastWorkerBackendUsed?: typeof lastWorkerBackendUsed;
};

export function micPathsFromSpeakers(
  speakers: SpeakerAssignment[] | undefined,
): Partial<Record<"A" | "B", string>> {
  const micPaths: Partial<Record<"A" | "B", string>> = {};
  for (const speaker of speakers ?? []) {
    if (!isAbMic(speaker.id)) {
      continue;
    }
    const filePath = speaker.filePath?.trim();
    if (!filePath) {
      continue;
    }
    micPaths[speaker.id] = filePath;
  }
  return micPaths;
}

function isAbMic(id: string): id is "A" | "B" {
  return id === "A" || id === "B";
}

function validationError(renderQa: ExportValidation): string {
  const detail = renderQa.notes.filter(Boolean).join(" / ");
  return detail
    ? `書き出しの検証に失敗しました。${detail}`
    : "書き出しの検証に失敗しました。";
}

function failRender(
  jobId: string,
  error: string,
  status: 409 | 500,
  renderQa?: ExportValidation,
): RenderJobFailure {
  updateJob(jobId, {
    phase: "error",
    error,
    renderPath: undefined,
    renderQa,
  });
  return { ok: false, error, status };
}

export async function renderJob(
  input: RenderJobInput,
  deps: RenderJobDeps = {},
): Promise<RenderJobResult> {
  const loudness = parseLoudness(input.loudness);
  const preset = parseExportPreset(input.preset);
  const detectEncoder = deps.detectVideoEncoder ?? detectVideoEncoder;
  const renderClips = deps.renderKeptClips ?? renderKeptClips;
  const validate = deps.validateRender ?? validateRender;
  const watchVideo = deps.watchEditedVideo ?? watchEditedVideo;
  const workerUsed = deps.lastWorkerBackendUsed ?? lastWorkerBackendUsed;
  const job = getJob(input.jobId);
  if (!job) {
    return { ok: false, error: "ジョブが見つかりません。", status: 404 };
  }
  if (job.phase !== "ready") {
    return { ok: false, error: "書き出しは判定完了後です。", status: 409 };
  }
  if (!job.mediaId) {
    return { ok: false, error: "素材がありません。", status: 409 };
  }
  const media = getMedia(job.mediaId);
  if (!media) {
    return { ok: false, error: "素材が見つかりません。", status: 404 };
  }
  const kept = keptClips(job.clips);
  if (kept.length === 0) {
    return { ok: false, error: "残すクリップがありません。", status: 409 };
  }
  const dir = path.join(os.tmpdir(), "cutline", "renders");
  const outputPath = path.join(dir, `${input.jobId}-edited.mp4`);
  const cameraPaths: Partial<Record<"A" | "B" | "WIDE", string>> = {};
  for (const cam of job.cameras ?? []) {
    const item = getMedia(cam.mediaId);
    if (item) {
      cameraPaths[cam.id] = item.filePath;
    }
  }
  try {
    await mkdir(dir, { recursive: true });
    const encoder = await detectEncoder();
    let current: Job = job;
    let watchNotes: string[] = [];
    for (let iteration = 0; iteration < 3; iteration += 1) {
      const phase =
        iteration === 0
          ? "rendering_proxy"
          : iteration === 2
            ? "final_render"
            : "watching";
      updateJob(input.jobId, {
        phase,
        encoder,
        error: undefined,
        renderPath: undefined,
        renderQa: undefined,
      });
      const currentKept = keptClips(current.clips);
      if (currentKept.length === 0) {
        return failRender(input.jobId, "残すクリップがありません。", 409);
      }
      await renderClips({
        sourcePath: media.filePath,
        outputPath,
        clips: currentKept,
        sourceDurationMs: current.sourceDurationMs,
        cameraPaths,
        micPaths: micPathsFromSpeakers(current.speakers),
        loudness,
        preset,
      });
      const handled = withHandles(currentKept, current.sourceDurationMs);
      const expectedDurationMs = renderOutputDurationMs(
        toRenderGraphClips(handled, currentKept),
      );
      const renderQa = await validate({
        filePath: outputPath,
        expectedDurationMs,
      });
      if (!renderQa.ok) {
        return failRender(
          input.jobId,
          validationError(renderQa),
          500,
          renderQa,
        );
      }
      updateJob(input.jobId, {
        phase: "watching",
        renderPath: outputPath,
        renderQa,
        encoder,
        error: undefined,
      });
      const watched = await watchVideo({
        filePath: outputPath,
        clips: current.clips,
        continuity: current.continuity,
      });
      const watchQa = { ...watched.watch, iterations: iteration + 1 };
      watchNotes = watched.notes;
      updateJob(input.jobId, {
        watchQa,
        metrics: computeJobMetricsFromJob({ ...current, watchQa }),
      });
      if (watchQa.ok || iteration === 2) {
        updateJob(input.jobId, {
          phase: "ready",
          error: undefined,
          notes: [
            ...current.notes.filter((note) => !note.startsWith("Omni 再視聴")),
            ...watchNotes,
            `Omni 再視聴 ${watchQa.ok ? "OK" : "要確認"} · ${iteration + 1} 回 · encoder ${encoder} · worker ${workerUsed()}`,
          ],
        });
        break;
      }
      const fixed = applyWatchFixes(current.clips, watchQa);
      const changed = fixed.some(
        (clip, index) => clip.verdict !== current.clips[index]?.verdict,
      );
      if (!changed) {
        updateJob(input.jobId, {
          phase: "ready",
          error: undefined,
          notes: [
            ...current.notes,
            ...watchNotes,
            `Omni 再視聴の指摘を直せませんでした · encoder ${encoder}`,
          ],
        });
        break;
      }
      const rebuilt = rebuildFromClips(input.jobId, fixed);
      if (!rebuilt) {
        updateJob(input.jobId, {
          phase: "ready",
          error: undefined,
          notes: [
            ...current.notes,
            ...watchNotes,
            `Omni 再視聴の指摘を直せませんでした · encoder ${encoder}`,
          ],
        });
        break;
      }
      current = rebuilt;
    }
    const ready = getJob(input.jobId);
    if (
      !ready ||
      ready.phase !== "ready" ||
      ready.renderQa?.ok !== true ||
      !ready.renderPath
    ) {
      return failRender(
        input.jobId,
        ready?.error || "書き出しの検証に失敗しました。",
        500,
        ready?.renderQa?.ok === false ? ready.renderQa : undefined,
      );
    }
    return {
      ok: true,
      jobId: input.jobId,
      renderPath: ready.renderPath,
      validation: ready.renderQa,
      watchQa: ready.watchQa,
      encoder,
      preset,
      loudness,
      worker: workerUsed(),
    };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "FFmpeg 書き出しに失敗しました。";
    return failRender(input.jobId, message, 500);
  }
}
