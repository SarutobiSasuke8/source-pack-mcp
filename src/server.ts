import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import { PackNotFoundError, toErrorEnvelope } from "./errors.js";

import type { CallToolResult } from "@modelcontextprotocol/server";
import type { PackService } from "./service.js";

function jsonResult(value: Record<string, unknown>): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
    structuredContent: value,
  };
}

export function errorResult(error: unknown): CallToolResult {
  const envelope = toErrorEnvelope(error);
  return {
    isError: true,
    content: [{ type: "text", text: envelope.error.message }],
    structuredContent: envelope,
  };
}

async function runTool(
  operation: () => Promise<Record<string, unknown>> | Record<string, unknown>,
): Promise<CallToolResult> {
  try {
    return jsonResult(await operation());
  } catch (error) {
    return errorResult(error);
  }
}

const queryInput = z.string().trim().min(1).max(500);
const urlInput = z
  .string()
  .trim()
  .url()
  .max(2_048)
  .refine(
    (value) => {
      try {
        return ["http:", "https:"].includes(new URL(value).protocol);
      } catch {
        return false;
      }
    },
    { message: "URL must use http or https." },
  );
const packIdInput = z.string().trim().uuid();

export function createSourcePackMcpServer(service: PackService): McpServer {
  const server = new McpServer({ name: "source-pack-mcp", version: "0.1.0" });

  server.registerTool(
    "pack_build",
    {
      title: "Build a source pack",
      description:
        "Build a structured research source pack for a topic or question. Discovers public sources, fetches them (robots-respecting, rate-limited), and extracts facts, quotes, numbers, dates and primary links, plus a coverage map (consistent/contested/isolated) and honest limitations. Returns the full pack including its pack_id.",
      inputSchema: z.object({
        query: queryInput,
        max_sources: z.number().int().min(1).max(50).default(8),
        search_depth: z.enum(["quick", "deep"]).default("quick"),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ query, max_sources, search_depth }) =>
      runTool(async () => ({ pack: await service.buildPack(query, max_sources, search_depth) })),
  );

  server.registerTool(
    "pack_add_source",
    {
      title: "Add a source to a pack",
      description:
        "Fetch and extract a specific HTTP(S) URL and add it to an existing pack (by pack_id). Useful when the agent already has a source in mind. Rebuilds the coverage map and returns the updated pack.",
      inputSchema: z.object({
        pack_id: packIdInput,
        url: urlInput,
        search_depth: z.enum(["quick", "deep"]).default("quick"),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ pack_id, url, search_depth }) =>
      runTool(async () => ({ pack: await service.addSource(pack_id, url, search_depth) })),
  );

  server.registerTool(
    "pack_get",
    {
      title: "Get a pack by id",
      description: "Retrieve a previously built source pack by its pack_id.",
      inputSchema: z.object({ pack_id: packIdInput }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    async ({ pack_id }) =>
      runTool(async () => {
        const pack = await service.getPack(pack_id);
        if (!pack) throw new PackNotFoundError(pack_id);
        return { pack };
      }),
  );

  server.registerTool(
    "pack_list",
    {
      title: "List recent packs",
      description: "List recently built packs (pack_id, query, created_at, source count), newest first.",
      inputSchema: z.object({ limit: z.number().int().min(1).max(200).default(50) }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    async ({ limit }) => runTool(async () => ({ packs: await service.listPacks(limit) })),
  );

  server.registerTool(
    "pack_search",
    {
      title: "Search stored packs",
      description:
        "Keyword search over the text of previously built packs (queries, facts, quotes, numbers, dates, coverage claims). Returns matching pack summaries with matched snippets.",
      inputSchema: z.object({
        query: z.string().trim().min(1).max(200),
        limit: z.number().int().min(1).max(100).default(10),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    async ({ query, limit }) =>
      runTool(async () => ({ query, results: await service.searchPacks(query, limit) })),
  );

  return server;
}
