import { DiskCache } from "./cache.js";
import { Fetcher } from "./fetcher.js";
import { PackService } from "./service.js";
import { PackStore } from "./store.js";

import type { AppConfig } from "./config.js";

export function createRuntime(config: AppConfig): {
  cache: DiskCache;
  fetcher: Fetcher;
  store: PackStore;
  service: PackService;
} {
  const cache = new DiskCache(config.cacheDir, config.cacheTtlSeconds);
  const fetcher = new Fetcher({
    timeoutMs: config.fetchTimeoutMs,
    minIntervalMs: config.fetchMinIntervalMs,
    userAgent: config.userAgent,
  });
  const store = new PackStore(config.packsDir);
  const service = new PackService(config, cache, fetcher, store);
  return { cache, fetcher, store, service };
}
