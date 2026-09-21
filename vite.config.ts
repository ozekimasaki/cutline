import path from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";
import { nitro } from "nitro/vite";

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, root, "");
  for (const [key, value] of Object.entries(env)) {
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }

  return {
    server: {
      host: "127.0.0.1",
      port: 43127,
      strictPort: true,
    },
    preview: {
      host: "127.0.0.1",
      port: 43127,
      strictPort: true,
    },
    resolve: {
      alias: {
        "@": path.resolve(root, "src"),
        "server-only": path.resolve(root, "node_modules/server-only/empty.js"),
      },
    },
    plugins: [
      tailwindcss(),
      tanstackStart({ srcDirectory: "src" }),
      viteReact(),
      nitro(),
    ],
  };
});
