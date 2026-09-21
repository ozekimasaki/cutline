import { createFileRoute } from "@tanstack/react-router";
import { renderJob } from "@/lib/render-job";
import { exportDownloadResponse, parseRenderOptions } from "@/server/export-download";

export const Route = createFileRoute("/api/jobs/$id/export")({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        return exportDownloadResponse(params.id, request.url);
      },
      POST: async ({ request, params }) => {
        const options = await parseRenderOptions(request);
        const result = await renderJob({
          jobId: params.id,
          loudness: options.loudness,
          preset: options.preset,
        });
        if (!result.ok) {
          return Response.json({ error: result.error }, { status: result.status });
        }
        return Response.json({
          ok: true,
          url: `/api/jobs/${params.id}/file`,
          validation: result.validation,
          watchQa: result.watchQa,
          encoder: result.encoder,
          preset: result.preset,
          loudness: result.loudness,
          worker: result.worker,
        });
      },
    },
  },
});
