import { createFileRoute } from "@tanstack/react-router";
import { getJob } from "@/lib/store";
import { streamFileResponse } from "@/server/stream-file";

export const Route = createFileRoute("/api/jobs/$id/file")({
  server: {
    handlers: {
      GET: async ({ params }) => {
        const job = getJob(params.id);
        if (!job?.renderPath) {
          return Response.json(
            { error: "完成映像がまだありません。" },
            { status: 404 },
          );
        }
        return streamFileResponse(job.renderPath, {
          "Content-Type": "video/mp4",
          "Content-Disposition": `attachment; filename="edited.mp4"`,
        });
      },
    },
  },
});
