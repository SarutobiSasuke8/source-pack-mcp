/* global clearTimeout, process, setTimeout */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import readline from "node:readline";

const serverEntry = path.resolve("dist/src/stdio.js");
const child = spawn(process.execPath, [serverEntry], {
  env: process.env,
  stdio: ["pipe", "pipe", "pipe"],
});

let stderr = "";
child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk) => {
  stderr += chunk;
});

const lines = readline.createInterface({ input: child.stdout });
const pending = new Map();

lines.on("line", (line) => {
  if (!line.trim()) return;
  try {
    const message = JSON.parse(line);
    const settle = pending.get(message.id);
    if (settle) {
      pending.delete(message.id);
      settle.resolve(message);
    }
  } catch (error) {
    for (const settle of pending.values()) settle.reject(error);
    pending.clear();
  }
});

function send(message) {
  child.stdin.write(`${JSON.stringify(message)}\n`);
}

function responseFor(id) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Timed out waiting for MCP response ${id}.${stderr ? ` stderr: ${stderr}` : ""}`));
    }, 10_000);
    pending.set(id, {
      resolve: (message) => {
        clearTimeout(timeout);
        resolve(message);
      },
      reject: (error) => {
        clearTimeout(timeout);
        reject(error);
      },
    });
  });
}

try {
  const initializedResponse = responseFor(1);
  send({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "source-pack-smoke", version: "1.0.0" },
    },
  });
  const initialized = await initializedResponse;
  assert.equal(initialized.result?.serverInfo?.name, "source-pack-mcp");

  send({ jsonrpc: "2.0", method: "notifications/initialized" });
  const toolsResponse = responseFor(2);
  send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  const listed = await toolsResponse;
  const actual = listed.result?.tools?.map((tool) => tool.name).sort();
  const expected = ["pack_add_source", "pack_build", "pack_get", "pack_list", "pack_search"];
  assert.deepEqual(actual, expected);

  process.stdout.write(`MCP stdio smoke check passed (${expected.length} tools).\n`);
} finally {
  lines.close();
  child.stdin.end();
  child.kill();
}
