import { createReadStream } from "node:fs";
import { mkdirSync } from "node:fs";
import { pipeline } from "node:stream/promises";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { allowsJevCache } from "./jev";
import type { Job } from "./types";

export type CacheLookup = {
  mediaHash: string;
  timeRange: string;
  modelVersion: string;
  promptVersion: string;
  kind: string;
};

const PROMPT_VERSION = "cutline-2026-09";

let db: DatabaseSync | undefined;
let dbPath = "";

export function promptVersion(): string {
  return PROMPT_VERSION;
}

export function persistPath(): string {
  return (
    process.env.CUTLINE_DB_PATH?.trim() ||
    path.join(os.tmpdir(), "cutline", "cutline.db")
  );
}

export function openPersist(filePath = persistPath()): DatabaseSync {
  if (db && dbPath === filePath) {
    return db;
  }
  if (filePath !== ":memory:") {
    mkdirSync(path.dirname(filePath), { recursive: true });
  }
  db = new DatabaseSync(filePath);
  dbPath = filePath;
  db.exec(`
    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS media (
      id TEXT PRIMARY KEY,
      file_path TEXT NOT NULL,
      mime TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS cache (
      cache_key TEXT PRIMARY KEY,
      media_hash TEXT NOT NULL,
      time_range TEXT NOT NULL,
      model_version TEXT NOT NULL,
      prompt_version TEXT NOT NULL,
      kind TEXT NOT NULL,
      json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS preference_overrides (
      pref_key TEXT PRIMARY KEY,
      unit_text TEXT NOT NULL,
      speaker TEXT NOT NULL,
      role_key TEXT NOT NULL,
      ai_verdict TEXT NOT NULL,
      human_verdict TEXT NOT NULL,
      weight INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS channel_profiles (
      id TEXT PRIMARY KEY,
      json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS preference_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  return db;
}

export function resetPersist(): void {
  db?.close();
  db = undefined;
  dbPath = "";
}

export function cacheKey(input: CacheLookup): string {
  return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

export function cacheGet<T>(input: CacheLookup): T | undefined {
  const row = openPersist()
    .prepare(
      "SELECT json FROM cache WHERE cache_key = ?",
    )
    .get(cacheKey(input)) as { json: string } | undefined;
  if (!row) {
    return undefined;
  }
  const parsed = JSON.parse(row.json) as T;
  if (!allowsJevCache(input.modelVersion, parsed)) {
    return undefined;
  }
  return parsed;
}

export function cacheSet(input: CacheLookup, value: unknown): void {
  if (!allowsJevCache(input.modelVersion, value)) {
    return;
  }
  openPersist()
    .prepare(
      `INSERT OR REPLACE INTO cache
        (cache_key, media_hash, time_range, model_version, prompt_version, kind, json)
        VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      cacheKey(input),
      input.mediaHash,
      input.timeRange,
      input.modelVersion,
      input.promptVersion,
      input.kind,
      JSON.stringify(value),
    );
}

export async function mediaHashOf(filePath?: string): Promise<string> {
  if (!filePath) {
    return "no-media";
  }
  try {
    const hash = createHash("sha256");
    await pipeline(createReadStream(filePath), hash);
    return hash.digest("hex");
  } catch {
    return createHash("sha256").update(filePath).digest("hex");
  }
}

export function saveJobRow(job: Job): void {
  openPersist()
    .prepare(
      "INSERT OR REPLACE INTO jobs (id, json, updated_at) VALUES (?, ?, ?)",
    )
    .run(job.id, JSON.stringify(job), new Date().toISOString());
}

export function loadJobRow(id: string): Job | undefined {
  const row = openPersist()
    .prepare("SELECT json FROM jobs WHERE id = ?")
    .get(id) as { json: string } | undefined;
  if (!row) {
    return undefined;
  }
  return JSON.parse(row.json) as Job;
}

export function saveMediaRow(
  id: string,
  filePath: string,
  mime: string,
): void {
  openPersist()
    .prepare("INSERT OR REPLACE INTO media (id, file_path, mime) VALUES (?, ?, ?)")
    .run(id, filePath, mime);
}

export function loadMediaRow(
  id: string,
): { filePath: string; mime: string } | undefined {
  const row = openPersist()
    .prepare("SELECT file_path AS filePath, mime FROM media WHERE id = ?")
    .get(id) as { filePath: string; mime: string } | undefined;
  return row;
}
