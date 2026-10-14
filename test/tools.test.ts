import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { InMemoryTransport } from "@modelcontextprotocol/server";

import { DiskCache } from "../src/cache.js";
import { loadConfig } from "../src/config.js";
import { Fetcher } from "../src/fetcher.js";
import { sourcePackSchema } from "../src/schema.js";
import { createSourcePackMcpServer } from "../src/server.js";
import { PackService } from "../src/service.js";
import { PackStore } from "../src/store.js";

import type { FetcherOptions } from "../src/fetcher.js";
import type { PackService as PackServiceType } from "../src/service.js";
import type { SourcePack } from "../src/types.js";

/**
 * Tool-level coverage for pack_build, pack_add_source, pack_get, pack_list
 * and pack_search.
 *
 * Pages, search responses and stored packs live under test/fixtures/tools.
 * A fake fetcher serves those files, so this suite does not touch the network.
 * Assertions follow the behaviour the server already implements.
 */

const PUBLIC_IP = "93.184.216.34";
const SEED_ID = "ffffffff-9999-4999-8999-999999999999";
const WIND_ID = "aaaaaaaa-1111-4111-8111-111111111111";
const STORAGE_ID = "bbbbbbbb-2222-4222-8222-222222222222";
const MISMATCH_ID = "dddddddd-4444-4444-8444-444444444444";
const HEAT_FACT = "Heat pumps were installed in 12 million homes across Europe during 2024.";
const CONTESTED_FACT = "Heat pumps were installed in 9 million homes across Europe during 2024.";
const AGENCY_FACT = "The Energy Agency published a guide for households before winter.";
const ELLIPSIS = "\u2026";

const SEARCH_FILES: Record<string, string> = {
  "heat pumps": "search/heat-pumps.json",
  "overflow trials": "search/overflow.json",
  "nothing known": "search/empty.json",
  "recorded failures": "search/failures.json",
};

const PAGE_FILES: Record<string, string> = {
  "alpha.example": "pages/alpha.html",
  "beta.example": "pages/beta.html",
  "contested.example": "pages/contested.html",
  "denied.example": "pages/denied.html",
  "overflow.example": "pages/overflow.html",
  "huge.example": "pages/huge.html",
};

function fixturesRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let hop = 0; hop < 6; hop += 1) {
    const candidate = path.join(dir, "test", "fixtures", "tools");
    if (existsSync(candidate)) return candidate;
    dir = path.dirname(dir);
  }
  throw new Error("test/fixtures/tools was not found.");
}

async function readFixture(relativePath: string): Promise<string> {
  return readFile(path.join(fixturesRoot(), relativePath), "utf8");
}

function htmlResponse(body: string, status = 200, contentType = "text/html; charset=utf-8"): Response {
  return new Response(body, { status, headers: { "content-type": contentType } });
}

function lookup(hostname: string): Promise<string[]> {
  const host = hostname.toLowerCase().replace(/\.$/u, "");
  if (host === "private.example") return Promise.resolve(["10.1.2.3"]);
  if (host === "dns-fail.example") return Promise.reject(new Error("getaddrinfo ENOTFOUND"));
  return Promise.resolve([PUBLIC_IP]);
}

const fetchFn: typeof fetch = async (input, init) => {
  const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  const url = new URL(raw);
  const host = url.hostname.toLowerCase();

  if (host === "search.example") {
    const query = url.searchParams.get("q") ?? "";
    const relativePath = SEARCH_FILES[query];
    if (!relativePath) return htmlResponse("{}", 500, "application/json");
    return htmlResponse(await readFixture(relativePath), 200, "application/json");
  }

  if (url.pathname === "/robots.txt") {
    const relativePath = host === "denied.example" ? "pages/robots-deny-all.txt" : "pages/robots-allow.txt";
    return htmlResponse(await readFixture(relativePath), 200, "text/plain");
  }

  if (host === "stall.example") {
    return new Promise<Response>((_resolve, reject) => {
      const abort = (): void => {
        const error = new Error("The operation was aborted");
        error.name = "AbortError";
        reject(error);
      };
      if (init?.signal?.aborted) {
        abort();
        return;
      }
      init?.signal?.addEventListener("abort", abort, { once: true });
    });
  }

  if (host === "network.example") throw new TypeError("connect ECONNREFUSED");
  if (host === "redirect.example") {
    return new Response(null, { status: 302, headers: { location: "http://127.0.0.1/secret" } });
  }
  if (host === "down.example") return htmlResponse("unavailable", 503, "text/plain");
  if (host === "missing.example") return htmlResponse("missing", 404, "text/plain");

  const relativePath = PAGE_FILES[host];
  if (!relativePath) throw new Error(`Unexpected fixture fetch: ${url.href}`);
  return htmlResponse(await readFixture(relativePath));
};

