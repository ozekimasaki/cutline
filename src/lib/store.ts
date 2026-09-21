import "server-only";

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { loadJobRow, loadMediaRow, saveJobRow, saveMediaRow } from "./persist";

const MEDIA_DIR = path.join(os.tmpdir(), "cutline", "media");

type Store = {
  jobs: Map<string, Job>;
  media: Map<string, { filePath: string; mime: string }>;
};

function store(): Store {
  const globalStore = globalThis as typeof globalThis & { __cutline?: Store };
  if (!globalStore.__cutline) {
    globalStore.__cutline = {
      jobs: new Map(),
      media: new Map(),
    };
  }
  return globalStore.__cutline;
}

export function createJob(job: Job): Job {
  store().jobs.set(job.id, job);
  saveJobRow(job);
  return job;
}

export function getJob(id: string): Job | undefined {
  const memory = store().jobs.get(id);
  if (memory) {
    return memory;
  }
  const persisted = loadJobRow(id);
  if (persisted) {
    store().jobs.set(id, persisted);
  }
  return persisted;
}

export function updateJob(id: string, patch: Partial<Job>): Job | undefined {
  const current = getJob(id);
  if (!current) {
    return undefined;
  }
  const next = { ...current, ...patch };
  store().jobs.set(id, next);
  saveJobRow(next);
  return next;
}

export async function saveMediaFile(input: {
  id: string;
  bytes: Buffer;
  fileName: string;
}): Promise<{ filePath: string; mime: string }> {
  await mkdir(MEDIA_DIR, { recursive: true });
  const ext = path.extname(input.fileName) || ".mp4";
  const filePath = path.join(MEDIA_DIR, `${input.id}${ext}`);
  await writeFile(filePath, input.bytes);
  const mime = mimeOf(ext);
  store().media.set(input.id, { filePath, mime });
  saveMediaRow(input.id, filePath, mime);
  return { filePath, mime };
}

export function registerMediaPath(
  id: string,
  filePath: string,
  mime = "video/mp4",
): void {
  store().media.set(id, { filePath, mime });
  saveMediaRow(id, filePath, mime);
}

export function getMedia(id: string): { filePath: string; mime: string } | undefined {
  const memory = store().media.get(id);
  if (memory) {
    return memory;
  }
  const persisted = loadMediaRow(id);
  if (persisted) {
    store().media.set(id, persisted);
  }
  return persisted;
}

function mimeOf(ext: string): string {
  switch (ext.toLowerCase()) {
    case ".webm":
      return "video/webm";
    case ".mov":
      return "video/quicktime";
    case ".mp4":
      return "video/mp4";
    default:
      return "application/octet-stream";
  }
}
