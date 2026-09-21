import { createFileRoute } from "@tanstack/react-router";
import { createJobFromForm } from "@/server/create-job";

export const Route = createFileRoute("/api/jobs/")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const form = await request.formData();
        const result = await createJobFromForm(form);
        if (!result.ok) {
          return Response.json({ error: result.error }, { status: result.status });
        }
        return Response.json(result.job);
      },
    },
  },
});
