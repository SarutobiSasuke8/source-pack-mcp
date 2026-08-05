import path from "node:path";

import { z } from "zod";

/**
 * Environment configuration for the source-pack MCP server.
 *
 * Everything has a sensible default so the server runs locally against public
 * content out of the box. No API keys are required; `SEARCH_API_URL` is the
 * only optional external dependency and discovery falls back to an HTML search
 * page when it is unset.
 */
const envSchema = z.object({
  MAX_SOURCES_PER_PACK: z.coerce.number().int().min(1).max(50).default(8),
  FETCH_TIMEOUT_MS: z.coerce.number().int().min(500).max(120_000).default(15_000),
  FETCH_MIN_INTERVAL_MS: z.coerce.number().int().min(0).max(60_000).default(1_000),
  SEARCH_API_URL: z.string().url().optional(),
  USER_AGENT: z
    .string()
    .default("source-pack-mcp/0.1 (+https://github.com/SarutobiSasuke8/source-pack-mcp)"),
  CACHE_DIR: z.string().default(".cache"),
  CACHE_TTL_SECONDS: z.coerce.number().int().min(0).max(2_592_000).default(3_600),
  PACKS_DIR: z.string().default(".packs"),
  HOST: z.string().default("127.0.0.1"),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3_225),
});

export interface AppConfig {
  maxSourcesPerPack: number;
  fetchTimeoutMs: number;
  fetchMinIntervalMs: number;
  searchApiUrl?: string;
  userAgent: string;
  cacheDir: string;
  cacheTtlSeconds: number;
  packsDir: string;
  host: string;
  port: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.parse(env);
  const config: AppConfig = {
    maxSourcesPerPack: parsed.MAX_SOURCES_PER_PACK,
    fetchTimeoutMs: parsed.FETCH_TIMEOUT_MS,
    fetchMinIntervalMs: parsed.FETCH_MIN_INTERVAL_MS,
    userAgent: parsed.USER_AGENT,
    cacheDir: path.resolve(parsed.CACHE_DIR),
    cacheTtlSeconds: parsed.CACHE_TTL_SECONDS,
    packsDir: path.resolve(parsed.PACKS_DIR),
    host: parsed.HOST,
    port: parsed.PORT,
  };
  if (parsed.SEARCH_API_URL) config.searchApiUrl = parsed.SEARCH_API_URL;
  return config;
}
