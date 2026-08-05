import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import type { FetchRecord } from "./types.js";

/** Deterministic on-disk key for a URL. */
export function cacheKey(url: string): string {
  return createHash("sha256").update(url).digest("hex");
}

/**
 * Simple TTL disk cache for fetched pages.
 *
 * Records are stored as JSON files named by the SHA-256 of their URL. Reads
 * prefer a fresh cache entry; expired entries are treated as a miss (but left
 * on disk so a caller can still fall back to them if a live fetch fails).
 */
export class DiskCache {
  public constructor(
    private readonly cacheDir: string,
    private readonly ttlSeconds: number,
  ) {}

  private filePath(url: string): string {
    return path.join(this.cacheDir, `${cacheKey(url)}.json`);
  }

  private isFresh(record: FetchRecord, now: number): boolean {
    if (this.ttlSeconds === 0) return false;
    const age = (now - new Date(record.fetchedAt).getTime()) / 1_000;
    return age >= 0 && age < this.ttlSeconds;
  }

  /** Read a record from disk regardless of freshness, or undefined if absent. */
  public async read(url: string): Promise<FetchRecord | undefined> {
    const file = this.filePath(url);
    if (!existsSync(file)) return undefined;
    try {
      return JSON.parse(await readFile(file, "utf8")) as FetchRecord;
    } catch {
      return undefined;
    }
  }

  /** Read a record only if it exists and is within the TTL. */
  public async get(url: string, now: number = Date.now()): Promise<FetchRecord | undefined> {
    const record = await this.read(url);
    if (record && this.isFresh(record, now)) return record;
    return undefined;
  }

  public async set(record: FetchRecord): Promise<void> {
    await mkdir(this.cacheDir, { recursive: true });
    await writeFile(this.filePath(record.url), JSON.stringify(record), "utf8");
  }

  public async stats(): Promise<{ entries: number; bytes: number }> {
    if (!existsSync(this.cacheDir)) return { entries: 0, bytes: 0 };
    const files = (await readdir(this.cacheDir)).filter((name) => name.endsWith(".json"));
    let bytes = 0;
    for (const name of files) bytes += (await stat(path.join(this.cacheDir, name))).size;
    return { entries: files.length, bytes };
  }
}
