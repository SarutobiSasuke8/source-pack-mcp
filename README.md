# source-pack-mcp

An [MCP](https://modelcontextprotocol.io) server that produces a structured **research source pack** for a topic or question. Instead of an agent rummaging through search results and raw pages, it returns verified-at-source facts, quotes, key numbers, dates, primary links, and a coverage map of what's been said — as clean structured data.

## What a source pack looks like

```json
{
  "pack_id": "uuid",
  "query": "string",
  "created_at": "ISO timestamp",
  "sources": [
    {
      "url": "string",
      "title": "string",
      "domain": "string",
      "retrieved_at": "ISO timestamp",
      "facts": [{"fact": "string", "confidence": "high|medium|low"}],
      "quotes": [{"text": "string", "context": "string"}],
      "numbers": [{"value": "string", "unit": "string", "context": "string"}],
      "dates": [{"date": "string", "event": "string"}],
      "primary_links": ["string"]
    }
  ],
  "coverage_map": [
    {"claim": "string", "mentioned_by": ["domain"], "contested_by": ["domain"], "status": "consistent|contested|isolated"}
  ],
  "limitations": ["string"]
}
```

Facts are extracted from actually-fetched sources, with the URL attached and a confidence label. The server never invents facts and never claims verification it didn't perform. `coverage_map` compares claims across sources: consistent, contested, or isolated.

## Tools

| Tool | Purpose |
|------|---------|
| `pack_build` | Build a source pack for a query (`max_sources`, `search_depth`). |
| `pack_add_source` | Add a specific URL to an existing pack for extraction. |
| `pack_get` | Retrieve a previously built pack by id. |
| `pack_list` | List recent packs (id, query, created_at, source count). |
| `pack_search` | Keyword search across previously built packs. |

## Features

- HTML → clean text via real DOM extraction (Mozilla Readability + Turndown), never regex parsing
- Disk cache with TTL (default 1 hour)
- robots.txt respect, rate-limited fetching (~1 req/sec)
- Packs persisted as JSON in a configurable data dir (`.packs/`)
- Streamable HTTP (default `127.0.0.1:3225`) + stdio transports
- No API keys required, no auth needed for public content, no personal data

## Quick start

Requirements: Node.js 22+

```bash
npm ci
npm run build
PORT=3225 node dist/src/http.js
```

Configure with env vars (see `.env.example`):

| Var | Default | Purpose |
|-----|---------|---------|
| `SITE_BASE_URL` / `MAX_SOURCES_PER_PACK` | 8 | Max sources per pack |
| `FETCH_TIMEOUT_MS` | 15000 | Per-request fetch timeout |
| `FETCH_MIN_INTERVAL_MS` | 1000 | Rate limit between fetches |
| `SEARCH_API_URL` | unset | Optional JSON search API; falls back to HTML search |
| `CACHE_TTL_SECONDS` | 3600 | Page cache TTL |
| `PACKS_DIR` | `.packs/` | Where packs are stored |
| `PORT` | 3225 | HTTP port |

Register in any MCP client:

```json
{
  "mcpServers": {
    "source-pack": {
      "command": "node",
      "args": ["/path/to/source-pack-mcp/dist/src/http.js"],
      "env": { "PORT": "3225" }
    }
  }
}
```

## Development

```bash
npm run check   # typecheck + lint + build + test
npm test        # run tests
```

## License

MIT
