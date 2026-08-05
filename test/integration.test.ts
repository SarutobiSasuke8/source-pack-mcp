import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { loadConfig } from "../src/config.js";
import { createRuntime } from "../src/runtime.js";
import { sourcePackSchema } from "../src/schema.js";

/**
 * Live integration test against real, stable, non-controversial public pages.
 *
 * pack_build exercises live source discovery (best-effort — network discovery
 * can be shallow or blocked in CI, which the pack records in `limitations`).
 * Two known, different-domain sources are then added deterministically so the
 * full pipeline — fetch → robots → extract → coverage → store → search — is
 * always exercised end to end.
 */
const WIKIPEDIA = "https://en.wikipedia.org/wiki/Python_(programming_language)";
const PYTHON_ORG = "https://www.python.org/doc/essays/blurb/";

void test("live integration: build, augment, get, search a real pack", { timeout: 120_000 }, async () => {
  const cacheDir = await mkdtemp(path.join(os.tmpdir(), "spm-int-cache-"));
  const packsDir = await mkdtemp(path.join(os.tmpdir(), "spm-int-packs-"));
  try {
    const config = loadConfig({
      CACHE_DIR: cacheDir,
      PACKS_DIR: packsDir,
      FETCH_MIN_INTERVAL_MS: "400",
      MAX_SOURCES_PER_PACK: "5",
    } as NodeJS.ProcessEnv);
    const { service } = createRuntime(config);

    // 1. Build via live discovery. Result depends on network reachability.
    const built = await service.buildPack("Python programming language history", 3, "quick");
    console.log("BUILD discovery limitations:", JSON.stringify(built.limitations, null, 2));
    console.log("BUILD discovered sources:", built.sources.map((s) => s.domain));

    // 2. Deterministically augment with two known, different-domain sources.
    await service.addSource(built.pack_id, WIKIPEDIA, "quick");
    const pack = await service.addSource(built.pack_id, PYTHON_ORG, "quick");

    // Structure is valid.
    sourcePackSchema.parse(pack);

    const wiki = pack.sources.find((s) => s.url === WIKIPEDIA);
    const py = pack.sources.find((s) => s.url === PYTHON_ORG);
    assert.ok(wiki, "wikipedia source present");
    assert.ok(py, "python.org source present");
    assert.equal(wiki?.domain, "en.wikipedia.org");
    assert.equal(py?.domain, "www.python.org");

    const totalFacts = pack.sources.reduce((n, s) => n + s.facts.length, 0);
    const totalQuotes = pack.sources.reduce((n, s) => n + s.quotes.length, 0);
    const totalNumbers = pack.sources.reduce((n, s) => n + s.numbers.length, 0);
    console.log("TOTALS:", { totalFacts, totalQuotes, totalNumbers, coverage: pack.coverage_map.length });
    console.log("WIKI SAMPLE FACTS:", JSON.stringify(wiki?.facts.slice(0, 3), null, 2));

    assert.ok((wiki?.facts.length ?? 0) > 0, "wikipedia source yields facts");
    assert.ok(totalFacts > 0, "pack has facts");
    assert.ok(totalQuotes > 0, "pack has at least one quote");
    assert.ok(pack.coverage_map.length >= 1, "coverage map has entries");
    assert.ok(pack.limitations.length >= 1, "limitations are recorded");

    // 3. pack_get returns the stored pack.
    const got = await service.getPack(pack.pack_id);
    assert.ok(got);
    assert.equal(got?.pack_id, pack.pack_id);
    assert.equal(got?.sources.length, pack.sources.length);

    // 4. pack_search finds it by keyword.
    const hits = await service.searchPacks("Python", 10);
    assert.ok(hits.some((h) => h.pack_id === pack.pack_id), "search finds the pack");

    // 5. pack_list includes it.
    const list = await service.listPacks(10);
    assert.ok(list.some((p) => p.pack_id === pack.pack_id), "list includes the pack");
  } finally {
    await rm(cacheDir, { recursive: true, force: true });
    await rm(packsDir, { recursive: true, force: true });
  }
});
