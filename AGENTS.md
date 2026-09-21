# CutLine

Web UI は TanStack Start（Vite）です。開発サーバーは `http://127.0.0.1:43127`。
デスクトップは Deno Desktop（`deno task desktop`）のみ。Next.js と Tauri は使わない。

UI は Tailwind v4 + shadcn/ui。変更後は `npm run lint` を実行し、`@shadcn/lint` のエラーを直す。
`npm test`（`tsx --test src/lib/*.test.ts`）は緑のままにする。

`src/lib/engine.ts` / `src/lib/boundary.ts` / `src/lib/preference.ts` / `src/lib/ingest.ts` / `src/lib/ffmpeg.ts` / `src/lib/aaf.ts` / `engine/` / `engine-rs/` は他ワーカーの領域なので不用意に書き換えない。
