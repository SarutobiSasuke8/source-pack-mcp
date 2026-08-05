import type { Confidence, DateItem, Fact, NumberItem, Quote } from "./types.js";

/**
 * Conservative, transparent extraction heuristics.
 *
 * None of this is "verification" in a strong sense: it lifts candidate facts,
 * quotes, numbers, dates and outbound links out of already-cleaned markdown and
 * attaches a coarse confidence label. It never invents content. When a signal
 * is weak the confidence is lowered rather than the item dropped, and the caller
 * records the shallowness of extraction in the pack's `limitations`.
 */

export interface ExtractionResult {
  facts: Fact[];
  quotes: Quote[];
  numbers: NumberItem[];
  dates: DateItem[];
  primary_links: string[];
}

export interface ExtractionOptions {
  /** Per-field cap. "quick" packs use a small cap; "deep" packs a larger one. */
  maxItems: number;
  /** Cap on outbound links captured per source. */
  maxLinks: number;
}

const MONTHS =
  "January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec";

const FACT_VERBS =
  /\b(is|are|was|were|has|have|had|will|founded|established|released|launched|created|developed|designed|born|died|announced|reported|published|acquired|introduced|became|won|awarded|contains|consists|according to)\b/i;

const HEDGE = /\b(may|might|could|reportedly|allegedly|rumou?red|purportedly|some say|it is believed|possibly|perhaps)\b/i;

const UNIT_WORDS =
  "%|percent|million|billion|trillion|thousand|kg|km|kilometers?|kilometres?|meters?|metres?|miles?|years?|months?|weeks?|days?|hours?|minutes?|seconds?|people|users|employees|members|dollars?|euros?|pounds?|GB|MB|TB|kB";

const NUMBER_RE = new RegExp(
  String.raw`(?<currency>[$€£])?\s?(?<num>\d{1,3}(?:[,\s]\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)\s?(?<unit>${UNIT_WORDS})?`,
  "giu",
);

const DATE_RES: RegExp[] = [
  // 12 January 1991 / January 12, 1991
  new RegExp(String.raw`\b\d{1,2}\s+(?:${MONTHS})\.?\s+\d{4}\b`, "gu"),
  new RegExp(String.raw`\b(?:${MONTHS})\.?\s+\d{1,2},?\s+\d{4}\b`, "gu"),
  // Month Year
  new RegExp(String.raw`\b(?:${MONTHS})\.?\s+\d{4}\b`, "gu"),
  // ISO
  /\b\d{4}-\d{2}-\d{2}\b/gu,
  // bare year 1500-2099
  /\b(?:1[5-9]\d{2}|20\d{2})\b/gu,
];

/** Reduce markdown to plain prose while keeping sentence boundaries intact. */
function toPlainText(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`]*`/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s{0,3}[>\-*+]\s+/gm, "")
    .replace(/[*_~]{1,3}/g, "")
    .replace(/\|/g, " ")
    .replace(/\[\d+\]/g, "")
    .replace(/\[edit\]/giu, "")
    .replace(/\u00A0/g, " ");
}

/** Split cleaned prose into trimmed, de-duplicated sentences. */
export function splitSentences(markdown: string): string[] {
  const plain = toPlainText(markdown);
  const seen = new Set<string>();
  const sentences: string[] = [];
  for (const block of plain.split(/\n+/)) {
    const line = block.trim();
    if (!line) continue;
    for (const raw of line.split(/(?<=[.!?])\s+(?=["“(A-Z0-9])/u)) {
      const sentence = raw.replace(/\s+/g, " ").trim();
      if (sentence.length < 20 || sentence.length > 400) continue;
      const key = sentence.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      sentences.push(sentence);
    }
  }
  return sentences;
}

function clip(text: string, max = 240): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}

function hasNumberWithUnit(sentence: string): boolean {
  NUMBER_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = NUMBER_RE.exec(sentence)) !== null) {
    if (match.groups?.["currency"] || match.groups?.["unit"]) return true;
  }
  return false;
}

const YEAR_RE = /\b(?:1[5-9]\d{2}|20\d{2})\b/u;
const PROPER_NOUN_RE = /\b[A-Z][a-zA-Z]{2,}\b/u;

function factConfidence(sentence: string): Confidence {
  if (sentence.length < 45 || HEDGE.test(sentence)) return "low";
  const anchored = YEAR_RE.test(sentence) || hasNumberWithUnit(sentence);
  // The first word is usually capitalized; require a proper noun elsewhere.
  const rest = sentence.slice(sentence.indexOf(" ") + 1);
  if (anchored && PROPER_NOUN_RE.test(rest)) return "high";
  return "medium";
}

