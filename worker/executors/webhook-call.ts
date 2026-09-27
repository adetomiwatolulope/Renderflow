import type { JsonObject } from "../../modules/jobs/json-value";
import type { ClaimedJob } from "../../modules/queue/claim";
import type { ExecutionResult } from "./types";

/**
 * WEBHOOK_CALL — the job type chosen to implement first.
 *
 * Why this one: it is the only type whose work RenderFlow can perform with no
 * third-party credentials and no new dependency (Node's built-in `fetch`), and
 * PR-RETRY-002 explicitly contemplates HTTP-backed job types and gives their
 * outcome mapping. It is also the only type that can be exercised end to end
 * against a local HTTP server, which is what makes the claim/settle cycle
 * provable.
 *
 * PAYLOAD CONTRACT — the PRD defines `payload` only as an opaque JSON object
 * ("the caller supplies whatever the actual execution step needs"), so the shape
 * below is a decision made for this build, not a PRD requirement:
 *   { url: string (https, required), method?: GET|POST|PUT|PATCH|DELETE,
 *     headers?: Record<string,string>, body?: any JSON value }
 * `body` is sent as JSON. A per-call timeout is deliberately NOT client
 * settable, on the same principle as `maxAttempts` (AGENTS rule 5).
 *
 * A malformed payload fails NON_RETRYABLE: retrying a request that can never
 * succeed would only burn attempts (AGENTS Q7, most restrictive reading).
 *
 * IDEMPOTENCY (owner's Step 5) — this executor is safe to run twice. A worker
 * can die after the endpoint has processed a request but before the job is
 * marked succeeded, leaving the job claimable, so the retry is a genuine repeat
 * of the same logical work. Every request therefore carries the job id as an
 * `Idempotency-Key` header, letting the receiver collapse the repeat instead of
 * acting twice. See IDEMPOTENCY_HEADER below.
 */

/** Fixed in code, not client-settable. Sits inside the PRD's 60s p95 target. */
const REQUEST_TIMEOUT_MS = 10_000;

const ALLOWED_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;

/**
 * Owner's Step 5: the job id is the key on the output, sent to the endpoint so a
 * second run of the same job is deduplicated by the receiver instead of
 * delivering twice.
 *
 * The job id is used rather than the attempt number because it is stable across
 * every attempt of the job. A worker that crashes after the endpoint has
 * processed the request but before the job is marked succeeded leaves the job
 * claimable again, and that retry is a repeat of the *same* logical work, so it
 * must carry the same key.
 *
 * The header is server-owned: a caller-supplied value is rejected rather than
 * honoured, because letting a caller set it would let them defeat the
 * guarantee. Same principle as `maxAttempts` (AGENTS rule 5).
 */
const IDEMPOTENCY_HEADER = "Idempotency-Key";

type AllowedMethod = (typeof ALLOWED_METHODS)[number];

type ParsedRequest =
  | {
      readonly ok: true;
      readonly url: string;
      readonly init: RequestInit;
    }
  | {
      readonly ok: false;
      readonly errorCode: string;
      readonly errorMessage: string;
    };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAllowedMethod(value: string): value is AllowedMethod {
  return (ALLOWED_METHODS as readonly string[]).includes(value);
}

function hasHeader(headers: Record<string, string>, name: string): boolean {
  const target = name.toLowerCase();
  return Object.keys(headers).some((key) => key.toLowerCase() === target);
}

/**
 * Builds the outbound request, including the job-id idempotency key. Exported so
 * the Step 5 contract can be asserted without making a network call.
 */