interface RpcErrorBody {
  code: number;
  message: string;
  data?: unknown;
}

interface RpcMessage {
  id?: number | string;
  result?: unknown;
  error?: RpcErrorBody;
}

interface ToolOutcome {
  isError: boolean;
  text: string;
  structured: unknown;
}

type CallTool = (name: string, args: Record<string, unknown>) => Promise<ToolOutcome>;

function asRecord(value: unknown, label: string): Record<string, unknown> {
  assert.ok(value && typeof value === "object" && !Array.isArray(value), label);
  return value as Record<string, unknown>;
}

function outcomeFromResult(result: unknown): ToolOutcome {
  const record = asRecord(result, "tool result");
  let text = "";
  if (Array.isArray(record.content)) {
    const first = record.content[0];
    if (first && typeof first === "object" && "text" in first && typeof first.text === "string") text = first.text;
  }
  return { isError: record.isError === true, text, structured: record.structuredContent };
}

function payload(outcome: ToolOutcome): Record<string, unknown> {
  assert.equal(outcome.isError, false, outcome.text || JSON.stringify(outcome.structured));
  if (outcome.structured && typeof outcome.structured === "object") return asRecord(outcome.structured, "structuredContent");
  return asRecord(JSON.parse(outcome.text) as unknown, "tool text");
}

function assertInputError(outcome: ToolOutcome, needle: string): void {
  assert.equal(outcome.isError, true, JSON.stringify(outcome));
  const haystack = `${outcome.text}\n${JSON.stringify(outcome.structured ?? null)}`;
  assert.match(haystack, new RegExp(needle, "iu"), haystack);
}

function assertErrorCode(outcome: ToolOutcome, code: string): Record<string, unknown> {
  assert.equal(outcome.isError, true, outcome.text);
  const envelope = asRecord(outcome.structured, outcome.text);
  const error = asRecord(envelope.error, outcome.text);
  assert.equal(error.code, code, outcome.text);
  assert.equal(error.schema_version, "1");
  assert.equal(typeof error.message, "string");
  assert.equal(outcome.text, error.message);
  return error;
}

