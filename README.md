# source-pack-mcp

A local-first [Model Context Protocol](https://modelcontextprotocol.io) server that turns fetched public web pages into structured research source packs: source-linked candidate facts, quotations, numbers, dates, outbound primary links, coverage signals, and explicit limitations.

## Why this exists / strategic value

Agents are good at gathering pages but poor at preserving an auditable research trail. `source-pack-mcp` converts transient browsing into a durable JSON artifact that another agent, knowledge system, or human reviewer can inspect, search, and reuse.

Its strategic role is the evidence-assembly layer in a local-first agent stack: source material stays on the operator's machine, every extracted item remains attached to its URL, and uncertainty travels with the pack instead of disappearing into a prose answer.

## Verification boundaries

This server verifies that content was fetched from the recorded URL at the recorded time. It does **not** verify that a publisher is authoritative or that an extracted claim is true.

- Facts, numbers, dates, and quotes are candidate evidence extracted with transparent heuristics.
- A fact's `confidence` describes extraction certainty, not factual truth.
- `consistent` means similar claims appeared on multiple domains; it is not proof of independent corroboration.
- `contested` currently flags differing numbers in otherwise similar claims; it is not a complete contradiction detector.
- Discovery is best-effort and may be shallow. Failed fetches and extraction limits are recorded in `limitations`.
- A stale cached page may be used when a live request fails; `retrieved_at` retains the original fetch time.

Agents should cite the attached URLs and review consequential claims against primary sources.

## Relationship to website-content-mcp

[`website-content-mcp`](https://github.com/SarutobiSasuke8/website-content-mcp) is the acquisition layer for crawling or capturing content from known websites. `source-pack-mcp` is the evidence-assembly layer: it organizes selected URLs into a query-specific, persisted pack and compares claim coverage across sources.

Use them together when acquisition needs more control: discover or curate URLs with `website-content-mcp`, then pass the strongest URLs to `pack_add_source`. `pack_build` retains lightweight, best-effort discovery so `source-pack-mcp` can also run on its own.

## MCP tools

| Tool | Inputs | Behavior |
| --- | --- | --- |
| `pack_build` | `query`, `max_sources` (1-50), `search_depth` (`quick` or `deep`) | Discovers, fetches, extracts, stores, and returns a new source pack. |
| `pack_add_source` | `pack_id`, HTTP(S) `url`, `search_depth` | Adds or replaces one URL in a pack and rebuilds its coverage map. |
| `pack_get` | `pack_id` | Returns a stored pack. |
| `pack_list` | `limit` (1-200) | Lists recent pack summaries, newest first. |
| `pack_search` | `query`, `limit` (1-100) | Searches stored pack text and returns matching snippets. |

`pack_get`, `pack_list`, and `pack_search` are read-only. `pack_build` and `pack_add_source` write JSON files beneath `PACKS_DIR`; none of the tools delete data.

## Source-pack shape

```json
{
  "pack_id": "uuid",
  "query": "string",
  "created_at": "ISO timestamp",
  "sources": [
    {
      "url": "https://example.com/source",
      "title": "string",
      "domain": "example.com",
      "retrieved_at": "ISO timestamp",
      "facts": [{ "fact": "string", "confidence": "high|medium|low" }],
      "quotes": [{ "text": "string", "context": "string" }],
      "numbers": [{ "value": "string", "unit": "string", "context": "string" }],
      "dates": [{ "date": "string", "event": "string" }],
      "primary_links": ["https://example.org/primary"]
    }
  ],
  "coverage_map": [
    {
      "claim": "string",
      "mentioned_by": ["example.com"],
      "contested_by": [],
      "status": "consistent|contested|isolated"
    }
  ],
  "limitations": ["string"]
}
```

## Install from source

Requirements: Node.js 22+ and npm.

```bash
git clone https://github.com/SarutobiSasuke8/source-pack-mcp.git
cd source-pack-mcp
npm ci
npm run check
```

Build the server:

```bash
npm run build
```

### Stdio transport (recommended for local MCP clients)

Register the compiled stdio entry point with an absolute path:

```json
{
  "mcpServers": {
    "source-pack": {
      "command": "node",
      "args": ["/absolute/path/to/source-pack-mcp/dist/src/stdio.js"],
      "env": {
        "PACKS_DIR": "/absolute/path/to/source-pack-data/packs",
        "CACHE_DIR": "/absolute/path/to/source-pack-data/cache"
      }
    }
  }
}
```

### Streamable HTTP transport

```bash
npm run start
curl http://127.0.0.1:3225/healthz
```

The MCP endpoint is `http://127.0.0.1:3225/mcp`. It intentionally has no application-level authentication and binds to loopback by default; read [SECURITY.md](SECURITY.md) before changing `HOST` or exposing it through a network.

### Verify a packed artifact

```bash
npm run smoke:mcp
npm run pack:check
```

`smoke:mcp` performs a real stdio MCP initialize handshake and asserts the five expected tools. `pack:check` builds the package and shows the exact files that would be published.

## Configuration

Copy `.env.example` or supply environment variables directly.

| Variable | Default | Purpose |
| --- | --- | --- |
| `MAX_SOURCES_PER_PACK` | `8` | Server-side maximum sources per pack (1-50). |
| `FETCH_TIMEOUT_MS` | `15000` | Timeout for each outbound request. |
| `FETCH_MIN_INTERVAL_MS` | `1000` | Minimum delay between serialized outbound requests. |
| `FETCH_MAX_BODY_BYTES` | `5242880` | Maximum response body size in bytes; larger responses fail with `RESPONSE_TOO_LARGE`. |
| `SEARCH_API_URL` | unset | Optional JSON search endpoint; DuckDuckGo HTML discovery is the fallback. |
| `USER_AGENT` | project user agent | User-Agent sent with outbound requests. |
| `CACHE_DIR` | `.cache` | Local fetched-page cache directory. |
| `CACHE_TTL_SECONDS` | `3600` | Fresh-cache lifetime; `0` disables fresh cache hits. |
| `PACKS_DIR` | `.packs` | Local JSON source-pack directory. |
| `HOST` | `127.0.0.1` | HTTP bind host. |
| `PORT` | `3225` | HTTP port. |

Relative data paths resolve from the server process's working directory. Use absolute paths in long-lived MCP client configurations.

Pack storage validates records on read and write. Malformed JSON, invalid records and files whose name does not match their `pack_id` are skipped by listing and search; direct retrieval treats them as unavailable. Their files are left in place for inspection. Updates replace the saved file atomically, so readers see a complete old or new version.

Concurrent `pack_add_source` calls merge into the latest saved pack through a per-pack write queue. Run only one server process per `PACKS_DIR`: the queue belongs to that process's shared `PackStore`, and does not coordinate separate HTTP/stdio processes or external writers.

## Error contract

Tool failures keep a human-readable text message for compatibility and also return a stable `structuredContent` envelope:

```json
{
  "error": {
    "schema_version": "1",
    "code": "PACK_NOT_FOUND",
    "category": "not_found",
    "message": "No pack found with pack_id '...'.",
    "retryable": false,
    "details": { "pack_id": "..." }
  }
}
```

Current codes are `PACK_NOT_FOUND`, `ROBOTS_DISALLOWED`, `URL_BLOCKED`, `RESPONSE_TOO_LARGE`, `UPSTREAM_HTTP_ERROR`, `UPSTREAM_NETWORK_ERROR`, `UPSTREAM_TIMEOUT`, and `INTERNAL_ERROR`. Unknown internal failures are sanitized; upstream errors indicate whether retrying may help.

## Development and release checks

```bash
npm run typecheck
npm run lint
npm test
npm run check
npm run smoke:mcp
npm run pack:check
```

The live integration test is opt-in: it is skipped unless `RUN_LIVE_TESTS=1` is set, so `npm run check` and CI are hermetic by default. Outbound fetches are SSRF-guarded: only http/https URLs are allowed, hostnames resolving to loopback, private (RFC1918), link-local, or other reserved addresses are refused (`URL_BLOCKED`), and redirects are re-validated hop by hop. CI runs the full check, the MCP handshake, the package dry-run, and a high-severity dependency audit. Version tags (`v*`) produce a tested `.tgz` workflow artifact; publishing remains an explicit maintainer decision.

## License

[MIT](LICENSE)
