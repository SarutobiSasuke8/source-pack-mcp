import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { htmlToMarkdown } from "../src/content.js";
import { extract, extractLinks, splitSentences } from "../src/extract.js";

const fixture = path.resolve(process.cwd(), "test/fixtures/sample.html");

async function sampleMarkdown(): Promise<string> {
  const html = await readFile(fixture, "utf8");
  return htmlToMarkdown(html, "https://example.com/about").markdown;
}

void test("splitSentences produces clean, bounded sentences", () => {
  const sentences = splitSentences(
    "# Heading\n\nAlpha beta gamma delta epsilon. A second sentence appears here now! Third one is here?\n\n- a short list bullet line",
  );
  assert.ok(sentences.some((s) => s.startsWith("Alpha beta gamma delta epsilon")));
  assert.ok(sentences.some((s) => s.startsWith("A second sentence appears here")));
  assert.ok(sentences.every((s) => s.length >= 20 && s.length <= 400));
});

void test("extract pulls facts with conservative confidence labels", async () => {
  const { facts } = extract(await sampleMarkdown(), { maxItems: 8, maxLinks: 10 });
  const founded = facts.find((f) => /founded in 1998/u.test(f.fact));
  assert.ok(founded, "founding fact should be extracted");
  assert.equal(founded?.confidence, "high", "year + proper noun anchors high confidence");
});

void test("extract flags hedged statements as low confidence", () => {
  const { facts } = extract(
    "The startup might reach 1000 paying users in 2027 according to an internal memo.",
    { maxItems: 8, maxLinks: 10 },
  );
  const hedged = facts.find((f) => /might reach/u.test(f.fact));
  assert.ok(hedged);
  assert.equal(hedged?.confidence, "low");
});

void test("extract captures numbers with units and currency", async () => {
  const { numbers } = extract(await sampleMarkdown(), { maxItems: 12, maxLinks: 10 });
  assert.ok(numbers.some((n) => n.value === "4,200" && /people/u.test(n.unit)));
  assert.ok(numbers.some((n) => n.value === "$3.5" && /billion/u.test(n.unit)));
});

void test("extract captures dates with event context", async () => {
  const { dates } = extract(await sampleMarkdown(), { maxItems: 12, maxLinks: 10 });
  assert.ok(dates.some((d) => d.date === "March 3, 2010"));
  assert.ok(dates.some((d) => d.date === "1998" && /founded/u.test(d.event)));
});

void test("extract captures direct quotes", async () => {
  const { quotes } = extract(await sampleMarkdown(), { maxItems: 12, maxLinks: 10 });
  assert.ok(quotes.some((q) => /ship widgets to over 40 countries/u.test(q.text)));
});

void test("extractLinks keeps outbound sources and drops asset/junk links", async () => {
  const links = extractLinks(await sampleMarkdown(), 10);
  assert.ok(links.includes("https://example.org/registry/widget-corp"));
  assert.ok(!links.some((u) => u.endsWith(".png")));
});
