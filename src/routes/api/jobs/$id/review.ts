import { createFileRoute } from "@tanstack/react-router";
import {
  attachHumanCorrectionTime,
  computeJobMetricsFromJob,
} from "@/lib/metrics";
import {
  applyManualVerdict,
  parseVerdict,
  reviewBlockMessage,
} from "@/lib/pipeline";
import { getJob, updateJob } from "@/lib/store";
import type { Job } from "@/lib/types";

export const Route = createFileRoute("/api/jobs/$id/review")({
  server: {
    handlers: {
      PATCH: async ({ request, params }) => {
        const job = getJob(params.id);
        if (!job) {
          return Response.json({ error: "ジョブが見つかりません。" }, { status: 404 });
        }
        const blocked = reviewBlockMessage(job.phase);
        if (blocked) {
          return Response.json({ error: blocked }, { status: 409 });
        }

        const body = (await request.json()) as {
          clipId?: string;
          verdict?: string;
          reviewSessionMs?: number;
        };
        const reviewSessionMs = parseReviewSessionMs(body.reviewSessionMs);
        const verdict = parseVerdict(body.verdict ?? "");
        const previousMs = job.metrics?.humanCorrectionTime?.aiReviewMs ?? 0;
        const aiReviewMs = reviewSessionMs ?? previousMs;

        if (body.clipId && verdict) {
          const next = applyManualVerdict(params.id, body.clipId, verdict);
          if (!next) {
            return Response.json(
              { error: "クリップを更新できませんでした。" },
              { status: 404 },
            );
          }
          return Response.json(persistHct(params.id, aiReviewMs) ?? next);
        }

        if (reviewSessionMs == null) {
          return Response.json(
            { error: "clipId と verdict（keep / cut / shorten）が必要です。" },
            { status: 400 },
          );
        }

        return Response.json(persistHct(params.id, reviewSessionMs) ?? job);
      },
    },
  },
});

function persistHct(jobId: string, aiReviewMs: number): Job | undefined {
  const job = getJob(jobId);
  if (!job) {
    return undefined;
  }
  const metrics = job.metrics ?? computeJobMetricsFromJob(job);
  return updateJob(jobId, {
    metrics: attachHumanCorrectionTime(metrics, {
      sourceDurationMs: job.sourceDurationMs,
      aiReviewMs,
    }),
  });
}

function parseReviewSessionMs(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return Math.round(value);
  }
  return undefined;
}
