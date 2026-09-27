import { NextResponse } from "next/server";

import { resolveAccountIdFromAuthorizationHeader } from "../../../../lib/auth/resolve-account";
import { consumeRateLimit } from "../../../../lib/ratelimit/consume-rate-limit";
import { SubmissionCapExceededError } from "../../../../modules/abuse/enforce-submission-caps";
import { createJob } from "../../../../modules/jobs/create-job";
import {
  IdempotencyConflictError,
  InvalidJobSubmissionError,
} from "../../../../modules/jobs/errors";
import {
  InvalidJobListQueryError,
  listJobsForAccount,
} from "../../../../modules/jobs/list-jobs";

/**
 * PR-JOB-008: a submission over the cap is refused. Node buffers the body
 * before this runs, so the cap is also enforced on the serialized payload in
 * `validateJobSubmission` before any row is created.
 */
const MAX_REQUEST_BYTES = 300 * 1024;

function problem(
  status: number,
  code: string,
  message: string,
  fieldErrors?: Record<string, string>,
  headers?: Record<string, string>,
) {
  return NextResponse.json(
    { error: { code, message, ...(fieldErrors === undefined ? {} : { fieldErrors }) } },
    { status, headers },
  );
}

/**
 * PR-TECH-006: refuses a caller over the per-account request budget. Runs after
 * authentication because the budget belongs to the resolved account, and before
 * any body is read so a throttled caller costs one row update rather than a
 * buffered payload.
 */
async function rateLimitResponse(accountId: string): Promise<NextResponse | null> {
  const decision = await consumeRateLimit(accountId);
  if (decision.allowed) {
    return null;
  }
  return problem(
    429,
    "rate_limit_exceeded",
    `Rate limit of ${decision.limit} requests per minute exceeded`,
    undefined,
    { "Retry-After": String(decision.retryAfterSeconds) },
  );
}

export async function GET(request: Request): Promise<NextResponse> {
  const accountId = await resolveAccountIdFromAuthorizationHeader(
    request.headers.get("authorization"),
  );
  if (accountId === null) {
    return problem(401, "unauthorized", "A valid API key is required");
  }

  const throttled = await rateLimitResponse(accountId);
  if (throttled !== null) {
    return throttled;
  }

  const search = new URL(request.url).searchParams;

  try {
    const page = await listJobsForAccount(accountId, {
      status: search.get("status") ?? undefined,
      type: search.get("type") ?? undefined,
      cursor: search.get("cursor") ?? undefined,
      limit: search.get("limit") ?? undefined,
    });

    return NextResponse.json(page, {
      // Job status and queue membership change without notice, so a cached page
      // would be actively misleading.
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    if (error instanceof InvalidJobListQueryError) {
      return problem(422, "invalid_query", error.message, { [error.field]: error.message });
    }

    // CS-10 / SEC-13: the client gets a generic body; the cause goes to the
    // server log only.
    console.error("GET /v1/jobs failed", error);
    return problem(500, "internal_error", "An unexpected error occurred");
  }
}

export async function POST(request: Request): Promise<NextResponse> {
  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null && Number(declaredLength) > MAX_REQUEST_BYTES) {
    return problem(413, "payload_too_large", "Request body is too large");
  }

  const accountId = await resolveAccountIdFromAuthorizationHeader(
    request.headers.get("authorization"),
  );
  if (accountId === null) {
    return problem(401, "unauthorized", "A valid API key is required");
  }

  const throttled = await rateLimitResponse(accountId);
  if (throttled !== null) {
    return throttled;
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return problem(400, "invalid_json", "Request body must be valid JSON");
  }

  try {
    const result = await createJob({ accountId, body });

    return NextResponse.json(result.job, {
      // A new job is accepted for asynchronous processing, not completed
      // (PR-JOB-002). A repeat submission returns the job that already exists
      // (PR-IDEM-002).
      status: result.outcome === "created" ? 202 : 200,
    });
  } catch (error) {
    if (error instanceof InvalidJobSubmissionError) {
      return problem(422, "invalid_submission", "Request failed validation", {
        ...error.fieldErrors,
      });
    }

    if (error instanceof IdempotencyConflictError) {
      return problem(
        409,
        "idempotency_conflict",
        "This idempotency key was already used with a different payload",
      );
    }

    if (error instanceof SubmissionCapExceededError) {
      return problem(
        429,
        error.kind === "concurrent" ? "too_many_concurrent_jobs" : "daily_submission_limit_exceeded",
        error.kind === "concurrent"
          ? "Concurrent non-terminal jobs exceed the per-account cap"
          : "Daily job submission cap exceeded",
      );
    }

    // CS-10 / SEC-13: the client gets a generic body; the cause goes to the
    // server log only.
    console.error("POST /v1/jobs failed", error);
    return problem(500, "internal_error", "An unexpected error occurred");
  }
}
