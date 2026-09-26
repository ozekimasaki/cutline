import { access, copyFile, mkdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { ensureSampleCameras, probeDurationMs } from "@/lib/ffmpeg";
import {
  cameraIdFromRole,
  collectDroppedFiles,
  labelFromRole,
  parseManualOffsets,
  roleFromCameraId,
  type JobMediaSource,
} from "@/lib/ingest";
import { ensureShortTalkMedia } from "@/lib/materialize-short-talk";
import { parseProfile, startJob } from "@/lib/pipeline";
import {
  SHORT_TALK_DURATION_MS,
  SHORT_TALK_FILE,
} from "@/lib/short-talk";
import { parseSpeakerCountHint } from "@/lib/speaker";
import { registerMediaPath, saveMediaFile } from "@/lib/store";
import { SAMPLE_DURATION_MS, resolveTargetDurationMs } from "@/lib/target-duration";
import {
  parseChannelProfile,
  type CameraAngle,
  type ChannelProfile,
  type Job,
} from "@/lib/types";

const MAX_UPLOAD_BYTES = 80 * 1024 * 1024;

export async function createJobFromForm(form: FormData): Promise<
  { ok: true; job: Job } | { ok: false; error: string; status: 400 | 413 | 500 }
> {
  try {
    const brief = String(form.get("brief") ?? "");
    const profile = parseProfile(String(form.get("profile") ?? "standard"));
    const rawTarget = form.get("targetDurationMs");
    const requestedTargetMs =
      rawTarget == null || String(rawTarget).trim() === ""
        ? Number.NaN
        : Number(rawTarget);
    const useSample = String(form.get("useSample") ?? "") === "true";
    const speakerCount = parseSpeakerCountHint(
      form.get("speakerCount") ?? form.get("speaker_count"),
    );
    const channelProfile = channelProfileFromForm(form);

    const sampleId = String(form.get("sample") ?? "");
    if (useSample && sampleId === "short-talk") {
      await ensureShortTalkMedia();
      const source = path.join(
        process.cwd(),
        "samples",
        "short-talk",
        "dialogue.mp4",
      );
      try {
        await access(source);
      } catch {
        return {
          ok: false,
          error: "短い対談のサンプルがありません。",
          status: 500,
        };
      }
      const mediaId = randomUUID();
      const dest = path.join(os.tmpdir(), "cutline", "media", `${mediaId}.mp4`);
      await mkdir(path.dirname(dest), { recursive: true });
      await copyFile(source, dest);
      registerMediaPath(mediaId, dest);
      const durationMs = await probeDurationMs(dest).catch(
        () => SHORT_TALK_DURATION_MS,
      );
      const cameras: CameraAngle[] = [
        {
          id: "A",
          mediaId,
          fileName: SHORT_TALK_FILE,
          label: "CAM A",
        },
      ];
      const sources: JobMediaSource[] = [
        {
          filePath: dest,
          fileName: SHORT_TALK_FILE,
          mediaId,
          role: "cam_a",
        },
      ];
      const job = startJob({
        brief,
        profile,
        targetDurationMs: resolveTargetDurationMs(requestedTargetMs, durationMs),
        fileName: SHORT_TALK_FILE,
        filePath: dest,
        mediaId,
        durationMs,
        cameras,
        sources,
        channelProfile,
        speakerCount,
      });
      return { ok: true, job };
    }

    if (useSample) {
      const samples = await ensureSampleCameras();
      const cameras: CameraAngle[] = [];
      for (const [id, source] of [
        ["A", samples.A],
        ["B", samples.B],
        ["WIDE", samples.WIDE],
      ] as const) {
        const mediaId = randomUUID();
        const dest = path.join(os.tmpdir(), "cutline", "media", `${mediaId}.mp4`);
        await mkdir(path.dirname(dest), { recursive: true });
        await copyFile(source, dest);
        registerMediaPath(mediaId, dest);
        cameras.push({
          id,
          mediaId,
          fileName: `cam-${id.toLowerCase()}.mp4`,
          label: `CAM ${id}`,
        });
      }
      const mix = cameras[0];
      if (!mix) {
        throw new Error("サンプルカメラを作れませんでした。");
      }
      const dest = path.join(os.tmpdir(), "cutline", "media", `${mix.mediaId}.mp4`);
      const durationMs = await probeDurationMs(dest).catch(() => SAMPLE_DURATION_MS);
      const sources: JobMediaSource[] = cameras.map((cam) => ({
        filePath: path.join(os.tmpdir(), "cutline", "media", `${cam.mediaId}.mp4`),
        fileName: `CAM_${cam.id}.mp4`,
        mediaId: cam.mediaId,
        role: roleFromCameraId(cam.id),
      }));
      const job = startJob({
        brief,
        profile,
        targetDurationMs: resolveTargetDurationMs(requestedTargetMs, durationMs),
        fileName: "sample.mp4",
        filePath: dest,
        mediaId: mix.mediaId,
        durationMs,
        cameras,
        sources,
        channelProfile,
        speakerCount,
      });
      return { ok: true, job };
    }

    const dropped = collectDroppedFiles(form);
    if (dropped.length === 0) {
      return {
        ok: false,
        error: "動画ファイルを選ぶか、サンプル素材を使ってください。",
        status: 400,
      };
    }
    if (dropped.some((item) => item.file.size > MAX_UPLOAD_BYTES)) {
      return {
        ok: false,
        error: "ファイルが大きすぎます。80MB 以下にしてください。",
        status: 413,
      };
    }

    const sources: JobMediaSource[] = [];
    const cameras: CameraAngle[] = [];
    for (const item of dropped) {
      const mediaId = randomUUID();
      const bytes = Buffer.from(await item.file.arrayBuffer());
      const saved = await saveMediaFile({
        id: mediaId,
        bytes,
        fileName: item.fileName,
      });
      const role =
        item.role === "unknown" && sources.length === 0 ? "cam_a" : item.role;
      sources.push({
        filePath: saved.filePath,
        fileName: item.fileName,
        mediaId,
        role,
        manualOffsetMs: item.manualOffsetMs,
      });
      const cameraId = cameraIdFromRole(role);
      if (cameraId && !cameras.some((cam) => cam.id === cameraId)) {
        cameras.push({
          id: cameraId,
          mediaId,
          fileName: item.fileName,
          label: labelFromRole(role),
        });
      }
    }
    const mix = sources.find((item) => item.role === "cam_a") ?? sources[0];
    if (!mix?.mediaId) {
      return {
        ok: false,
        error: "動画ファイルを選ぶか、サンプル素材を使ってください。",
        status: 400,
      };
    }
    if (cameras.length === 0) {
      cameras.push({
        id: "A",
        mediaId: mix.mediaId,
        fileName: mix.fileName,
        label: "CAM A",
      });
    }
    const durationMs = await probeDurationMs(mix.filePath).catch(() => 0);
    const job = startJob({
      brief,
      profile,
      targetDurationMs: resolveTargetDurationMs(requestedTargetMs, durationMs),
      fileName: mix.fileName,
      filePath: mix.filePath,
      mediaId: mix.mediaId,
      durationMs,
      cameras,
      sources,
      manualOffsetsMs: parseManualOffsets(form),
      channelProfile,
      speakerCount,
    });
    return { ok: true, job };
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof Error ? error.message : "ジョブの作成に失敗しました。",
      status: 500,
    };
  }
}

function channelProfileFromForm(form: FormData): ChannelProfile | undefined {
  const raw = form.get("channelProfile");
  if (typeof raw !== "string" || !raw.trim()) {
    return undefined;
  }
  try {
    return parseChannelProfile(JSON.parse(raw));
  } catch {
    return undefined;
  }
}
