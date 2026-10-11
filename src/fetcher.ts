import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";

import {
  BlockedUrlError,
  ResponseTooLargeError,
  UpstreamNetworkError,
  UpstreamTimeoutError,
} from "./errors.js";

import type { FetchRecord } from "./types.js";

export interface FetcherOptions {
  timeoutMs: number;
  minIntervalMs: number;
  userAgent: string;
  /** Maximum response body size in bytes; larger responses fail with RESPONSE_TOO_LARGE. */
  maxBodyBytes: number;
}

/** Injectable dependencies so SSRF/redirect/size behaviour is unit-testable. */
export interface FetcherDeps {
  /** Resolve a hostname to all of its IP addresses. Defaults to dns.lookup. */
  lookup?: (hostname: string) => Promise<string[]>;
  /** HTTP implementation. Defaults to global fetch. */
  fetchFn?: typeof fetch;
}

const ALLOWED_PROTOCOLS = ["http:", "https:"];
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 5;

/**
 * IPv4 ranges that must never be fetched (loopback, RFC1918 private, link-local,
 * CGNAT, multicast and other reserved ranges).
 */
const IPV4_BLOCKED_RANGES: ReadonlyArray<readonly [string, number]> = [
  ["0.0.0.0", 8], // "this network"
  ["10.0.0.0", 8], // RFC1918
  ["100.64.0.0", 10], // CGNAT
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local
  ["172.16.0.0", 12], // RFC1918
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.0.2.0", 24], // TEST-NET-1
  ["192.168.0.0", 16], // RFC1918
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24], // TEST-NET-2
  ["203.0.113.0", 24], // TEST-NET-3
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved + broadcast
];

function parseIPv4(address: string): number | undefined {
  const parts = address.split(".");
  if (parts.length !== 4) return undefined;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return undefined;
    const octet = Number(part);
    if (octet > 255) return undefined;
    value = value * 256 + octet;
  }
  return value;
}

function isBlockedIPv4(address: string): boolean {
  const value = parseIPv4(address);
  if (value === undefined) return true; // unparseable → refuse
  return IPV4_BLOCKED_RANGES.some(([base, bits]) => {
    const baseValue = parseIPv4(base) ?? 0;
    const shift = 32 - bits;
    return Math.floor(value / 2 ** shift) === Math.floor(baseValue / 2 ** shift);
  });
}

function isBlockedIPv6(rawAddress: string): boolean {
  const address = rawAddress.toLowerCase().replace(/%.*$/, ""); // strip zone id
  if (address === "::" || address === "::1") return true; // unspecified / loopback

  // IPv4-mapped (::ffff:a.b.c.d), IPv4-compatible and NAT64 forms embed an
  // IPv4 address; judge the embedded address by the IPv4 rules.
  const dottedTail = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(address);
  if (dottedTail?.[1] !== undefined && isBlockedIPv4(dottedTail[1])) return true;
  if (address.startsWith("64:ff9b:")) return true; // NAT64 well-known prefix

  const firstGroup = address.startsWith("::") ? 0 : Number.parseInt(address.split(":")[0] ?? "", 16);
  if (Number.isNaN(firstGroup)) return true; // unparseable → refuse
  if (firstGroup >= 0xfe80 && firstGroup <= 0xfebf) return true; // link-local fe80::/10
  if (firstGroup >= 0xfec0 && firstGroup <= 0xfeff) return true; // site-local (deprecated)
  if (firstGroup >= 0xfc00 && firstGroup <= 0xfdff) return true; // unique-local fc00::/7
  if (firstGroup >= 0xff00) return true; // multicast ff00::/8
  if (firstGroup === 0x2001 && address.split(":")[1] === "db8") return true; // documentation

  return false;
}

/** True when an IP address points at loopback, private, link-local or otherwise reserved space. */
export function isBlockedAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return isBlockedIPv4(address);
  if (family === 6) return isBlockedIPv6(address);
  return true; // not an IP at all → refuse
}

async function defaultLookup(hostname: string): Promise<string[]> {
  const results = await dnsLookup(hostname, { all: true, verbatim: true });
  return results.map((entry) => entry.address);
}

/**
 * Rate-limited HTTP fetcher with SSRF protection.
 *
 * Requests are serialized and spaced by at least `minIntervalMs` (default 1s →
 * max 1 request/second) to stay polite. Each request has a hard timeout via
 * AbortController.
 *
 * SSRF guard: only http/https URLs are fetched, every hostname is resolved and
 * rejected when any address falls in loopback, RFC1918 private, link-local or
 * other reserved ranges, and redirects are followed manually (up to 5 hops)
 * with the same validation applied to every hop. Response bodies are read with
 * a hard byte cap (`maxBodyBytes`).
 */
export class Fetcher {
  private chain: Promise<unknown> = Promise.resolve();
  private lastStart = 0;
  private readonly lookup: (hostname: string) => Promise<string[]>;
  private readonly fetchFn: typeof fetch;

  public constructor(
    private readonly options: FetcherOptions,
    deps: FetcherDeps = {},
  ) {
    this.lookup = deps.lookup ?? defaultLookup;
    this.fetchFn = deps.fetchFn ?? fetch;
  }

