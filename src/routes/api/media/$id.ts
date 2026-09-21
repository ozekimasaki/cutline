import { createFileRoute } from "@tanstack/react-router";
import { getMedia } from "@/lib/store";
import { streamFileResponse } from "@/server/stream-file";

export const Route = createFileRoute("/api/media/$id")({
  server: {
    handlers: {
      GET: async ({ params }) => {
        const media = getMedia(params.id);
        if (!media) {
          return Response.json({ error: "素材が見つかりません。" }, { status: 404 });
        }
        return streamFileResponse(media.filePath, {
          "Content-Type": media.mime,
          "Cache-Control": "no-store",
        });
      },
    },
  },
});
