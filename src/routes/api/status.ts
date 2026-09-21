import { createFileRoute } from "@tanstack/react-router";
import { providerStatus } from "@/lib/env";
import { getChannelProfile } from "@/lib/preference";

export const Route = createFileRoute("/api/status")({
  server: {
    handlers: {
      GET: async () =>
        Response.json({
          ...providerStatus(),
          channelProfile: getChannelProfile(),
        }),
    },
  },
});