async function withTools(
  options: {
    env?: NodeJS.ProcessEnv;
    packsDir?: string;
    timeoutMs?: number;
    maxBodyBytes?: number;
    seed?: boolean;
  },
  run: (ctx: { call: CallTool; listTools: () => Promise<string[]>; store: PackStore }) => Promise<void>,
): Promise<void> {
  const temp = await mkdtemp(path.join(os.tmpdir(), "spm-tools-"));
  const mcpRef: { current?: ReturnType<typeof createSourcePackMcpServer> } = {};
  const timers = new Set<NodeJS.Timeout>();
  try {
    const packsDir = options.packsDir ?? path.join(temp, "packs");
    const config = loadConfig({
      CACHE_DIR: path.join(temp, "cache"),
      PACKS_DIR: packsDir,
      CACHE_TTL_SECONDS: "0",
      FETCH_MIN_INTERVAL_MS: "0",
      FETCH_TIMEOUT_MS: "5000",
      MAX_SOURCES_PER_PACK: "8",
      SEARCH_API_URL: "https://search.example/v1",
      ...options.env,
    });
    const fetcherOptions: FetcherOptions = {
      timeoutMs: options.timeoutMs ?? config.fetchTimeoutMs,
      minIntervalMs: 0,
      userAgent: config.userAgent,
      maxBodyBytes: options.maxBodyBytes ?? config.fetchMaxBodyBytes,
    };
    const store = new PackStore(config.packsDir);
    const service: PackServiceType = new PackService(
      config,
      new DiskCache(config.cacheDir, config.cacheTtlSeconds),
      new Fetcher(fetcherOptions, { lookup, fetchFn }),
      store,
    );
    if (options.seed) await store.save(seedPack());

    const mcp = createSourcePackMcpServer(service);
    mcpRef.current = mcp;
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const pending = new Map<number, (message: RpcMessage) => void>();
    let nextId = 1;
    clientTransport.onmessage = (message) => {
      if (typeof message !== "object" || message === null || !("id" in message)) return;
      const id = message.id;
      if (typeof id !== "number") return;
      const resolve = pending.get(id);
      if (!resolve) return;
      pending.delete(id);
      resolve(message as RpcMessage);
    };
    await clientTransport.start();
    await mcp.connect(serverTransport);

    const request = (method: string, params: Record<string, unknown>): Promise<RpcMessage> =>
      new Promise((resolve, reject) => {
        const id = nextId;
        nextId += 1;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`Timed out waiting for ${method}`));
        }, 10_000);
        timers.add(timer);
        pending.set(id, (message) => {
          clearTimeout(timer);
          timers.delete(timer);
          resolve(message);
        });
        const outbound = { jsonrpc: "2.0", id, method, params } as Parameters<InMemoryTransport["send"]>[0];
        void clientTransport.send(outbound);
      });

    const init = await request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "source-pack-tool-tests", version: "1.0.0" },
    });
    assert.ok(init.result, JSON.stringify(init));
    const notification = { jsonrpc: "2.0", method: "notifications/initialized" } as Parameters<InMemoryTransport["send"]>[0];
    await clientTransport.send(notification);

    const call: CallTool = async (name, args) => {
      const response = await request("tools/call", { name, arguments: args });
      if (response.error) {
        return { isError: true, text: response.error.message, structured: response.error.data };
      }
      return outcomeFromResult(response.result);
    };
    const listTools = async (): Promise<string[]> => {
      const response = await request("tools/list", {});
      assert.ok(response.result, JSON.stringify(response));
      const body = asRecord(response.result, "tools/list");
      assert.ok(Array.isArray(body.tools), JSON.stringify(body));
      return body.tools.map((tool) => {
        const record = asRecord(tool, "tool");
        assert.equal(typeof record.name, "string");
        return record.name as string;
      });
    };

    await run({ call, listTools, store });
  } finally {
    for (const timer of timers) clearTimeout(timer);
    await mcpRef.current?.close();
    await rm(temp, { recursive: true, force: true });
  }
}

function seedPack(): SourcePack {
  return {
    pack_id: SEED_ID,
    query: "Seed pack for source additions",
    created_at: "2026-03-01T00:00:00.000Z",
    sources: [],
    coverage_map: [],
    limitations: [],
  };
}

function assertPack(value: unknown): SourcePack {
  return sourcePackSchema.parse(value);
}

void test("tools/list exposes exactly the five source-pack tools", async () => {
  await withTools({ env: { SEARCH_API_URL: undefined } }, async ({ listTools }) => {
    const names = await listTools();
    assert.deepEqual(names.sort(), ["pack_add_source", "pack_build", "pack_get", "pack_list", "pack_search"]);
  });
});

