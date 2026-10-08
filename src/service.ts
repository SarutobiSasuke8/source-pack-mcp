import { randomUUID } from "node:crypto";

import { htmlToMarkdown } from "./content.js";
import { buildCoverageMap } from "./coverage.js";
import { discoverSources } from "./discovery.js";
import { PackNotFoundError, RobotsDisallowedError, UpstreamHttpError } from "./errors.js";
import { extract } from "./extract.js";
import { isPathAllowed, parseRobots } from "./robots.js";

import type { DiskCache } from "./cache.js";
import type { AppConfig } from "./config.js";
import type { DomainFact } from "./coverage.js";
import type { Discovery } from "./discovery.js";
import type { ExtractionOptions } from "./extract.js";
import type { Fetcher } from "./fetcher.js";
import type { RobotsRules } from "./robots.js";
import type { PackStore } from "./store.js";
import type { PackSearchHit, PackSummary, Source, SourcePack } from "./types.js";

// Preserve the original public import path while keeping the shared taxonomy in errors.ts.
export { RobotsDisallowedError } from "./errors.js";

export type SearchDepth = "quick" | "deep";

const DEPTH_LIMITS: Record<SearchDepth, ExtractionOptions> = {
  quick: { maxItems: 8, maxLinks: 10 },
  deep: { maxItems: 20, maxLinks: 25 },
};

/** Core service: discovery → robots-checked fetch → extraction → coverage → store. */
export class PackService {
  private robotsByOrigin = new Map<string, RobotsRules>();

  public constructor(
    private readonly config: AppConfig,
    private readonly cache: DiskCache,
    private readonly fetcher: Fetcher,
    private readonly store: PackStore,
  ) {}

  private async fetchWithCache(
    url: string,
  ): Promise<{ body: string; status: number; contentType?: string; fetchedAt: string }> {
    const cached = await this.cache.get(url);
    if (cached) {
      const out: { body: string; status: number; contentType?: string; fetchedAt: string } = {
        body: cached.body,
        status: cached.status,
        fetchedAt: cached.fetchedAt,
      };
      if (cached.contentType) out.contentType = cached.contentType;
      return out;
    }
    try {
      const record = await this.fetcher.fetch(url);
      await this.cache.set(record);
      const out: { body: string; status: number; contentType?: string; fetchedAt: string } = {
        body: record.body,
        status: record.status,
        fetchedAt: record.fetchedAt,
      };
      if (record.contentType) out.contentType = record.contentType;
      return out;
    } catch (error) {
      const stale = await this.cache.read(url);
      if (stale) {
        const out: { body: string; status: number; contentType?: string; fetchedAt: string } = {
          body: stale.body,
          status: stale.status,
          fetchedAt: stale.fetchedAt,
        };
        if (stale.contentType) out.contentType = stale.contentType;
        return out;
      }
      throw error;
    }
  }

  private async getRobots(origin: string): Promise<RobotsRules> {
    const cached = this.robotsByOrigin.get(origin);
    if (cached) return cached;
    let rules: RobotsRules = { disallow: [], allow: [] };
    try {
      const { body, status } = await this.fetchWithCache(new URL("/robots.txt", origin).toString());
      if (status >= 200 && status < 300) rules = parseRobots(body);
    } catch {
      // Unreachable robots.txt → default to allowed (conservative for availability).
    }
    this.robotsByOrigin.set(origin, rules);
    return rules;
  }

  private async assertAllowed(url: string): Promise<void> {
    const parsed = new URL(url);
    const rules = await this.getRobots(parsed.origin);
    if (!isPathAllowed(rules, parsed.pathname + parsed.search)) throw new RobotsDisallowedError(url);
  }

  /** Fetch a single URL, enforce robots, extract a structured Source. */
  private async buildSource(rawUrl: string, depth: SearchDepth): Promise<Source> {
    const url = new URL(rawUrl).toString();
    await this.assertAllowed(url);
    const { body, status, fetchedAt } = await this.fetchWithCache(url);
    if (status >= 400) throw new UpstreamHttpError(url, status);

    const { title, markdown } = htmlToMarkdown(body, url);
    const extracted = extract(markdown, DEPTH_LIMITS[depth]);
    return {
      url,
      title: title ?? url,
      domain: new URL(url).hostname,
      retrieved_at: fetchedAt,
      facts: extracted.facts,
      quotes: extracted.quotes,
      numbers: extracted.numbers,
      dates: extracted.dates,
      primary_links: extracted.primary_links,
    };
  }

