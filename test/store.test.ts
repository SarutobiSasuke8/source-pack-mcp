import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { PackStore } from "../src/store.js";

import type { SourcePack } from "../src/types.js";

function pack(id: string, query: string, createdAt: string, fact: string): SourcePack {
  return {
    pack_id: id,
    query,
    created_at: createdAt,
    sources: [
      {
        url: "https://example.com/",
        title: "Example",
        domain: "example.com",
        retrieved_at: createdAt,
        facts: [{ fact, confidence: "medium" }],
        quotes: [],
        numbers: [],
        dates: [],
        primary_links: [],
      },
    ],
    coverage_map: [{ claim: fact, mentioned_by: ["example.com"], contested_by: [], status: "isolated" }],
    limitations: [],
  };
}

const A = "aaaaaaaa-1111-4111-8111-111111111111";
const B = "bbbbbbbb-2222-4222-8222-222222222222";

void test("save + get round-trips a pack", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "spm-store-"));
  try {
    const store = new PackStore(dir);
    const p = pack(A, "solar power basics", "2026-08-05T00:00:00.000Z", "Solar panels convert sunlight to electricity.");
    await store.save(p);
    const loaded = await store.get(A);
    assert.deepEqual(loaded, p);
    assert.equal(await store.get(B), undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("list returns summaries newest first", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "spm-store-"));
  try {
    const store = new PackStore(dir);
    await store.save(pack(A, "older topic", "2026-08-01T00:00:00.000Z", "An older fact about things."));
    await store.save(pack(B, "newer topic", "2026-08-05T00:00:00.000Z", "A newer fact about things."));
    const list = await store.list(10);
    assert.equal(list.length, 2);
    assert.equal(list[0]?.pack_id, B, "newest first");
    assert.equal(list[0]?.source_count, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("search matches pack text and returns snippets", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "spm-store-"));
  try {
    const store = new PackStore(dir);
    await store.save(pack(A, "solar", "2026-08-05T00:00:00.000Z", "Solar panels convert sunlight to electricity."));
    await store.save(pack(B, "wind", "2026-08-05T00:00:00.000Z", "Wind turbines convert airflow to electricity."));
    const hits = await store.search("sunlight", 10);
    assert.equal(hits.length, 1);
    assert.equal(hits[0]?.pack_id, A);
    assert.ok(hits[0]?.snippets.some((s) => /sunlight/u.test(s)));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("an invalid pack_id is rejected by the store", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "spm-store-"));
  try {
    const store = new PackStore(dir);
    await assert.rejects(() => store.get("../etc/passwd"), /Invalid pack_id/u);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("malformed and misidentified packs cannot break listing or search", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "spm-store-"));
  try {
    const store = new PackStore(dir);
    const valid = pack(A, "solar", "2026-08-05T00:00:00.000Z", "Solar panels convert sunlight to electricity.");
    await store.save(valid);
    for (const invalid of ["null", "{}", "{", JSON.stringify({ ...valid, sources: null }), JSON.stringify(valid)]) {
      await writeFile(path.join(dir, `${B}.json`), invalid, "utf8");
      assert.equal(await store.get(B), undefined);
      assert.deepEqual((await store.list(10)).map((entry) => entry.pack_id), [A]);
      assert.deepEqual((await store.search("solar", 10)).map((entry) => entry.pack_id), [A]);
    }
    await writeFile(path.join(dir, "unrelated.json"), JSON.stringify(valid), "utf8");
    assert.equal((await store.list(10)).length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("a rejected save leaves the previous pack intact", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "spm-store-"));
  try {
    const store = new PackStore(dir);
    const valid = pack(A, "solar", "2026-08-05T00:00:00.000Z", "Solar panels convert sunlight to electricity.");
    await store.save(valid);
    const invalid = { ...valid, sources: null } as unknown as SourcePack;
    await assert.rejects(store.save(invalid));
    assert.deepEqual(await store.get(A), valid);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("queued updates survive a rejected change without losing later writes", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "spm-store-"));
  try {
    const store = new PackStore(dir);
    await store.save(pack(A, "solar", "2026-08-05T00:00:00.000Z", "Solar panels convert sunlight to electricity."));
    const rejected = assert.rejects(store.update(A, (current) => { current.pack_id = B; }), /cannot change/u);
    await Promise.all([
      rejected,
      ...Array.from({ length: 8 }, (_, index) => store.update(A, (current) => { current.limitations.push(`Added ${index}`); })),
    ]);
    assert.deepEqual((await store.get(A))?.limitations, Array.from({ length: 8 }, (_, index) => `Added ${index}`));
    assert.equal(await store.get(B), undefined);
    assert.deepEqual(await readdir(dir), [`${A}.json`]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("readers see complete packs throughout repeated replacements", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "spm-store-"));
  try {
    const store = new PackStore(dir);
    const initial = pack(A, "solar", "2026-08-05T00:00:00.000Z", "Solar panels convert sunlight to electricity.");
    await store.save(initial);
    const writer = async () => {
      for (let index = 0; index < 8; index++) {
        await store.save({ ...initial, limitations: [String(index).repeat(100_000)] });
      }
    };
    const reader = async () => {
      for (let index = 0; index < 30; index++) {
        const saved = await store.get(A);
        assert.ok(saved, "a replacement must not expose a missing or partial pack");
        assert.deepEqual(saved.sources, initial.sources);
      }
    };
    await Promise.all([writer(), reader()]);
    assert.deepEqual(await readdir(dir), [`${A}.json`]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
