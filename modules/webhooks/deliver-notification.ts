import { JobStatus, WebhookDeliveryStatus } from "@prisma/client";

import { db } from "../../lib/db/client";
import {
  DELIVERY_REQUEST_TIMEOUT_MS,
  MAX_DELIVERY_ATTEMPTS,
  deliveryBackoffMs,
} from "./delivery-policy";
import { buildWebhookPayload, isTerminalJobStatus } from "./payload";
import { SIGNATURE_HEADER, signWebhookPayload } from "./signature";

/**
 * PR-TECH-005: delivery is performed by the worker process, after the job's final
 * state is already committed, never by the web app and never inside the settle
 * transaction.
 *
 * PR-WEBHOOK-004: a failed delivery is retried up to 3 times with backoff, then
 * recorded as `FAILED` and abandoned. The job's own status is never read or
 * written here beyond the read that decides whether to notify at all — webhook
 * delivery failure must not be able to change a job's outcome (AGENTS rule 18).
 *
 * Each attempt gets its own `WebhookDelivery` row (PR-TECH-005), so a partial
 * failure history is queryable rather than being overwritten.
 */

export type DeliveryOutcome = {
  readonly delivered: boolean;
  readonly attempts: number;
  readonly lastError: string | null;
  readonly responseCode: number | null;
};

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type AttemptResult =
  | { readonly ok: true; readonly responseCode: number }
  | { readonly ok: false; readonly responseCode: number | null; readonly error: string };

async function postOnce(
  url: string,
  secret: string,
  body: string,
): Promise<AttemptResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DELIVERY_REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [SIGNATURE_HEADER]: signWebhookPayload(secret, body),
      },
      body,
      signal: controller.signal,
    });

    // PR-WEBHOOK-004 treats any non-2xx as a delivery failure worth retrying.
    if (response.status >= 200 && response.status < 300) {
      return { ok: true, responseCode: response.status };
    }
    return {
      ok: false,
      responseCode: response.status,
      error: `Endpoint responded ${response.status}`,
    };
  } catch (error) {
    return {
      ok: false,
      responseCode: null,
      error: error instanceof Error ? error.message : "Unknown delivery error",
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Notifies the account about a job that has just reached a terminal state.
 *
 * A no-op when the account has registered no endpoint, which is the common case
 * and must not be logged as an error.
 */
export async function deliverTerminalJobNotification(jobId: string): Promise<DeliveryOutcome> {
  const job = await db.job.findUnique({ where: { id: jobId } });

  if (job === null) {
    return { delivered: false, attempts: 0, lastError: null, responseCode: null };
  }

  if (!isTerminalJobStatus(job.status)) {
    // The only statuses reaching here are the ones the worker just settled;
    // re-checking keeps a future caller from turning a transient state into a
    // "finished" notification.
    return { delivered: false, attempts: 0, lastError: null, responseCode: null };
  }

  // The endpoint is reached through the account, not from the job: the PRD gives
  // an account exactly one URL and a job has no callback of its own.
  const endpoint = await db.webhookEndpoint.findUnique({
    where: { accountId: job.accountId },
  });

  if (endpoint === null) {
    return { delivered: false, attempts: 0, lastError: null, responseCode: null };
  }

  const body = buildWebhookPayload(job);

  let lastError: string | null = null;
  let responseCode: number | null = null;

  for (let attemptNumber = 1; attemptNumber <= MAX_DELIVERY_ATTEMPTS; attemptNumber += 1) {
    const result = await postOnce(endpoint.url, endpoint.secret, body);
    responseCode = result.ok ? result.responseCode : result.responseCode;
    lastError = result.ok ? null : result.error;

    // PR-TECH-005: one row per attempt, written after the attempt so the row
    // records what actually happened.
    await db.webhookDelivery.create({
      data: {
        jobId: job.id,
        endpointId: endpoint.id,
        attemptNumber,
        status: result.ok ? WebhookDeliveryStatus.DELIVERED : WebhookDeliveryStatus.FAILED,
        responseCode,
        sentAt: new Date(),
      },
    });

    if (result.ok) {
      return { delivered: true, attempts: attemptNumber, lastError: null, responseCode };
    }

    if (attemptNumber < MAX_DELIVERY_ATTEMPTS) {
      await wait(deliveryBackoffMs(attemptNumber));
    }
  }

  console.error(
    `Webhook delivery for job ${job.id} to ${endpoint.url} failed after ` +
      `${MAX_DELIVERY_ATTEMPTS} attempts; job status ${job.status} is unaffected`,
  );

  return { delivered: false, attempts: MAX_DELIVERY_ATTEMPTS, lastError, responseCode };
}

/** Exported for the worker's shutdown path and for tests. */
export function shouldNotifyJob(job: { status: JobStatus }): boolean {
  return isTerminalJobStatus(job.status);
}