void test("pack_build packs fixture pages, filters discovery noise, and records limits", async () => {
  await withTools({ env: { MAX_SOURCES_PER_PACK: "8" } }, async ({ call }) => {
    const outcome = await call("pack_build", { query: "heat pumps", max_sources: 4, search_depth: "quick" });
    const pack = assertPack(payload(outcome).pack);
    assert.equal(pack.query, "heat pumps");
    assert.deepEqual(
      pack.sources.map((source) => source.url),
      [
        "https://alpha.example/article",
        "https://beta.example/article",
        "https://contested.example/article",
      ],
    );
    assert.deepEqual(
      pack.sources.map((source) => source.domain),
      ["alpha.example", "beta.example", "contested.example"],
    );
    assert.equal(pack.sources[0]?.title, "Alpha heat pump briefing");
    assert.ok(pack.sources[0]?.facts.some((fact) => fact.fact === HEAT_FACT && fact.confidence === "high"));
    assert.ok(pack.sources[1]?.facts.some((fact) => fact.fact === HEAT_FACT));
    assert.ok(pack.sources[2]?.facts.some((fact) => fact.fact === CONTESTED_FACT));
    assert.ok(pack.sources.every((source) => source.facts.some((fact) => fact.fact === AGENCY_FACT)));
    assert.ok(pack.sources[0]?.quotes.some((quote) => quote.text === "Household heating costs fell after the switch."));
    assert.ok(pack.sources[0]?.numbers.some((item) => item.value === "12" && item.unit === "million"));
    assert.ok(pack.sources[2]?.numbers.some((item) => item.value === "9" && item.unit === "million"));
    assert.ok(pack.sources[0]?.dates.some((item) => item.date === "2024"));
    assert.deepEqual(pack.sources[0]?.primary_links, ["https://primary.example/datasets/heat-pumps"]);
    assert.ok(pack.sources.every((source) => !source.primary_links.some((link) => link.includes("ads.example"))));

    const contested = pack.coverage_map.find((entry) => entry.claim === HEAT_FACT || entry.claim === CONTESTED_FACT);
    assert.ok(contested, JSON.stringify(pack.coverage_map));
    assert.equal(contested?.status, "contested");
    assert.deepEqual(contested?.mentioned_by, ["alpha.example", "beta.example", "contested.example"]);
    assert.deepEqual(contested?.contested_by, ["alpha.example", "beta.example", "contested.example"]);
    const consistent = pack.coverage_map.find((entry) => entry.claim === AGENCY_FACT);
    assert.equal(consistent?.status, "consistent");

    const limitations = pack.limitations.join("\n");
    assert.match(limitations, /Source discovery used search_api\./u);
    assert.doesNotMatch(limitations, /was shallow/u);
    assert.match(limitations, /1 source\(s\) could not be fetched or extracted/u);
    assert.match(limitations, /denied\.example\/private/u);
    assert.match(limitations, /robots\.txt/u);
    assert.doesNotMatch(limitations, /missing\.example|127\.0\.0\.1|gamma\.example|duckduckgo|bing\.com|ignored\.example/u);
    assert.match(limitations, /1 claim\(s\) show differing numbers across sources \(status: contested\)/u);
    assert.match(limitations, /confidence labels reflect extraction certainty only/u);

    const stored = assertPack(payload(await call("pack_get", { pack_id: pack.pack_id })).pack);
    assert.equal(stored.pack_id, pack.pack_id);
    const search = payload(await call("pack_search", { query: "million homes", limit: 10 }));
    const results = search.results;
    assert.ok(Array.isArray(results));
    assert.equal(results.length, 1);
    const listed = payload(await call("pack_list", { limit: 10 }));
    assert.ok(Array.isArray(listed.packs));
    assert.equal(listed.packs.length, 1);
    assert.equal(asRecord(listed.packs[0], "summary").source_count, 3);
  });
});

