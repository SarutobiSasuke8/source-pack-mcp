import assert from "node:assert/strict";
import test from "node:test";

import {
  PackNotFoundError,
  RobotsDisallowedError,
  toErrorEnvelope,
  UpstreamHttpError,
  UpstreamTimeoutError,
} from "../src/errors.js";
import { errorResult } from "../src/server.js";

const PACK_ID = "11111111-2222-4333-8444-555555555555";

void test("known failures expose a stable, actionable error envelope", () => {
  assert.deepEqual(toErrorEnvelope(new PackNotFoundError(PACK_ID)), {
    error: {
      schema_version: "1",
      code: "PACK_NOT_FOUND",
      category: "not_found",
      message: `No pack found with pack_id '${PACK_ID}'.`,
      retryable: false,
      details: { pack_id: PACK_ID },
    },
  });

  const robots = toErrorEnvelope(new RobotsDisallowedError("https://example.com/private"));
  assert.equal(robots.error.code, "ROBOTS_DISALLOWED");
  assert.equal(robots.error.category, "policy_denied");
  assert.equal(robots.error.retryable, false);
});

void test("upstream errors classify whether retrying may help", () => {
  assert.equal(toErrorEnvelope(new UpstreamHttpError("https://example.com", 404)).error.retryable, false);
  assert.equal(toErrorEnvelope(new UpstreamHttpError("https://example.com", 429)).error.retryable, true);
  assert.equal(toErrorEnvelope(new UpstreamHttpError("https://example.com", 503)).error.retryable, true);

  const timeout = toErrorEnvelope(new UpstreamTimeoutError("https://example.com", 1_500));
  assert.equal(timeout.error.code, "UPSTREAM_TIMEOUT");
  assert.deepEqual(timeout.error.details, { url: "https://example.com", timeout_ms: 1_500 });
});

void test("unexpected failures are sanitized instead of leaking internal details", () => {
  const envelope = toErrorEnvelope(new Error("C:\\private\\secrets\\token.txt could not be read"));
  assert.deepEqual(envelope, {
    error: {
      schema_version: "1",
      code: "INTERNAL_ERROR",
      category: "internal",
      message: "The source-pack operation failed unexpectedly.",
      retryable: false,
    },
  });
});

void test("MCP errors retain the legacy text message and add structuredContent", () => {
  const result = errorResult(new PackNotFoundError(PACK_ID));
  assert.equal(result.isError, true);
  assert.equal(result.content[0]?.type, "text");
  if (result.content[0]?.type !== "text") assert.fail("expected text content");
  assert.equal(result.content[0].text, `No pack found with pack_id '${PACK_ID}'.`);
  assert.deepEqual(result.structuredContent, toErrorEnvelope(new PackNotFoundError(PACK_ID)));
});
