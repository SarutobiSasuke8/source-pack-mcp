/** Confidence label attached to an extracted fact. Deliberately coarse. */
export type Confidence = "high" | "medium" | "low";

/** A single extracted fact with a conservative confidence label. */
export interface Fact {
  fact: string;
  confidence: Confidence;
}

/** A direct quotation lifted verbatim from a source, with surrounding context. */
export interface Quote {
  text: string;
  context: string;
}

/** A numeric value found in a source together with its unit and context. */
export interface NumberItem {
  value: string;
  unit: string;
  context: string;
}

/** A date reference found in a source and the event it appears to describe. */
export interface DateItem {
  date: string;
  event: string;
}

/** One fetched-and-extracted source inside a pack. */
export interface Source {
  url: string;
  title: string;
  domain: string;
  retrieved_at: string;
  facts: Fact[];
  quotes: Quote[];
  numbers: NumberItem[];
  dates: DateItem[];
  primary_links: string[];
}

/** How well a claim is corroborated across the pack's sources. */
export type CoverageStatus = "consistent" | "contested" | "isolated";

/** One row of the coverage map: who said what, and whether it is contested. */
export interface CoverageEntry {
  claim: string;
  mentioned_by: string[];
  contested_by: string[];
  status: CoverageStatus;
}

/** The core deliverable: a structured research source pack. */
export interface SourcePack {
  pack_id: string;
  query: string;
  created_at: string;
  sources: Source[];
  coverage_map: CoverageEntry[];
  limitations: string[];
}

/** Compact listing of a stored pack (no bodies), for pack_list. */
export interface PackSummary {
  pack_id: string;
  query: string;
  created_at: string;
  source_count: number;
}

/** A pack_search hit: the matched pack summary plus matched snippets. */
export interface PackSearchHit {
  pack_id: string;
  query: string;
  created_at: string;
  source_count: number;
  snippets: string[];
}

/** Raw HTTP fetch result, as stored in the page cache. */
export interface FetchRecord {
  url: string;
  status: number;
  contentType?: string;
  body: string;
  fetchedAt: string;
}