void test("pack_build applies the server source cap and extraction depth limits", async () => {
  await withTools({ env: { MAX_SOURCES_PER_PACK: "2" } }, async ({ call }) => {
    const capped = assertPack(payload(await call("pack_build", { query: "heat pumps", max_sources: 6, search_depth: "deep" })).pack);
    assert.deepEqual(
      capped.sources.map((source) => source.url),
      ["https://alpha.example/article", "https://beta.example/article"],
    );
    assert.doesNotMatch(capped.limitations.join("\n"), /could not be fetched|was shallow/u);
    const consistent = capped.coverage_map.find((entry) => entry.claim === HEAT_FACT);
    assert.equal(consistent?.status, "consistent");
    assert.deepEqual(consistent?.mentioned_by, ["alpha.example", "beta.example"]);
  });

  await withTools({}, async ({ call }) => {
    const quick = assertPack(
      payload(await call("pack_build", { query: "overflow trials", max_sources: 2, search_depth: "quick" })).pack,
    );
    const deep = assertPack(
      payload(await call("pack_build", { query: "overflow trials", max_sources: 2, search_depth: "deep" })).pack,
    );
    assert.equal(quick.sources[0]?.facts.length, 8);
    assert.equal(deep.sources[0]?.facts.length, 12);
    assert.equal(quick.sources[0]?.primary_links.length, 10);
    assert.equal(deep.sources[0]?.primary_links.length, 12);
    assert.ok(quick.sources[0]?.primary_links.every((link) => !link.includes("ads.example")));
    assert.match(quick.limitations.join("\n"), /was shallow/u);
  });
});

void test("pack_build keeps an empty pack when discovery finds nothing and records per-source failures", async () => {
  await withTools({}, async ({ call }) => {
    const empty = assertPack(payload(await call("pack_build", { query: "nothing known", max_sources: 4 })).pack);
    assert.equal(empty.sources.length, 0);
    const emptyNotes = empty.limitations.join("\n");
    assert.match(emptyNotes, /Search API returned no usable URLs \(HTTP 200\)/u);
    assert.match(emptyNotes, /was shallow/u);
    assert.match(emptyNotes, /No sources were successfully fetched/u);

    const failed = assertPack(payload(await call("pack_build", { query: "recorded failures", max_sources: 3 })).pack);
    assert.equal(failed.sources.length, 0);
    const notes = failed.limitations.join("\n");
    assert.match(notes, /3 source\(s\) could not be fetched or extracted/u);
    assert.match(notes, /missing\.example\/gone/u);
    assert.match(notes, /HTTP 404/u);
    assert.match(notes, /127\.0\.0\.1\/secret/u);
    assert.match(notes, /private or reserved address/u);
    assert.match(notes, /down\.example\/page/u);
    assert.match(notes, /HTTP 503/u);
    assert.equal(failed.coverage_map.length, 0);
  });
});

void test("pack_build rejects queries, source counts and depths outside the tool schema", async () => {
  await withTools({}, async ({ call }) => {
    await assertInputError(await call("pack_build", { max_sources: 1 }), "query");
    await assertInputError(await call("pack_build", { query: "" }), "query");
    await assertInputError(await call("pack_build", { query: "   " }), "query");
    await assertInputError(await call("pack_build", { query: "q".repeat(501) }), "query");
    await assertInputError(await call("pack_build", { query: "heat pumps", max_sources: 0 }), "max_sources");
    await assertInputError(await call("pack_build", { query: "heat pumps", max_sources: 51 }), "max_sources");
    await assertInputError(await call("pack_build", { query: "heat pumps", max_sources: 1.5 }), "max_sources");
    await assertInputError(await call("pack_build", { query: "heat pumps", search_depth: "medium" }), "search_depth");

    const atQueryCap = assertPack(payload(await call("pack_build", { query: "q".repeat(500), max_sources: 1 })).pack);
    assert.equal(atQueryCap.query.length, 500);
    assert.equal(atQueryCap.sources.length, 0);
    const atSourceCap = assertPack(
      payload(await call("pack_build", { query: "nothing known", max_sources: 50, search_depth: "deep" })).pack,
    );
    assert.equal(atSourceCap.sources.length, 0);
  });
});

