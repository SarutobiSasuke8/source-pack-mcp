import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type { PackSearchHit, PackSummary, SourcePack } from "./types.js";

const PACK_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

/** On-disk store of built packs as one JSON file per pack, named by pack_id. */
export class PackStore {
  public constructor(private readonly packsDir: string) {}

  private filePath(packId: string): string {
    if (!PACK_ID_RE.test(packId)) throw new Error(`Invalid pack_id: '${packId}'.`);
    return path.join(this.packsDir, `${packId}.json`);
  }

  public async save(pack: SourcePack): Promise<void> {
    await mkdir(this.packsDir, { recursive: true });
    await writeFile(this.filePath(pack.pack_id), JSON.stringify(pack, null, 2), "utf8");
  }

  public async get(packId: string): Promise<SourcePack | undefined> {
    const file = this.filePath(packId);
    if (!existsSync(file)) return undefined;
    try {
      return JSON.parse(await readFile(file, "utf8")) as SourcePack;
    } catch {
      return undefined;
    }
  }

  private async readAll(): Promise<SourcePack[]> {
    if (!existsSync(this.packsDir)) return [];
    const files = (await readdir(this.packsDir)).filter((name) => name.endsWith(".json"));
    const packs: SourcePack[] = [];
    for (const name of files) {
      try {
        packs.push(JSON.parse(await readFile(path.join(this.packsDir, name), "utf8")) as SourcePack);
      } catch {
        // Skip unreadable/corrupt packs rather than failing the whole listing.
      }
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
