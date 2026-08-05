import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
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
