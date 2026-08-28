import assert from "node:assert/strict";
import test from "node:test";

import { BlockedUrlError, ResponseTooLargeError } from "../src/errors.js";
import { Fetcher, isBlockedAddress } from "../src/fetcher.js";

import type { FetcherDeps, FetcherOptions } from "../src/fetcher.js";

const OPTIONS: FetcherOptions = {
  timeoutMs: 5_000,
  minIntervalMs: 0,
  userAgent: "source-pack-mcp-test",
  maxBodyBytes: 1_024,
};

const PUBLIC_V4 = "93.184.216.34";

function makeFetcher(deps: FetcherDeps, options: Partial<FetcherOptions> = {}): Fetcher {
  return new Fetcher({ ...OPTIONS, ...options }, deps);
}

/** A lookup that must never be needed. */
const noLookup = (hostname: string): Promise<string[]> => {
  throw new Error(`unexpected DNS lookup for ${hostname}`);
};

/** A fetch that must never be reached. */
const noFetch: typeof fetch = () => {
  throw new Error("fetch must not be called for blocked URLs");
};

void test("isBlockedAddress rejects loopback, private, link-local and reserved ranges", () => {
  const blocked = [
    "127.0.0.1",
    "127.255.255.254",
    "10.0.0.5",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "169.254.169.254", // cloud metadata
    "100.64.0.1", // CGNAT
    "0.0.0.0",
    "192.0.2.1", // TEST-NET-1
    "198.18.0.1", // benchmarking
    "224.0.0.1", // multicast
    "255.255.255.255",
    "::1",
    "::",
    "fe80::1", // link-local
    "fd12:3456::1", // unique-local
    "fc00::1",
    "ff02::1", // multicast
    "::ffff:127.0.0.1", // v4-mapped loopback
    "::ffff:10.0.0.1", // v4-mapped private
    "64:ff9b::a00:1", // NAT64
    "2001:db8::1", // documentation
  ];
  for (const address of blocked) {
    assert.equal(isBlockedAddress(address), true, `${address} should be blocked`);
  }

  const allowed = [PUBLIC_V4, "8.8.8.8", "172.32.0.1", "2606:4700::1111", "2a00:1450:4009::8a"];
  for (const address of allowed) {
    assert.equal(isBlockedAddress(address), false, `${address} should be allowed`);
  }

  // Anything that is not an IP address at all is refused.
  assert.equal(isBlockedAddress("not-an-ip"), true);
});

void test("fetch rejects hostnames that resolve to private or reserved addresses", async () => {
  const fetcher = makeFetcher({
    lookup: () => Promise.resolve(["10.0.0.5"]),
    fetchFn: noFetch,
  });
  await assert.rejects(fetcher.fetch("https://internal.example.com/admin"), (error: unknown) => {
    assert.ok(error instanceof BlockedUrlError);
    assert.equal(error.code, "URL_BLOCKED");
    assert.match(error.message, /private or reserved address/);
    return true;
  });
});

void test("fetch rejects when any resolved address is blocked, even alongside public ones", async () => {
  const fetcher = makeFetcher({
    lookup: () => Promise.resolve([PUBLIC_V4, "127.0.0.1"]),
    fetchFn: noFetch,
  });
  await assert.rejects(fetcher.fetch("https://rebind.example.com/"), BlockedUrlError);
});

void test("fetch rejects blocked IP literals without a DNS lookup", async () => {
  const fetcher = makeFetcher({ lookup: noLookup, fetchFn: noFetch });
  await assert.rejects(fetcher.fetch("http://127.0.0.1:8080/secrets"), BlockedUrlError);
  await assert.rejects(fetcher.fetch("http://169.254.169.254/latest/meta-data/"), BlockedUrlError);
  await assert.rejects(fetcher.fetch("http://[::1]/"), BlockedUrlError);
  await assert.rejects(fetcher.fetch("http://[fe80::1]/"), BlockedUrlError);
});

void test("fetch rejects non-http(s) schemes", async () => {
  const fetcher = makeFetcher({ lookup: noLookup, fetchFn: noFetch });
  await assert.rejects(fetcher.fetch("ftp://example.com/file"), (error: unknown) => {
    assert.ok(error instanceof BlockedUrlError);
    assert.match(error.message, /scheme 'ftp' is not allowed/);
    return true;
  });
  await assert.rejects(fetcher.fetch("file:///etc/passwd"), BlockedUrlError);
});

