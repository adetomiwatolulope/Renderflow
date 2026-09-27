import { NextResponse } from "next/server";

import { resolveAccountIdFromAuthorizationHeader } from "../../../../../lib/auth/resolve-account";
import { getJobDetailForAccount } from "../../../../../modules/jobs/get-job";

/**
 * PR-JOB-004: the status endpoint a client polls after enqueueing.
 *
 * The owner's step 8 described this as `GET /api/jobs/:id`, but the API is
 * versioned under /v1/ (AGENTS Q2) and PR-JOB-004 specifies `GET /v1/jobs/:id`,
 * so it sits beside the existing POST at /api/v1/jobs.
 */

/**
 * This endpoint exists to be polled, so a cached response would defeat its
 * purpose: the client would read a stale status indefinitely. Forced dynamic so
 * the framework does not cache the route, and `no-store` on every response below
 * so neither the browser nor an intermediary does either. That includes the
 * errors, since a cached 404 would outlive the job appearing.
 */
export const dynamic = "force-dynamic";

function problem(status: number, code: string, message: string): NextResponse {
  return NextResponse.json(
    { error: { code, message } },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}

export async function GET(
  request: Request,
  context: RouteContext<"/api/v1/jobs/[jobId]">,
): Promise<NextResponse> {
  const accountId = await resolveAccountIdFromAuthorizationHeader(
    request.headers.get("authorization"),
  );
  if (accountId === null) {
    return problem(401, "unauthorized", "A valid API key is required");
  }

  const { jobId } = await context.params;
  const detail = await getJobDetailForAccount({ accountId, jobId });

  // One answer for "no such job" and "not your job", so a 404 here does not
  // confirm that someone else's job id is real (PR-AUTH-004).
  if (detail === null) {
    return problem(404, "job_not_found", "No such job for this account");
  }

  return NextResponse.json(detail, {
    headers: { "Cache-Control": "no-store" },
  });
}
