import assert from "node:assert/strict";
import test from "node:test";

import { sourcePackSchema } from "../src/schema.js";

import type { SourcePack } from "../src/types.js";

function validPack(): SourcePack {
  return {
    pack_id: "11111111-2222-4333-8444-555555555555",
    query: "history of the widget",
    created_at: "2026-08-05T00:00:00.000Z",
    sources: [
      {
        url: "https://example.com/about",
        title: "About Widget Corp",
        domain: "example.com",
        retrieved_at: "2026-08-05T00:00:00.000Z",
        facts: [{ fact: "Widget Corp was founded in 1998.", confidence: "high" }],
        quotes: [{ text: "We ship widgets worldwide.", context: "A spokesperson said so." }],
        numbers: [{ value: "4,200", unit: "people", context: "It employs 4,200 people." }],
        dates: [{ date: "1998", event: "Widget Corp was founded in 1998." }],
        primary_links: ["https://example.org/registry/widget-corp"],
      },
    ],
    coverage_map: [
      { claim: "Widget Corp was founded in 1998.", mentioned_by: ["example.com"], contested_by: [], status: "isolated" },
    ],
    limitations: ["Only one source was fetched; no cross-source corroboration was possible."],
  };
}

void test("a well-formed pack validates against the schema", () => {
  const result = sourcePackSchema.safeParse(validPack());
  assert.ok(result.success, result.success ? "" : JSON.stringify(result.error.issues));
});

void test("a bad pack_id is rejected", () => {
  const pack = { ...validPack(), pack_id: "not-a-uuid" };
  assert.equal(sourcePackSchema.safeParse(pack).success, false);
});

void test("an invalid coverage status is rejected", () => {
  const pack = validPack();
  const badEntry = { ...pack.coverage_map[0]!, status: "maybe" };
  const bad = { ...pack, coverage_map: [badEntry] };
  assert.equal(sourcePackSchema.safeParse(bad).success, false);
});

void test("an invalid confidence label is rejected", () => {
  const pack = validPack();
  const badSource = { ...pack.sources[0]!, facts: [{ fact: "x", confidence: "certain" }] };
  const bad = { ...pack, sources: [badSource] };
  assert.equal(sourcePackSchema.safeParse(bad).success, false);
});