  private async pace(): Promise<void> {
    const wait = this.lastStart + this.options.minIntervalMs - Date.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    this.lastStart = Date.now();
  }

  /** Serialize a task behind the rate-limit gate. */
  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.chain.then(async () => {
      await this.pace();
      return task();
    });
    // Keep the chain alive even if this task rejects.
    this.chain = run.catch(() => undefined);
    return run;
  }

  /** Reject the URL unless it is http/https and resolves only to public addresses. */
  private async assertUrlAllowed(url: string): Promise<void> {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new BlockedUrlError(url, "the URL could not be parsed");
    }
    if (!ALLOWED_PROTOCOLS.includes(parsed.protocol)) {
      throw new BlockedUrlError(url, `scheme '${parsed.protocol.replace(/:$/, "")}' is not allowed`);
    }
    const hostname = parsed.hostname.replace(/^\[/, "").replace(/\]$/, "");
    let addresses: string[];
    if (isIP(hostname)) {
      addresses = [hostname];
    } else {
      try {
        addresses = await this.lookup(hostname);
      } catch (error) {
        throw new UpstreamNetworkError(url, error);
      }
    }
    if (addresses.length === 0) {
      throw new UpstreamNetworkError(url);
    }
    const blocked = addresses.find((address) => isBlockedAddress(address));
    if (blocked !== undefined) {
      throw new BlockedUrlError(url, `host resolves to a private or reserved address (${blocked})`);
    }
  }

  private async fetchOnce(url: string, signal: AbortSignal): Promise<Response> {
    try {
      return await this.fetchFn(url, {
        signal,
        redirect: "manual",
        headers: {
          "user-agent": this.options.userAgent,
          accept: "text/html,application/xhtml+xml,text/plain,application/json,*/*",
        },
      });
    } catch (error) {
      if (signal.aborted || (error instanceof Error && error.name === "AbortError")) {
        throw new UpstreamTimeoutError(url, this.options.timeoutMs, error);
      }
      throw new UpstreamNetworkError(url, error);
    }
  }

  /**
   * Read the body with a hard byte cap; throws RESPONSE_TOO_LARGE when exceeded.
   * The same deadline that bounds the request also bounds the body, so a server
   * that sends headers and then stalls the stream fails with UPSTREAM_TIMEOUT.
   */
  private async readBody(response: Response, url: string, signal: AbortSignal): Promise<string> {
    const max = this.options.maxBodyBytes;
    const declared = Number(response.headers.get("content-length") ?? Number.NaN);
    if (Number.isFinite(declared) && declared > max) {
      await response.body?.cancel().catch(() => undefined);
      throw new ResponseTooLargeError(url, max);
    }
    if (!response.body) return "";
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let received = 0;
    let onAbort: (() => void) | undefined;
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(new UpstreamTimeoutError(url, this.options.timeoutMs));
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    });
    aborted.catch(() => undefined);
    try {
      for (;;) {
        let chunk: ReadableStreamReadResult<Uint8Array>;
        try {
          chunk = await Promise.race([reader.read(), aborted]);
        } catch (error) {
          if (error instanceof UpstreamTimeoutError) throw error;
          if (signal.aborted) throw new UpstreamTimeoutError(url, this.options.timeoutMs, error);
          throw new UpstreamNetworkError(url, error);
        }
        const { done, value } = chunk;
        if (done) break;
        received += value.byteLength;
        if (received > max) {
          throw new ResponseTooLargeError(url, max);
        }
        chunks.push(value);
      }
    } finally {
      if (onAbort) signal.removeEventListener("abort", onAbort);
      reader.cancel().catch(() => undefined);
    }
    return Buffer.concat(chunks).toString("utf8");
  }

  /** Follow redirects manually, re-validating every hop against the SSRF guard. */
  private async fetchWithRedirects(initialUrl: string): Promise<FetchRecord> {
    let currentUrl = initialUrl;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      await this.assertUrlAllowed(currentUrl);
      // One deadline per hop covers both the response headers and the body.
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.options.timeoutMs);
      try {
        const response = await this.fetchOnce(currentUrl, controller.signal);
        const location = response.headers.get("location");
        if (REDIRECT_STATUSES.has(response.status) && location !== null) {
          await response.body?.cancel().catch(() => undefined);
          let nextUrl: string;
          try {
            nextUrl = new URL(location, currentUrl).toString();
          } catch {
            throw new BlockedUrlError(currentUrl, `redirect target '${location}' could not be parsed`);
          }
          currentUrl = nextUrl;
          continue;
        }
        const body = await this.readBody(response, currentUrl, controller.signal);
        const contentType = response.headers.get("content-type") ?? undefined;
        const record: FetchRecord = {
          url: initialUrl,
          status: response.status,
          body,
          fetchedAt: new Date().toISOString(),
        };
        if (contentType) record.contentType = contentType;
        return record;
      } finally {
        clearTimeout(timer);
      }
    }
    throw new BlockedUrlError(initialUrl, `more than ${MAX_REDIRECTS} redirects`);
  }

  public fetch(url: string): Promise<FetchRecord> {
    return this.enqueue(async () => this.fetchWithRedirects(url));
  }
}
