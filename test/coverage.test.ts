import assert from "node:assert/strict";
import test from "node:test";

import { buildCoverageMap } from "../src/coverage.js";

import type { DomainFact } from "../src/coverage.js";

function find(entries: ReturnType<typeof buildCoverageMap>, needle: RegExp) {
  return entries.find((e) => needle.test(e.claim));
}

void test("two domains stating the same claim → consistent", () => {
  const facts: DomainFact[] = [
    { domain: "a.com", fact: "Python was created by Guido van Rossum." },
    { domain: "b.org", fact: "Python was created by Guido van Rossum, a Dutch programmer." },
  ];
  const map = buildCoverageMap(facts);
  const entry = find(map, /Guido van Rossum/u);
  assert.ok(entry);
  assert.equal(entry?.status, "consistent");
  assert.deepEqual(entry?.mentioned_by, ["a.com", "b.org"]);
  assert.deepEqual(entry?.contested_by, []);
});

void test("same claim with matching numbers stays consistent", () => {
  const facts: DomainFact[] = [
    { domain: "a.com", fact: "The tower is 300 meters tall." },
    { domain: "b.org", fact: "The tower is 300 meters tall according to official records." },
  ];
  const entry = find(buildCoverageMap(facts), /tower/u);
  assert.equal(entry?.status, "consistent");
});

void test("same claim with conflicting numbers → contested", () => {
  const facts: DomainFact[] = [
    { domain: "a.com", fact: "The bridge is 1200 meters long." },
    { domain: "b.org", fact: "The bridge is 1500 meters long." },
  ];
  const entry = find(buildCoverageMap(facts), /bridge/u);
  assert.ok(entry);
  assert.equal(entry?.status, "contested");
  assert.deepEqual(entry?.mentioned_by, ["a.com", "b.org"]);
  assert.deepEqual(entry?.contested_by, ["a.com", "b.org"]);
});

void test("a claim from a single domain → isolated", () => {
  const facts: DomainFact[] = [
    { domain: "c.net", fact: "The museum opened a new wing for modern sculpture." },
  ];
  const entry = find(buildCoverageMap(facts), /museum/u);
  assert.equal(entry?.status, "isolated");
  assert.deepEqual(entry?.mentioned_by, ["c.net"]);
});

void test("two facts from the same domain do not corroborate each other", () => {
  const facts: DomainFact[] = [
    { domain: "a.com", fact: "The library holds two million rare manuscripts." },
    { domain: "a.com", fact: "The library holds two million rare manuscripts and scrolls." },
  ];
  const entry = find(buildCoverageMap(facts), /library/u);
  assert.equal(entry?.status, "isolated");
  assert.deepEqual(entry?.mentioned_by, ["a.com"]);
});

void test("entries are ordered contested → consistent → isolated", () => {
  const facts: DomainFact[] = [
    { domain: "c.net", fact: "The lone report describes an unusual solar observation." },
    { domain: "a.com", fact: "The satellite orbits at 500 kilometers altitude." },
    { domain: "b.org", fact: "The satellite orbits at 800 kilometers altitude." },
    { domain: "a.com", fact: "The rover landed safely on the northern plains." },
    { domain: "b.org", fact: "The rover landed safely on the northern plains region." },
  ];
  const statuses = buildCoverageMap(facts).map((e) => e.status);
  const contestedIdx = statuses.indexOf("contested");
  const isolatedIdx = statuses.indexOf("isolated");
  assert.ok(contestedIdx !== -1 && isolatedIdx !== -1);
  assert.ok(contestedIdx < isolatedIdx, "contested entries sort before isolated ones");
});
