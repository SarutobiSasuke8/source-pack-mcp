export const SOURCE_PACK_ERROR_CODES = [
  "PACK_NOT_FOUND",
  "ROBOTS_DISALLOWED",
  "UPSTREAM_HTTP_ERROR",
  "UPSTREAM_NETWORK_ERROR",
  "UPSTREAM_TIMEOUT",
  "INTERNAL_ERROR",
] as const;

export type SourcePackErrorCode = (typeof SOURCE_PACK_ERROR_CODES)[number];
export type SourcePackErrorCategory = "not_found" | "policy_denied" | "upstream" | "internal";
export type ErrorDetails = Readonly<Record<string, string | number | boolean>>;

export interface SourcePackErrorBody {
  schema_version: "1";
  code: SourcePackErrorCode;
  category: SourcePackErrorCategory;
  message: string;
  retryable: boolean;
  details?: ErrorDetails;
}

export type SourcePackErrorEnvelope = { error: SourcePackErrorBody };

interface SourcePackErrorOptions {
  category: SourcePackErrorCategory;
  retryable: boolean;
  details?: ErrorDetails;
  cause?: unknown;
}

/** A safe, stable error that may be returned to MCP clients. */
export class SourcePackError extends Error {
  public readonly code: SourcePackErrorCode;
  public readonly category: SourcePackErrorCategory;
  public readonly retryable: boolean;
  public readonly details?: ErrorDetails;

  public constructor(code: SourcePackErrorCode, message: string, options: SourcePackErrorOptions) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "SourcePackError";
    this.code = code;
    this.category = options.category;
    this.retryable = options.retryable;
    if (options.details) this.details = options.details;
  }
}

export class PackNotFoundError extends SourcePackError {
  public constructor(packId: string) {
    super("PACK_NOT_FOUND", `No pack found with pack_id '${packId}'.`, {
      category: "not_found",
      retryable: false,
      details: { pack_id: packId },
    });
    this.name = "PackNotFoundError";
  }
}

export class RobotsDisallowedError extends SourcePackError {
  public constructor(url: string) {
    super("ROBOTS_DISALLOWED", `Fetching '${url}' is disallowed by the site's robots.txt.`, {
      category: "policy_denied",
      retryable: false,
      details: { url },
    });
    this.name = "RobotsDisallowedError";
  }
}

export class UpstreamHttpError extends SourcePackError {
  public constructor(url: string, status: number) {
    super("UPSTREAM_HTTP_ERROR", `Fetch failed for '${url}' with HTTP ${status}.`, {
      category: "upstream",
      retryable: status === 408 || status === 429 || status >= 500,
      details: { url, status },
    });
    this.name = "UpstreamHttpError";
  }
}

export class UpstreamNetworkError extends SourcePackError {
  public constructor(url: string, cause?: unknown) {
    super("UPSTREAM_NETWORK_ERROR", `Could not reach upstream URL '${url}'.`, {
      category: "upstream",
      retryable: true,
      details: { url },
      cause,
    });
    this.name = "UpstreamNetworkError";
  }
}

export class UpstreamTimeoutError extends SourcePackError {
  public constructor(url: string, timeoutMs: number, cause?: unknown) {
    super("UPSTREAM_TIMEOUT", `Fetch timed out for '${url}' after ${timeoutMs} ms.`, {
      category: "upstream",
      retryable: true,
      details: { url, timeout_ms: timeoutMs },
      cause,
    });
    this.name = "UpstreamTimeoutError";
  }
}

/** Convert any thrown value to the public MCP error envelope without leaking internals. */
export function toErrorEnvelope(error: unknown): SourcePackErrorEnvelope {
  if (error instanceof SourcePackError) {
    const body: SourcePackErrorBody = {
      schema_version: "1",
      code: error.code,
      category: error.category,
      message: error.message,
      retryable: error.retryable,
    };
    if (error.details) body.details = error.details;
    return { error: body };
  }

  return {
    error: {
      schema_version: "1",
      code: "INTERNAL_ERROR",
      category: "internal",
      message: "The source-pack operation failed unexpectedly.",
      retryable: false,
    },
  };
}
