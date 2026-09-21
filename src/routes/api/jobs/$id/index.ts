import { createFileRoute } from "@tanstack/react-router";
import { getJob } from "@/lib/store";

export const Route = createFileRoute("/api/jobs/$id/")({
  server: {
    handlers: {
      GET: async ({ params }) => {
        const job = getJob(params.id);
        if (!job) {
          return Response.json({ error: "ジョブが見つかりません。" }, { status: 404 });
        }
        return Response.json(job);
      },
    },
  },
});