export function buildRequest(job: ClaimedJob): ParsedRequest {
  const payload = job.payload;

  if (!isPlainObject(payload)) {
    return {
      ok: false,
      errorCode: "INVALID_PAYLOAD",
      errorMessage: "payload must be a JSON object",
    };
  }

  const rawUrl = payload.url;
  if (typeof rawUrl !== "string" || rawUrl.length === 0) {
    return {
      ok: false,
      errorCode: "INVALID_PAYLOAD",
      errorMessage: "payload.url is required and must be a non-empty string",
    };
  }

  // AGENTS rule 17: only https is accepted. An http:// target is refused
  // rather than attempted.
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(rawUrl);
  } catch {
    return {
      ok: false,
      errorCode: "INVALID_URL",
      errorMessage: "payload.url is not a valid absolute URL",
    };
  }

  if (parsedUrl.protocol !== "https:") {
    return {
      ok: false,
      errorCode: "INSECURE_URL",
      errorMessage: "payload.url must use https",
    };
  }

  const rawMethod = payload.method ?? "POST";
  if (typeof rawMethod !== "string" || !isAllowedMethod(rawMethod)) {
    return {
      ok: false,
      errorCode: "INVALID_METHOD",
      errorMessage: `payload.method must be one of: ${ALLOWED_METHODS.join(", ")}`,
    };
  }

  const headers: Record<string, string> = {};
  if (payload.headers !== undefined) {
    if (!isPlainObject(payload.headers)) {
      return {
        ok: false,
        errorCode: "INVALID_PAYLOAD",
        errorMessage: "payload.headers must be an object of string values",
      };
    }

    for (const [name, value] of Object.entries(payload.headers)) {
      if (typeof value !== "string") {
        return {
          ok: false,
          errorCode: "INVALID_PAYLOAD",
          errorMessage: `payload.headers.${name} must be a string`,
        };
      }
      headers[name] = value;
    }
  }

  const init: RequestInit = {
    method: rawMethod,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  };

  const body = payload.body;
  if (body !== undefined) {
    headers["content-type"] = hasHeader(headers, "content-type")
      ? (headers["content-type"] as string)
      : "application/json";
    init.body = JSON.stringify(body);
  }

  // Rejected rather than overridden, so the caller is never silently ignored.
  if (hasHeader(headers, IDEMPOTENCY_HEADER)) {
    return {
      ok: false,
      errorCode: "RESERVED_HEADER",
      errorMessage:
        `payload.headers.${IDEMPOTENCY_HEADER} is set by the server to the job id ` +
        "and cannot be overridden",
    };
  }

  headers[IDEMPOTENCY_HEADER] = job.id;

  init.headers = headers;

  return { ok: true, url: parsedUrl.toString(), init };
}

/**
 * PR-RETRY-002's stated default for HTTP-backed job types: network failures and
 * 5xx are RETRYABLE, 4xx are NON_RETRYABLE.
 *
 * Two 4xx codes are treated as RETRYABLE: 408 Request Timeout and 429 Too Many
 * Requests. Both describe a condition that is transient at the caller's end
 * rather than a request that is wrong, and retrying a 429 is the entire point of
 * a rate-limit response. PR-RETRY-002 calls its 4xx rule "the default mapping
 * within that job type's execution code", so refining it here is the
 * refinement the PRD anticipates, not a departure from it.
 */
export function classifyStatusCode(
  statusCode: number,
): "success" | "retryable" | "nonRetryable" {
  if (statusCode >= 200 && statusCode < 400) {
    return "success";
  }
  if (statusCode === 408 || statusCode === 429) {
    return "retryable";
  }
  if (statusCode >= 500) {
    return "retryable";
  }
  return "nonRetryable";
}

export async function executeWebhookCall(job: ClaimedJob): Promise<ExecutionResult> {
  const parsed = buildRequest(job);
  if (!parsed.ok) {
    return {
      kind: "failure",
      retryable: false,
      errorCode: parsed.errorCode,
      errorMessage: parsed.errorMessage,
    };
  }

  let response: Response;
  try {
    response = await fetch(parsed.url, parsed.init);
  } catch (error) {
    // Network failure or timeout. RETRYABLE per PR-RETRY-002.
    return {
      kind: "failure",
      retryable: true,
      errorCode: "NETWORK_ERROR",
      errorMessage: error instanceof Error ? error.message : String(error),
    };
  }

  const classification = classifyStatusCode(response.status);

  if (classification === "success") {
    const result: JsonObject = { statusCode: response.status };
    return { kind: "success", result };
  }

  return {
    kind: "failure",
    retryable: classification === "retryable",
    errorCode: `HTTP_${response.status}`,
    errorMessage: `Endpoint responded ${response.status}`,
  };
}
