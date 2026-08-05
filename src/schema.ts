import { z } from "zod";

/**
 * Runtime schema for the source pack deliverable. Used to validate packs in
 * tests and available to consumers that want to assert on tool output.
 */

export const confidenceSchema = z.enum(["high", "medium", "low"]);

export const factSchema = z.object({
  fact: z.string(),
  confidence: confidenceSchema,
});

export const quoteSchema = z.object({
  text: z.string(),
  context: z.string(),
});

export const numberItemSchema = z.object({
  value: z.string(),
  unit: z.string(),
  context: z.string(),
});

export const dateItemSchema = z.object({
  date: z.string(),
  event: z.string(),
});

export const sourceSchema = z.object({
  url: z.string().url(),
  title: z.string(),
  domain: z.string(),
  retrieved_at: z.string(),
  facts: z.array(factSchema),
  quotes: z.array(quoteSchema),
  numbers: z.array(numberItemSchema),
  dates: z.array(dateItemSchema),
  primary_links: z.array(z.string()),
});

export const coverageEntrySchema = z.object({
  claim: z.string(),
  mentioned_by: z.array(z.string()),
  contested_by: z.array(z.string()),
  status: z.enum(["consistent", "contested", "isolated"]),
});

export const sourcePackSchema = z.object({
  pack_id: z.string().uuid(),
  query: z.string(),
  created_at: z.string(),
  sources: z.array(sourceSchema),
  coverage_map: z.array(coverageEntrySchema),
  limitations: z.array(z.string()),
});

export type SourcePackParsed = z.infer<typeof sourcePackSchema>;
