import "server-only";

import { access, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const SHORT_TALK_MEDIA = ["dialogue.wav", "dialogue.mp4"] as const;

export function shortTalkSampleDir(): string {
  return path.join(process.cwd(), "samples", "short-talk");
}

/** Write dialogue.wav and dialogue.mp4 from base64 fragments when they are absent. */
export async function ensureShortTalkMedia(): Promise<void> {
  const dir = shortTalkSampleDir();
  await Promise.all(SHORT_TALK_MEDIA.map((name) => ensureMediaFile(dir, name)));
}

async function ensureMediaFile(
  dir: string,
  name: (typeof SHORT_TALK_MEDIA)[number],
): Promise<void> {
  const dest = path.join(dir, name);
  try {
    await access(dest);
    return;
  } catch {
    // Absent. Assemble samples/short-talk/<name>.b64.NN once, at job start.
  }
  const prefix = `${name}.b64.`;
  let names: string[] = [];
  try {
    names = (await readdir(dir))
      .filter((file) => {
        const suffix = file.slice(prefix.length);
        return file.startsWith(prefix) && /^[0-9]+$/.test(suffix);
      })
      .sort();
  } catch {
    return;
  }
  if (names.length === 0) {
    return;
  }
  const parts = await Promise.all(
    names.map((file) => readFile(path.join(dir, file), "utf8")),
  );
  const encoded = parts.join("").replace(/\s+/g, "");
  await writeFile(dest, Buffer.from(encoded, "base64"));
}
