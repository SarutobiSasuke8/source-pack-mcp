import type { CoverageEntry, CoverageStatus } from "./types.js";

/**
 * Build a coverage map from facts tagged with the domain that stated them.
 *
 * The logic is intentionally simple and transparent (see BUILD/README notes):
 *   1. Cluster facts that share enough significant words (Jaccard >= 0.5).
 *   2. A cluster mentioned by >= 2 distinct domains is "consistent"…
 *   3. …unless those domains disagree on the numbers in the claim, which makes
 *      it "contested" (both sides listed in `contested_by`).
 *   4. A cluster from a single domain is "isolated".
 *
 * This is corroboration bookkeeping, not truth assessment. It flags where a
 * claim stands alone and where sources give different numbers for what looks
 * like the same claim — nothing more.
 */

export interface DomainFact {
  domain: string;
  fact: string;
}

export interface CoverageOptions {
  similarityThreshold?: number;
  maxEntries?: number;
}

const STOPWORDS = new Set([
  "the", "and", "for", "was", "were", "are", "has", "have", "had", "with", "that", "this",
  "from", "into", "over", "under", "than", "then", "they", "them", "their", "there", "which",
  "who", "whom", "whose", "what", "when", "where", "will", "would", "could", "should", "been",
  "being", "its", "his", "her", "our", "your", "not", "but", "also", "such", "some", "any",
  "all", "one", "two", "per", "out", "about", "after", "before", "between", "during", "these",
  "those", "more", "most", "other", "each", "both", "many", "much", "very", "only",
]);

interface Tokenized {
  content: Set<string>;
  numbers: Set<string>;
}

function tokenize(fact: string): Tokenized {
  const lower = fact.toLowerCase();
  const numbers = new Set<string>();
  const numMatches = lower.match(/\d[\d,.]*/gu) ?? [];
  for (const raw of numMatches) {
    const normalized = raw.replace(/[,\s]/gu, "").replace(/\.$/u, "");
    if (normalized) numbers.add(normalized);
  }
  const content = new Set<string>();
  for (const token of lower.split(/[^a-z0-9]+/u)) {
    if (token.length < 3) continue;
    if (/^\d+$/u.test(token)) continue;
    if (STOPWORDS.has(token)) continue;
    content.add(token);
  }
  return { content, numbers };
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const value of a) if (b.has(value)) intersection++;
  return intersection / (a.size + b.size - intersection);
}

interface Cluster {
  representative: Set<string>;
  facts: string[];
  numbersByDomain: Map<string, Set<string>>;
  domains: Set<string>;
  longest: string;
}

const STATUS_ORDER: Record<CoverageStatus, number> = { contested: 0, consistent: 1, isolated: 2 };

export function buildCoverageMap(facts: DomainFact[], options: CoverageOptions = {}): CoverageEntry[] {
  const threshold = options.similarityThreshold ?? 0.5;
  const maxEntries = options.maxEntries ?? 50;
  const clusters: Cluster[] = [];

  for (const { domain, fact } of facts) {
    const trimmed = fact.trim();
    if (!trimmed) continue;
    const { content, numbers } = tokenize(trimmed);

    let target: Cluster | undefined;
    if (content.size >= 2) {
      let best = threshold;
      for (const cluster of clusters) {
        const score = jaccard(content, cluster.representative);
        if (score >= best) {
          best = score;
          target = cluster;
        }
      }
    }

    if (!target) {
      target = {
        representative: content,
        facts: [],
        numbersByDomain: new Map(),
        domains: new Set(),
        longest: trimmed,
      };
      clusters.push(target);
    }

    target.facts.push(trimmed);
    target.domains.add(domain);
    if (trimmed.length > target.longest.length) target.longest = trimmed;
    if (numbers.size > 0) {
      const existing = target.numbersByDomain.get(domain) ?? new Set<string>();
      for (const n of numbers) existing.add(n);
      target.numbersByDomain.set(domain, existing);
    }
  }

  const entries: CoverageEntry[] = clusters.map((cluster) => {
    const mentioned = [...cluster.domains].sort();
    const numberDomains = [...cluster.numbersByDomain.entries()];
    const distinctNumberSets = new Set(
      numberDomains.map(([, nums]) => [...nums].sort().join(",")),
    );
    const contested = numberDomains.length >= 2 && distinctNumberSets.size >= 2;

    let status: CoverageStatus;
    let contestedBy: string[] = [];
    if (contested) {
      status = "contested";
      contestedBy = numberDomains.map(([d]) => d).sort();
    } else if (mentioned.length >= 2) {
      status = "consistent";
    } else {
      status = "isolated";
    }

    return { claim: cluster.longest, mentioned_by: mentioned, contested_by: contestedBy, status };
  });

  entries.sort((a, b) => {
    const byStatus = STATUS_ORDER[a.status] - STATUS_ORDER[b.status];
    if (byStatus !== 0) return byStatus;
    return b.mentioned_by.length - a.mentioned_by.length;
  });

  return entries.slice(0, maxEntries);
}
