#!/usr/bin/env node
import { createMcpExpressApp } from "@modelcontextprotocol/express";
import { NodeStreamableHTTPServerTransport } from "@modelcontextprotocol/node";
import helmet from "helmet";

import { loadConfig } from "./config.js";
import { createRuntime } from "./runtime.js";
import { createSourcePackMcpServer } from "./server.js";

import type { ErrorRequestHandler } from "express";

const config = loadConfig();
const { service } = createRuntime(config);

const mcpServer = createSourcePackMcpServer(service);
const transport = new NodeStreamableHTTPServerTransport({
  sessionIdGenerator: undefined,
  enableJsonResponse: true,
});
await mcpServer.connect(transport);

const app = createMcpExpressApp({ host: config.host, jsonLimit: "1mb" });
app.disable("x-powered-by");
app.use(helmet({ strictTransportSecurity: false, contentSecurityPolicy: false }));

app.get("/healthz", (_request, response) => {
  response.json({ status: "ok", service: "source-pack-mcp" });
});

app.all("/mcp", async (request, response) => {
  await transport.handleRequest(request, response, request.body);
});

app.use((_request, response) => {
  response.status(404).json({ error: "not_found" });
});

const errorHandler: ErrorRequestHandler = (error, _request, response, _next) => {
  void _next;
  process.stderr.write(`Request failed: ${error instanceof Error ? error.message : "unknown error"}\n`);
  if (!response.headersSent) response.status(500).json({ error: "internal_server_error" });
};
app.use(errorHandler);

const httpServer = app.listen(config.port, config.host, () => {
  process.stdout.write(`source-pack-mcp listening on http://${config.host}:${config.port}/mcp\n`);
});
httpServer.requestTimeout = 60_000;
httpServer.headersTimeout = 65_000;
httpServer.keepAliveTimeout = 5_000;

async function shutdown(): Promise<void> {
  httpServer.close();
  await mcpServer.close();
}

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
