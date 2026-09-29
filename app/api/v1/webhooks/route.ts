import { NextResponse } from "next/server";

import { resolveAccountIdFromAuthorizationHeader } from "../../../../lib/auth/resolve-account";
import { consumeRateLimit } from "../../../../lib/ratelimit/consume-rate-limit";
import { db } from "../../../../lib/db/client";
import {
  InsecureWebhookUrlError,
  InvalidWebhookUrlError,
} from "../../../../modules/webhooks/endpoint-url";
import { registerWebhookEndpoint } from "../../../../modules/webhooks/register-endpoint";

/**
 * Webhook endpoint registration. This is the caller-facing *registration* surface
 * described in the AGENTS directory tree; it is not the endpoint RenderFlow
 * delivers to.
 *
 * POST /v1/webhooks - register or replace the account's single callback URL
 * GET  /v1/webhooks - read the current registration (secret included, because the
 *                      caller needs it to verify signatures)
 */

function problem(status: number, code: string, message: string): NextResponse {
  return NextResponse.json({ error: { code, message } }, { status });
}

export async function GET(request: Request): Promise<NextResponse> {
  const accountId = await resolveAccountIdFromAuthorizationHeader(
    request.headers.get("authorization"),
  );
  if (accountId === null) {
    return problem(401, "unauthorized", "A valid API key is required");
  }

  const decision = await consumeRateLimit(accountId);
  if (!decision.allowed) {
    return problem(429, "rate_limit_exceeded", "Rate limit exceeded");
  }

  const endpoint = await db.webhookEndpoint.findUnique({
    where: { accountId },
    select: { url: true, secret: true, createdAt: true },
  });

  if (endpoint === null) {
    return problem(404, "not_registered", "No webhook endpoint is registered");
  }

  return NextResponse.json(endpoint, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: Request): Promise<NextResponse> {
  const accountId = await resolveAccountIdFromAuthorizationHeader(
    request.headers.get("authorization"),
  );
  if (accountId === null) {
    return problem(401, "unauthorized", "A valid API key is required");
  }

  const decision = await consumeRateLimit(accountId);
  if (!decision.allowed) {
    return problem(429, "rate_limit_exceeded", "Rate limit exceeded");
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return problem(400, "invalid_json", "Request body must be valid JSON");
  }

  if (typeof body !== "object" || body === null || typeof (body as { url?: unknown }).url !== "string") {
    return problem(422, "invalid_submission", "A url string is required");
  }

  try {
    const endpoint = await registerWebhookEndpoint(
      accountId,
      (body as { url: string }).url,
    );

    return NextResponse.json(
      { url: endpoint.url, secret: endpoint.secret, replaced: endpoint.replaced },
      { status: endpoint.replaced ? 200 : 201 },
    );
  } catch (error) {
    // PR-WEBHOOK-001: an http:// URL is a 422, not a redirect or a silent upgrade.
    if (error instanceof InsecureWebhookUrlError) {
      return problem(422, "insecure_webhook_url", "Webhook URL must use https://");
    }
    if (error instanceof InvalidWebhookUrlError) {
      return problem(422, "invalid_webhook_url", "Webhook URL is not a valid URL");
    }

    console.error("POST /v1/webhooks failed", error);
    return problem(500, "internal_error", "An unexpected error occurred");
  }
}
