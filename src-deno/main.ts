/// <reference lib="deno.ns" />

/**
 * CUTLINE Deno Desktop シェル。
 * 公式: https://docs.deno.com/runtime/desktop/
 *
 * エントリは `Deno.serve()`。desktop 実行時は `DENO_SERVE_ADDRESS` の空きポートへバインドし、
 * ポート 43127 は奪わない。webview は起動後に TanStack Start の Editor
 * （http://127.0.0.1:43127）へ遷移する。
 */

const EDITOR_URL = "http://127.0.0.1:43127";
const WIN_W = 1280;
const WIN_H = 800;
const TITLE = "CUTLINE";

type BrowserWindowOptions = {
  title?: string;
  width?: number;
  height?: number;
};

type BrowserWindowLike = {
  setSize?: (width: number, height: number) => void;
  setTitle?: (title: string) => void;
  navigate?: (url: string) => void;
  addEventListener?: (type: string, listener: () => void) => void;
};

type DesktopDeno = typeof Deno & {
  BrowserWindow?: new (options: BrowserWindowOptions) => BrowserWindowLike;
};

function waitingPage(): Response {
  const html = `<!doctype html>
<html lang="ja">
  <head>
    <meta charset="utf-8" />
    <title>${TITLE}</title>
    <style>
      :root { color-scheme: dark; }
      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        background: #0c0d10;
        color: #e8e6e1;
        font-family: ui-sans-serif, system-ui, sans-serif;
      }
      main { max-width: 28rem; padding: 2rem; text-align: center; }
      a { color: #c9a227; }
      code { font-size: 0.9em; }
    </style>
  </head>
  <body>
    <main>
      <p>CUTLINE Editor を開いています…</p>
      <p><a href="${EDITOR_URL}">${EDITOR_URL}</a></p>
      <p>先に TanStack Start の Editor を 43127 で起動してください。</p>
    </main>
    <script>
      const url = ${JSON.stringify(EDITOR_URL)};
      async function wait() {
        for (;;) {
          try {
            await fetch(url, { mode: "no-cors", cache: "no-store" });
            location.replace(url);
            return;
          } catch {
            await new Promise((r) => setTimeout(r, 800));
          }
        }
      }
      wait();
    </script>
  </body>
</html>`;
  return new Response(html, {
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

async function editorReady(timeoutMs = 1200): Promise<boolean> {
  try {
    const response = await fetch(EDITOR_URL, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    return response.status < 500;
  } catch {
    return false;
  }
}

function openEditorWindow(): void {
  const BrowserWindow = (Deno as DesktopDeno).BrowserWindow;
  if (!BrowserWindow) {
    return;
  }

  const win = new BrowserWindow({
    title: TITLE,
    width: WIN_W,
    height: WIN_H,
  });
  win.setSize?.(WIN_W, WIN_H);
  win.setTitle?.(TITLE);

  let timer: number | undefined;
  const stop = () => {
    if (timer !== undefined) {
      clearInterval(timer);
      timer = undefined;
    }
  };

  const tryNavigate = async () => {
    if (await editorReady()) {
      win.navigate?.(EDITOR_URL);
      stop();
      return true;
    }
    return false;
  };

  win.addEventListener?.("close", stop);

  void (async () => {
    if (await tryNavigate()) {
      return;
    }
    timer = setInterval(() => {
      void tryNavigate();
    }, 800);
  })();
}

openEditorWindow();

// desktop 実行時は DENO_SERVE_ADDRESS が優先され、渡した port は無視される。
// それ以外（deno run）では port: 0 で空きポートを使い、43127 を奪わない。
Deno.serve({ hostname: "127.0.0.1", port: 0 }, () => waitingPage());
