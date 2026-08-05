#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";

import { loadConfig } from "./config.js";
import { createRuntime } from "./runtime.js";
import { createSourcePackMcpServer } from "./server.js";

const config = loadConfig();
const { service } = createRuntime(config);
const mcpServer = createSourcePackMcpServer(service);
const transport = new StdioServerTransport(process.stdin, process.stdout);
await mcpServer.connect(transport);

async function shutdown(): Promise<void> {
  await mcpServer.close();
}

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
