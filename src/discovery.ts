import type { AppConfig } from "./config.js";
import type { Fetcher } from "./fetcher.js";

export interface Discovery {
  urls: string[];
  method: "search_api" | "duckduckgo_html";
  shallow: boolean;
  note?: string;
}

/** Hosts that are search-engine plumbing / ads rather than real result targets. */
function isJunkHost(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    if (host.endsWith("duckduckgo.com")) return true;
    if (host.endsWith("bing.com")) return true;
    if (host.endsWith("google.com") && new URL(url).pathname.startsWith("/aclk")) return true;
    return false;
  } catch {
    return false;
  }
}

function pushUnique(list: string[], seen: Set<string>, url: string, max: number): void {
  if (list.length >= max) return;
  if (!/^https?:\/\//iu.test(url)) return;
  if (isJunkHost(url)) return;
  const normalized = url.trim();
  if (seen.has(normalized)) return;
  seen.add(normalized);
  list.push(normalized);
}

/** Best-effort extraction of URLs from an arbitrary JSON search response. */
function urlsFromJson(json: unknown): string[] {
  const out: string[] = [];
  const visit = (node: unknown, keyHint?: string): void => {
    if (out.length > 100) return;
    if (typeof node === "string") {
      if (/^https?:\/\//iu.test(node) && (keyHint === undefined || /url|link|href/iu.test(keyHint))) {
        out.push(node);
      }
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) visit(item, keyHint);
      return;
    }
    if (node && typeof node === "object") {
      for (const [key, value] of Object.entries(node)) visit(value, key);
    }
  };
  visit(json);
  return out;
}

async function discoverViaApi(
  query: string,
  apiUrl: string,
  fetcher: Fetcher,
  max: number,
): Promise<Discovery> {
  const requestUrl = `${apiUrl}${apiUrl.includes("?") ? "&" : "?"}q=${encodeURIComponent(query)}`;
  const record = await fetcher.fetch(requestUrl);
  const seen = new Set<string>();
  const urls: string[] = [];
  if (record.status >= 200 && record.status < 300) {
    try {
      const parsed = urlsFromJson(JSON.parse(record.body));
      for (const url of parsed) pushUnique(urls, seen, url, max);
    } catch {
      // Non-JSON response from the configured API — treated as no results.
    }
  }
  const discovery: Discovery = { urls, method: "search_api", shallow: urls.length < max };
  if (urls.length === 0) discovery.note = `Search API returned no usable URLs (HTTP ${record.status}).`;
  return discovery;
}

const DDG_RESULT_RE = /\/\/duckduckgo\.com\/l\/\?uddg=([^"&]+)/gu;

async function discoverViaDuckDuckGo(query: string, fetcher: Fetcher, max: number): Promise<Discovery> {
  const requestUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const record = await fetcher.fetch(requestUrl);
  const seen = new Set<string>();
  const urls: string[] = [];
  if (record.status >= 200 && record.status < 300) {
    let match: RegExpExecArray | null;
    DDG_RESULT_RE.lastIndex = 0;
    while ((match = DDG_RESULT_RE.exec(record.body)) !== null && urls.length < max) {
      try {
        pushUnique(urls, seen, decodeURIComponent(match[1] ?? ""), max);
      } catch {
        // Skip a malformed redirect URL rather than failing discovery.
      }
    }
  }
  const discovery: Discovery = { urls, method: "duckduckgo_html", shallow: urls.length < max };
  if (urls.length === 0) {
    discovery.note = `DuckDuckGo HTML search returned no usable results (HTTP ${record.status}).`;
  }
  return discovery;
}

/**
 * Discover candidate source URLs for a query. Uses `SEARCH_API_URL` when
 * configured, otherwise scrapes the DuckDuckGo HTML results page. Discovery is
 * deliberately shallow — it is a starting point, not an exhaustive crawl.
 */
export async function discoverSources(
  query: string,
  config: AppConfig,
  fetcher: Fetcher,
  max: number,
): Promise<Discovery> {
  if (config.searchApiUrl) return discoverViaApi(query, config.searchApiUrl, fetcher, max);
  return discoverViaDuckDuckGo(query, fetcher, max);
}
