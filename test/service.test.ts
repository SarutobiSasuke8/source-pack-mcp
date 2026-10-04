import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { DiskCache } from "../src/cache.js";
import { loadConfig } from "../src/config.js";
import { Fetcher } from "../src/fetcher.js";
import { PackService } from "../src/service.js";
import { PackStore } from "../src/store.js";

const PACK_ID = "aaaaaaaa-1111-4111-8111-111111111111";

void test("concurrent source additions preserve both sources and rebuilt coverage", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "spm-service-"));
  try {
    const config = loadConfig({ CACHE_DIR: path.join(dir, "cache"), PACKS_DIR: path.join(dir, "packs") });
    const store = new PackStore(config.packsDir);
    await store.save({ pack_id: PACK_ID, query: "Solar", created_at: "2026-08-05T00:00:00.000Z", sources: [], coverage_map: [], limitations: [] });
    const fetcher = new Fetcher({ timeoutMs: 5_000, minIntervalMs: 0, userAgent: "test", maxBodyBytes: 10_000 }, {
      lookup: () => Promise.resolve(["93.184.216.34"]),
      fetchFn: (input) => Promise.resolve(new Response(String(input).endsWith("/robots.txt")
        ? "User-agent: *\nAllow: /\n"
        : "<html><head><title>Solar facts</title></head><body><article><p>Solar panels were installed in 2024 at 12 sites across the country.</p></article></body></html>")),
    });
    const service = new PackService(config, new DiskCache(config.cacheDir, 3600), fetcher, store);
    const urls = ["https://example.com/solar", "https://example.org/solar"];
    await Promise.all(urls.map((url) => service.addSource(PACK_ID, url, "quick")));
    const saved = await service.getPack(PACK_ID);
    assert.deepEqual(saved?.sources.map((source) => source.url).sort(), urls);
    assert.ok(saved?.coverage_map.some((entry) => entry.mentioned_by.length === 2));
    await service.addSource(PACK_ID, urls[0]!, "quick");
    assert.equal((await service.getPack(PACK_ID))?.sources.length, 2, "repeated URL replaces its own source only");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