void test("redirects to private addresses are rejected", async () => {
  const lookups: string[] = [];
  const fetcher = makeFetcher({
    lookup: (hostname) => {
      lookups.push(hostname);
      return Promise.resolve([PUBLIC_V4]);
    },
    fetchFn: () =>
      Promise.resolve(
        new Response(null, {
          status: 302,
          headers: { location: "http://169.254.169.254/latest/meta-data/" },
        }),
      ),
  });
  await assert.rejects(fetcher.fetch("https://example.com/start"), BlockedUrlError);
  assert.deepEqual(lookups, ["example.com"]);
});

void test("redirects are followed manually and every hop is re-validated", async () => {
  const lookups: string[] = [];
  const fetched: string[] = [];
  const fetcher = makeFetcher({
    lookup: (hostname) => {
      lookups.push(hostname);
      return Promise.resolve([PUBLIC_V4]);
    },
    fetchFn: (input) => {
      const url = String(input);
      fetched.push(url);
      if (url === "https://example.com/start") {
        return Promise.resolve(
          new Response(null, { status: 301, headers: { location: "https://cdn.example.net/final" } }),
        );
      }
      return Promise.resolve(
        new Response("final body", { status: 200, headers: { "content-type": "text/plain" } }),
      );
    },
  });
  const record = await fetcher.fetch("https://example.com/start");
  assert.equal(record.status, 200);
  assert.equal(record.body, "final body");
  assert.equal(record.url, "https://example.com/start");
  assert.deepEqual(lookups, ["example.com", "cdn.example.net"]);
  assert.deepEqual(fetched, ["https://example.com/start", "https://cdn.example.net/final"]);
});

void test("redirect loops give up after the redirect limit", async () => {
  const fetcher = makeFetcher({
    lookup: () => Promise.resolve([PUBLIC_V4]),
    fetchFn: () =>
      Promise.resolve(new Response(null, { status: 302, headers: { location: "https://example.com/loop" } })),
  });
  await assert.rejects(fetcher.fetch("https://example.com/loop"), (error: unknown) => {
    assert.ok(error instanceof BlockedUrlError);
    assert.match(error.message, /redirects/);
    return true;
  });
});

void test("response bodies over the byte cap fail with RESPONSE_TOO_LARGE", async () => {
  const fetcher = makeFetcher(
    {
      lookup: () => Promise.resolve([PUBLIC_V4]),
      fetchFn: () => Promise.resolve(new Response("x".repeat(2_048), { status: 200 })),
    },
    { maxBodyBytes: 1_024 },
  );
  await assert.rejects(fetcher.fetch("https://example.com/big"), (error: unknown) => {
    assert.ok(error instanceof ResponseTooLargeError);
    assert.equal(error.code, "RESPONSE_TOO_LARGE");
    assert.deepEqual(error.details, { url: "https://example.com/big", max_bytes: 1_024 });
    return true;
  });
});

void test("a declared content-length over the cap is rejected before reading the body", async () => {
  const fetcher = makeFetcher(
    {
      lookup: () => Promise.resolve([PUBLIC_V4]),
      fetchFn: () =>
        Promise.resolve(
          new Response("small", { status: 200, headers: { "content-length": "999999" } }),
        ),
    },
    { maxBodyBytes: 1_024 },
  );
  await assert.rejects(fetcher.fetch("https://example.com/declared-big"), ResponseTooLargeError);
});

void test("bodies within the cap are returned intact", async () => {
  const fetcher = makeFetcher(
    {
      lookup: () => Promise.resolve([PUBLIC_V4]),
      fetchFn: () =>
        Promise.resolve(new Response("hello world", { status: 200, headers: { "content-type": "text/plain" } })),
    },
    { maxBodyBytes: 1_024 },
  );
  const record = await fetcher.fetch("https://example.com/ok");
  assert.equal(record.status, 200);
  assert.equal(record.body, "hello world");
  assert.equal(record.contentType, "text/plain");
});
