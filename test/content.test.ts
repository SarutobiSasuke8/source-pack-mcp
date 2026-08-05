import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { htmlToMarkdown } from "../src/content.js";

const fixture = path.resolve(process.cwd(), "test/fixtures/sample.html");

async function sample(): Promise<string> {
  return readFile(fixture, "utf8");
}

void test("htmlToMarkdown strips chrome and keeps article prose", async () => {
  const { title, markdown } = htmlToMarkdown(await sample(), "https://example.com/about");
  assert.match(title ?? "", /Widget Corp/u);
  assert.match(markdown, /founded in 1998/u);
  assert.match(markdown, /4,200 people/u);
  // Non-content chrome and scripts must not survive.
  assert.doesNotMatch(markdown, /tracking/u);
  assert.doesNotMatch(markdown, /Global header junk/u);
  assert.doesNotMatch(markdown, /Copyright junk footer/u);
});

void test("htmlToMarkdown normalizes whitespace (no runaway blank lines)", async () => {
  const { markdown } = htmlToMarkdown(await sample(), "https://example.com/about");
  assert.doesNotMatch(markdown, /\n{3,}/u);
  assert.equal(markdown, markdown.trim());
});

void test("htmlToMarkdown preserves outbound links as markdown", async () => {
  const { markdown } = htmlToMarkdown(await sample(), "https://example.com/about");
  assert.match(markdown, /\(https:\/\/example\.org\/registry\/widget-corp\)/u);
});
