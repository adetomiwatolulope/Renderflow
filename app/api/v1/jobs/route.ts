import { NextResponse } from "next/server";

import { resolveAccountIdFromAuthorizationHeader } from "../../../../lib/auth/resolve-account";
import { createJob } from "../../../../modules/jobs/create-job";
import {
  IdempotencyConflictError,
  InvalidJobSubmissionError,
} from "../../../../modules/jobs/errors";

/**
 * PR-JOB-008: a submission over the cap is refused. Node buffers the body
 * before this runs, so the cap is also enforced on the serialized payload in
 * `validateJobSubmission` before any row is created.
 */
const MAX_REQUEST_BYTES = 300 * 1024;

function problem(status: number, code: string, message: string, fieldErrors?: Record<string, string>) {
  return NextResponse.json(
    { error: { code, message, ...(fieldErrors === undefined ? {} : { fieldErrors }) } },
    { status },
  );
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

    // CS-10 / SEC-13: the client gets a generic body; the cause goes to the
    // server log only.
    console.error("POST /v1/jobs failed", error);
    return problem(500, "internal_error", "An unexpected error occurred");
  }
}