function extractFacts(sentences: string[], max: number): Fact[] {
  const facts: Fact[] = [];
  for (const sentence of sentences) {
    if (facts.length >= max) break;
    if (sentence.length < 30) continue;
    if (!FACT_VERBS.test(sentence)) continue;
    const rest = sentence.slice(sentence.indexOf(" ") + 1);
    const factual = YEAR_RE.test(sentence) || /\d/.test(sentence) || PROPER_NOUN_RE.test(rest);
    if (!factual) continue;
    facts.push({ fact: clip(sentence, 300), confidence: factConfidence(sentence) });
  }
  return facts;
}

function extractNumbers(sentences: string[], max: number): NumberItem[] {
  const numbers: NumberItem[] = [];
  const seen = new Set<string>();
  for (const sentence of sentences) {
    if (numbers.length >= max) break;
    NUMBER_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = NUMBER_RE.exec(sentence)) !== null && numbers.length < max) {
      const currency = match.groups?.["currency"] ?? "";
      const num = match.groups?.["num"] ?? "";
      const unit = match.groups?.["unit"] ?? "";
      if (!num) continue;
      // Skip bare 4-digit years with no unit/currency — those belong to `dates`.
      if (!currency && !unit && /^(?:1[5-9]\d{2}|20\d{2})$/u.test(num)) continue;
      const value = `${currency}${num}`.trim();
      const key = `${value}|${unit.toLowerCase()}|${sentence.slice(0, 40).toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      numbers.push({ value, unit: unit.trim(), context: clip(sentence) });
    }
  }
  return numbers;
}

function extractDates(sentences: string[], max: number): DateItem[] {
  const dates: DateItem[] = [];
  const seen = new Set<string>();
  for (const sentence of sentences) {
    if (dates.length >= max) break;
    const found = new Set<string>();
    for (const re of DATE_RES) {
      re.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = re.exec(sentence)) !== null) found.add(match[0].trim());
    }
    for (const date of found) {
      if (dates.length >= max) break;
      const key = `${date.toLowerCase()}|${sentence.slice(0, 40).toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      dates.push({ date, event: clip(sentence) });
    }
  }
  return dates;
}

const QUOTE_RE = /["“]([^"“”]{15,300})["”]/gu;

function extractQuotes(sentences: string[], max: number): Quote[] {
  const quotes: Quote[] = [];
  const seen = new Set<string>();
  for (const sentence of sentences) {
    if (quotes.length >= max) break;
    QUOTE_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = QUOTE_RE.exec(sentence)) !== null && quotes.length < max) {
      const text = (match[1] ?? "").trim();
      if (!text || !/\s/.test(text)) continue; // require a multi-word quote
      const key = text.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      quotes.push({ text: clip(text, 300), context: clip(sentence) });
    }
  }
  return quotes;
}

const IMAGE_EXT = /\.(?:png|jpe?g|gif|svg|webp|ico|css|js)(?:$|[?#])/iu;

/** Collect unique outbound http(s) links from markdown link syntax and bare URLs. */
export function extractLinks(markdown: string, max: number): string[] {
  const urls: string[] = [];
  const seen = new Set<string>();
  const push = (raw: string): void => {
    const url = raw.replace(/[).,;'"]+$/u, "");
    if (!/^https?:\/\//iu.test(url)) return;
    if (IMAGE_EXT.test(url)) return;
    if (/[?&]action=edit|[?&]action=history|redlink=1/iu.test(url)) return;
    if (seen.has(url)) return;
    seen.add(url);
    if (urls.length < max) urls.push(url);
  };
  const linkRe = /\[[^\]]*\]\((https?:\/\/[^)\s]+)\)/gu;
  let match: RegExpExecArray | null;
  while ((match = linkRe.exec(markdown)) !== null) push(match[1] ?? "");
  const bareRe = /(?<![("])\bhttps?:\/\/[^\s)<>\]]+/gu;
  while ((match = bareRe.exec(markdown)) !== null) push(match[0]);
  return urls;
}

/** Run every heuristic over a source's cleaned markdown. */
export function extract(markdown: string, options: ExtractionOptions): ExtractionResult {
  const sentences = splitSentences(markdown).slice(0, 600);
  return {
    facts: extractFacts(sentences, options.maxItems),
    quotes: extractQuotes(sentences, options.maxItems),
    numbers: extractNumbers(sentences, options.maxItems),
    dates: extractDates(sentences, options.maxItems),
    primary_links: extractLinks(markdown, options.maxLinks),
  };
}