void test("pack_add_source packs a fixture page, replaces the same URL, and rebuilds coverage", async () => {
  await withTools({ seed: true }, async ({ call }) => {
    const first = assertPack(
      payload(await call("pack_add_source", { pack_id: SEED_ID, url: "https://alpha.example/article", search_depth: "quick" })).pack,
    );
    assert.equal(first.sources.length, 1);
    assert.equal(first.sources[0]?.url, "https://alpha.example/article");
    assert.ok(first.limitations.some((line) => line.includes("augmented via pack_add_source")));
    assert.match(first.limitations.join("\n"), /Only one source was fetched/u);

    const replaced = assertPack(
      payload(await call("pack_add_source", { pack_id: SEED_ID, url: "https://alpha.example/article" })).pack,
    );
    assert.equal(replaced.sources.length, 1);

    const both = assertPack(
      payload(await call("pack_add_source", { pack_id: SEED_ID, url: "https://beta.example/article", search_depth: "deep" })).pack,
    );
    assert.deepEqual(
      both.sources.map((source) => source.url).sort(),
      ["https://alpha.example/article", "https://beta.example/article"],
    );
    const consistent = both.coverage_map.find((entry) => entry.claim === HEAT_FACT);
    assert.equal(consistent?.status, "consistent");
    assert.deepEqual(consistent?.mentioned_by, ["alpha.example", "beta.example"]);
    assert.equal(consistent?.contested_by.length, 0);
  });
});

void test("pack_add_source honours quick and deep extraction limits", async () => {
  await withTools({ seed: true }, async ({ call }) => {
    const quick = assertPack(
      payload(await call("pack_add_source", { pack_id: SEED_ID, url: "https://overflow.example/article", search_depth: "quick" })).pack,
    );
    assert.equal(quick.sources[0]?.facts.length, 8);
    assert.equal(quick.sources[0]?.primary_links.length, 10);
  });
  await withTools({ seed: true }, async ({ call }) => {
    const deep = assertPack(
      payload(await call("pack_add_source", { pack_id: SEED_ID, url: "https://overflow.example/article", search_depth: "deep" })).pack,
    );
    assert.equal(deep.sources[0]?.facts.length, 12);
    assert.equal(deep.sources[0]?.primary_links.length, 12);
  });
});