  public async buildPack(query: string, maxSources: number, depth: SearchDepth): Promise<SourcePack> {
    const effectiveMax = Math.min(maxSources, this.config.maxSourcesPerPack);
    const discovery = await discoverSources(query, this.config, this.fetcher, effectiveMax);

    const sources: Source[] = [];
    const failures: string[] = [];
    for (const url of discovery.urls.slice(0, effectiveMax)) {
      try {
        sources.push(await this.buildSource(url, depth));
      } catch (error) {
        failures.push(`${url} — ${error instanceof Error ? error.message : "fetch/extract error"}`);
      }
    }

    const coverageMap = buildCoverageMap(collectDomainFacts(sources));
    const pack: SourcePack = {
      pack_id: randomUUID(),
      query,
      created_at: new Date().toISOString(),
      sources,
      coverage_map: coverageMap,
      limitations: buildLimitations(sources, coverageMap, discovery, failures),
    };
    await this.store.save(pack);
    return pack;
  }

  public async addSource(packId: string, url: string, depth: SearchDepth): Promise<SourcePack> {
    if (!await this.store.get(packId)) throw new PackNotFoundError(packId);

    const source = await this.buildSource(url, depth);
    // Fetch outside the write queue, then merge into the latest saved version.
    const pack = await this.store.update(packId, (current) => {
      current.sources = current.sources.filter((existing) => existing.url !== source.url);
      current.sources.push(source);
      current.coverage_map = buildCoverageMap(collectDomainFacts(current.sources));
      current.limitations = buildLimitations(current.sources, current.coverage_map);
      current.limitations.push(
        "This pack was augmented via pack_add_source; original discovery limitations may be incomplete.",
      );
    });
    if (!pack) throw new PackNotFoundError(packId);
    return pack;
  }

  public async getPack(packId: string): Promise<SourcePack | undefined> {
    return this.store.get(packId);
  }

  public async listPacks(limit: number): Promise<PackSummary[]> {
    return this.store.list(limit);
  }

  public async searchPacks(query: string, limit: number): Promise<PackSearchHit[]> {
    return this.store.search(query, limit);
  }
}

function collectDomainFacts(sources: Source[]): DomainFact[] {
  const facts: DomainFact[] = [];
  for (const source of sources) {
    for (const fact of source.facts) facts.push({ domain: source.domain, fact: fact.fact });
  }
  return facts;
}

function buildLimitations(
  sources: Source[],
  coverage: SourcePack["coverage_map"],
  discovery?: Discovery,
  failures?: string[],
): string[] {
  const limitations: string[] = [];

  if (discovery) {
    limitations.push(
      `Source discovery used ${discovery.method}${discovery.shallow ? " and was shallow (fewer results than requested)" : ""}.`,
    );
    if (discovery.note) limitations.push(discovery.note);
  }

  if (failures && failures.length > 0) {
    limitations.push(`${failures.length} source(s) could not be fetched or extracted:`);
    for (const failure of failures) limitations.push(`  - ${failure}`);
  }

  if (sources.length === 0) {
    limitations.push("No sources were successfully fetched; this pack contains no extracted content.");
  } else if (sources.length === 1) {
    limitations.push("Only one source was fetched; no cross-source corroboration was possible.");
  }

  const isolated = coverage.filter((entry) => entry.status === "isolated").length;
  if (isolated > 0) {
    limitations.push(`${isolated} claim(s) are supported by a single source only (status: isolated).`);
  }
  const contested = coverage.filter((entry) => entry.status === "contested").length;
  if (contested > 0) {
    limitations.push(`${contested} claim(s) show differing numbers across sources (status: contested).`);
  }

  limitations.push(
    "Facts, quotes, numbers and dates are extracted by conservative text heuristics, not verified for truth; confidence labels reflect extraction certainty only.",
  );
  return limitations;
}
