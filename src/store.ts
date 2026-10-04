import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { sourcePackSchema } from "./schema.js";
import type { PackSearchHit, PackSummary, SourcePack } from "./types.js";

const PACK_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

/** On-disk store of built packs as one JSON file per pack, named by pack_id. */
export class PackStore {
  private readonly pendingWrites = new Map<string, Promise<void>>();

  public constructor(private readonly packsDir: string) {}

  private filePath(packId: string): string {
    if (!PACK_ID_RE.test(packId)) throw new Error(`Invalid pack_id: '${packId}'.`);
    return path.join(this.packsDir, `${packId}.json`);
  }

  public async save(pack: SourcePack): Promise<void> {
    const validated = sourcePackSchema.parse(pack);
    this.filePath(validated.pack_id);
    await this.serialise(validated.pack_id, () => this.write(validated));
  }

  /** Read, change and persist one pack without losing another request's update. */
  public async update(packId: string, change: (pack: SourcePack) => void): Promise<SourcePack | undefined> {
    this.filePath(packId);
    return this.serialise(packId, async () => {
      const pack = await this.get(packId);
      if (!pack) return undefined;
      change(pack);
      if (pack.pack_id !== packId) throw new Error("A pack update cannot change its pack_id.");
      const validated = sourcePackSchema.parse(pack);
      await this.write(validated);
      return validated;
    });
  }

  private async serialise<T>(packId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.pendingWrites.get(packId) ?? Promise.resolve();
    const current = previous.then(operation);
    // A failed operation must not block later updates or create an unhandled rejection.
    const settled = current.then(() => undefined, () => undefined);
    this.pendingWrites.set(packId, settled);
    try {
      return await current;
    } finally {
      if (this.pendingWrites.get(packId) === settled) this.pendingWrites.delete(packId);
    }
  }

  private async write(pack: SourcePack): Promise<void> {
    await mkdir(this.packsDir, { recursive: true });
    const target = this.filePath(pack.pack_id);
    const temporary = `${target}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(pack, null, 2), { encoding: "utf8", flag: "wx" });
      // Windows can briefly refuse replacement while a reader has the old
      // file open. Retry without unlinking the existing, complete version.
      for (let attempt = 0; ; attempt++) {
        try {
          await rename(temporary, target);
          break;
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (process.platform !== "win32" || !["EPERM", "EACCES", "EBUSY"].includes(code ?? "") || attempt >= 5) throw error;
          await delay(10 * 2 ** attempt);
        }
      }
    } finally {
      await rm(temporary, { force: true });
    }
  }

  public async get(packId: string): Promise<SourcePack | undefined> {
    const file = this.filePath(packId);
    try {
      const result = sourcePackSchema.safeParse(JSON.parse(await readFile(file, "utf8")));
      return result.success && result.data.pack_id === packId ? result.data : undefined;
    } catch {
      return undefined;
    }
  }

  private async readAll(): Promise<SourcePack[]> {
    let files: string[];
    try {
      files = await readdir(this.packsDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const packs: SourcePack[] = [];
    for (const name of files) {
      if (!name.endsWith(".json")) continue;
      const packId = name.slice(0, -5);
      if (!PACK_ID_RE.test(packId)) continue;
      const pack = await this.get(packId);
      if (pack) packs.push(pack);
    }
    return packs;
  }

  public async list(limit: number): Promise<PackSummary[]> {
    const packs = await this.readAll();
    packs.sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0));
    return packs.slice(0, limit).map(summarize);
  }

  public async search(query: string, limit: number): Promise<PackSearchHit[]> {
    const needle = query.trim().toLowerCase();
    if (!needle) return [];
    const packs = await this.readAll();
    const hits: PackSearchHit[] = [];

    for (const pack of packs) {
      const snippets = matchSnippets(pack, needle);
      if (snippets.length === 0) continue;
      hits.push({ ...summarize(pack), snippets: snippets.slice(0, 5) });
    }

    return hits.slice(0, limit);
  }
}

function summarize(pack: SourcePack): PackSummary {
  return {
    pack_id: pack.pack_id,
    query: pack.query,
    created_at: pack.created_at,
    source_count: pack.sources.length,
  };
}

/** Collect distinct text fragments in a pack that contain the search term. */
function matchSnippets(pack: SourcePack, needle: string): string[] {
  const fragments: string[] = [];
  const add = (text: string): void => {
    if (text && text.toLowerCase().includes(needle)) fragments.push(text);
  };

  add(pack.query);
  for (const source of pack.sources) {
    add(source.title);
    for (const f of source.facts) add(f.fact);
    for (const q of source.quotes) add(q.text);
    for (const n of source.numbers) add(n.context);
    for (const d of source.dates) add(d.event);
  }
  for (const entry of pack.coverage_map) add(entry.claim);

  const seen = new Set<string>();
  const snippets: string[] = [];
  for (const fragment of fragments) {
    const key = fragment.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    snippets.push(fragment.length > 200 ? `${fragment.slice(0, 199)}…` : fragment);
  }
  return snippets;
}