void test("pack_add_source returns stable errors and leaves the saved pack unchanged", async () => {
  await withTools({ seed: true, timeoutMs: 200, maxBodyBytes: 1_024, env: { FETCH_MAX_BODY_BYTES: "1024" } }, async ({ call }) => {
    const cases: Array<{ args: Record<string, unknown>; code: string; retryable: boolean; detail: string }> = [
      {
        args: { pack_id: "12345678-1234-4234-8234-123456789abc", url: "https://alpha.example/article" },
        code: "PACK_NOT_FOUND",
        retryable: false,
        detail: "12345678-1234-4234-8234-123456789abc",
      },
      {
        args: { pack_id: SEED_ID, url: "https://denied.example/private" },
        code: "ROBOTS_DISALLOWED",
        retryable: false,
        detail: "https://denied.example/private",
      },
      {
        args: { pack_id: SEED_ID, url: "https://missing.example/gone" },
        code: "UPSTREAM_HTTP_ERROR",
        retryable: false,
        detail: "404",
      },
      {
        args: { pack_id: SEED_ID, url: "https://down.example/page" },
        code: "UPSTREAM_HTTP_ERROR",
        retryable: true,
        detail: "503",
      },
      {
        args: { pack_id: SEED_ID, url: "http://127.0.0.1/admin" },
        code: "URL_BLOCKED",
        retryable: false,
        detail: "127.0.0.1",
      },
      {
        args: { pack_id: SEED_ID, url: "https://private.example/admin" },
        code: "URL_BLOCKED",
        retryable: false,
        detail: "10.1.2.3",
      },
      {
        args: { pack_id: SEED_ID, url: "https://redirect.example/hop" },
        code: "URL_BLOCKED",
        retryable: false,
        detail: "127.0.0.1",
      },
      {
        args: { pack_id: SEED_ID, url: "https://dns-fail.example/page" },
        code: "UPSTREAM_NETWORK_ERROR",
        retryable: true,
        detail: "https://dns-fail.example/page",
      },
      {
        args: { pack_id: SEED_ID, url: "https://network.example/page" },
        code: "UPSTREAM_NETWORK_ERROR",
        retryable: true,
        detail: "https://network.example/page",
      },
      {
        args: { pack_id: SEED_ID, url: "https://stall.example/wait" },
        code: "UPSTREAM_TIMEOUT",
        retryable: true,
        detail: "200",
      },
      {
        args: { pack_id: SEED_ID, url: "https://huge.example/page" },
        code: "RESPONSE_TOO_LARGE",
        retryable: false,
        detail: "1024",
      },
    ];

    for (const item of cases) {
      const error = assertErrorCode(await call("pack_add_source", item.args), item.code);
      assert.equal(error.retryable, item.retryable, item.code);
      assert.match(String(error.message), new RegExp(item.detail.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
      const stored = assertPack(payload(await call("pack_get", { pack_id: SEED_ID })).pack);
      assert.equal(stored.sources.length, 0, item.code);
    }
  });
});

void test("pack_add_source rejects malformed ids, schemes and over-long URLs before fetching", async () => {
  await withTools({ seed: true }, async ({ call }) => {
    await assertInputError(await call("pack_add_source", { url: "https://alpha.example/article" }), "pack_id");
    await assertInputError(await call("pack_add_source", { pack_id: "../etc/passwd", url: "https://alpha.example/article" }), "pack_id");
    await assertInputError(await call("pack_add_source", { pack_id: SEED_ID, url: "not a url" }), "url");
    await assertInputError(
      await call("pack_add_source", { pack_id: SEED_ID, url: "ftp://files.example/report.pdf" }),
      "URL must use http or https",
    );
    await assertInputError(await call("pack_add_source", { pack_id: SEED_ID, url: `https://alpha.example/${"a".repeat(2_048)}` }), "url");
    await assertInputError(await call("pack_add_source", { pack_id: SEED_ID, url: "https://alpha.example/article", search_depth: "medium" }), "search_depth");
    const stored = assertPack(payload(await call("pack_get", { pack_id: SEED_ID })).pack);
    assert.equal(stored.sources.length, 0);
  });
});

void test("pack_get returns a fixture pack and treats missing or unreadable files as not found", async () => {
  await withTools({ packsDir: path.join(fixturesRoot(), "packs"), env: { SEARCH_API_URL: undefined } }, async ({ call }) => {
    const pack = assertPack(payload(await call("pack_get", { pack_id: STORAGE_ID })).pack);
    assert.equal(pack.query, "kilowatt storage review shared-topic");
    assert.equal(pack.sources.length, 1);
    assert.equal(pack.sources[0]?.facts[0]?.fact.startsWith("Stored kilowatt readings"), true);

    const missing = assertErrorCode(await call("pack_get", { pack_id: "12345678-1234-4234-8234-123456789abc" }), "PACK_NOT_FOUND");
    assert.equal(missing.retryable, false);
    assert.deepEqual(missing.details, { pack_id: "12345678-1234-4234-8234-123456789abc" });

    const mismatched = assertErrorCode(await call("pack_get", { pack_id: MISMATCH_ID }), "PACK_NOT_FOUND");
    assert.equal(asRecord(mismatched.details, "details").pack_id, MISMATCH_ID);

    await assertInputError(await call("pack_get", {}), "pack_id");
    await assertInputError(await call("pack_get", { pack_id: "not-a-uuid" }), "pack_id");
  });
});

void test("pack_list filters unreadable fixture files and honours the limit", async () => {
  await withTools({ packsDir: path.join(fixturesRoot(), "packs"), env: { SEARCH_API_URL: undefined } }, async ({ call }) => {
    const listed = payload(await call("pack_list", {}));
    const packs = listed.packs;
    assert.ok(Array.isArray(packs));
    assert.deepEqual(
      packs.map((entry) => asRecord(entry, "summary").pack_id),
      [STORAGE_ID, WIND_ID],
    );
    assert.equal(asRecord(packs[0], "newest").source_count, 1);
    assert.equal(asRecord(packs[0], "newest").query, "kilowatt storage review shared-topic");

    const limited = payload(await call("pack_list", { limit: 1 }));
    assert.ok(Array.isArray(limited.packs));
    assert.deepEqual(limited.packs.map((entry) => asRecord(entry, "summary").pack_id), [STORAGE_ID]);

    const wide = payload(await call("pack_list", { limit: 200 }));
    assert.ok(Array.isArray(wide.packs));
    assert.equal(wide.packs.length, 2);

    await assertInputError(await call("pack_list", { limit: 0 }), "limit");
    await assertInputError(await call("pack_list", { limit: 201 }), "limit");
    await assertInputError(await call("pack_list", { limit: 1.2 }), "limit");
  });
});

void test("pack_search filters fixture text, caps snippets, and honours query and result limits", async () => {
  await withTools({ packsDir: path.join(fixturesRoot(), "packs"), env: { SEARCH_API_URL: undefined } }, async ({ call }) => {
    const found = payload(await call("pack_search", { query: "KILOWATT" }));
    assert.equal(found.query, "KILOWATT");
    const hits = found.results;
    assert.ok(Array.isArray(hits));
    assert.equal(hits.length, 1);
    const hit = asRecord(hits[0], "hit");
    assert.equal(hit.pack_id, STORAGE_ID);
    const snippets = hit.snippets;
    assert.ok(Array.isArray(snippets));
    assert.equal(snippets.length, 5);
    assert.equal(snippets[0], "kilowatt storage review shared-topic");
    assert.equal(snippets[1], "Coastal kilowatt storage notes");
    const shortened = snippets[2];
    assert.equal(typeof shortened, "string");
    assert.equal(shortened.length, 200);
    assert.ok(shortened.startsWith("Stored kilowatt readings"));
    assert.ok(shortened.endsWith(ELLIPSIS));
    assert.ok(!snippets.includes("A kilowatt audit started on that morning."));
    assert.ok(!snippets.includes("Unmatched coverage claim about a kilowatt gap in the archive."));

    const deduped = payload(await call("pack_search", { query: "wind turbine maintenance shared-topic", limit: 10 }));
    const dedupedHits = deduped.results;
    assert.ok(Array.isArray(dedupedHits));
    assert.equal(dedupedHits.length, 1);
    const windSnippets = asRecord(dedupedHits[0], "wind").snippets;
    assert.deepEqual(windSnippets, ["wind turbine maintenance shared-topic"]);

    const ignored = payload(await call("pack_search", { query: "link-only-token", limit: 10 }));
    assert.deepEqual(ignored.results, []);
    const ignoredLimitation = payload(await call("pack_search", { query: "limitation-only-token", limit: 10 }));
    assert.deepEqual(ignoredLimitation.results, []);

    const one = payload(await call("pack_search", { query: "shared-topic", limit: 1 }));
    assert.ok(Array.isArray(one.results));
    assert.equal(one.results.length, 1);
    const both = payload(await call("pack_search", { query: "shared-topic", limit: 100 }));
    assert.ok(Array.isArray(both.results));
    assert.equal(both.results.length, 2);

    const atCap = payload(await call("pack_search", { query: "z".repeat(200), limit: 1 }));
    assert.deepEqual(atCap.results, []);

    await assertInputError(await call("pack_search", {}), "query");
    await assertInputError(await call("pack_search", { query: "" }), "query");
    await assertInputError(await call("pack_search", { query: "   " }), "query");
    await assertInputError(await call("pack_search", { query: "heat", limit: 0 }), "limit");
    await assertInputError(await call("pack_search", { query: "heat", limit: 101 }), "limit");
    await assertInputError(await call("pack_search", { query: "q".repeat(201) }), "query");
  });
});

void test("pack_list and pack_search on an empty directory return no rows", async () => {
  await withTools({ env: { SEARCH_API_URL: undefined } }, async ({ call }) => {
    const listed = payload(await call("pack_list", { limit: 10 }));
    assert.deepEqual(listed.packs, []);
    const found = payload(await call("pack_search", { query: "heat pumps", limit: 10 }));
    assert.deepEqual(found.results, []);
    const missing = assertErrorCode(await call("pack_get", { pack_id: SEED_ID }), "PACK_NOT_FOUND");
    assert.equal(missing.category, "not_found");
  });
});
