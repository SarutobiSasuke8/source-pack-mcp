# Security policy

## Supported versions

Security fixes are applied to the latest release line. Until the project reaches 1.0, only the most recent `0.x` version is supported.

| Version | Supported |
| --- | --- |
| 0.1.x | Yes |
| Earlier versions | No |

## Reporting a vulnerability

Please use [GitHub private vulnerability reporting](https://github.com/SarutobiSasuke8/source-pack-mcp/security/advisories/new). Include the affected version, reproduction steps, impact, and any suggested mitigation. Do not open a public issue until a fix or coordinated disclosure plan is available.

You should receive an acknowledgement within seven days. Valid reports will be triaged, fixed on the supported release line, and credited if the reporter wants attribution.

## Deployment assumptions

`source-pack-mcp` is a local-first research tool, not a hardened public crawling service. It accepts URLs, makes outbound requests, and writes fetched material and source packs to local disk. Operate it with these boundaries:

- Keep the default loopback bind (`127.0.0.1`). If you expose the HTTP transport, add authentication, authorization, request limits, and network egress controls in front of it.
- Treat all fetched content as untrusted data. Do not execute content from a source pack or render it as trusted HTML.
- Restrict outbound network access when processing untrusted tool calls. URL fetching can otherwise be used to probe services reachable from the host.
- Store `CACHE_DIR` and `PACKS_DIR` in a location accessible only to the intended local user or service account.
- No API key is required by the server itself. If a configured search service embeds credentials in `SEARCH_API_URL`, protect the environment and logs accordingly.

The robots.txt check is a courtesy and policy control, not an authorization mechanism or a complete implementation of every crawler directive.
