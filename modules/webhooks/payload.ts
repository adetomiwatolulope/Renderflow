import { JobStatus, type Job } from "@prisma/client";

/**
 * PR-WEBHOOK-002: the delivery body carries the job ID, type, final status, and a
 * result/error summary.
 *
 * Serialised once, here, and the resulting string is both signed and sent, so the
 * caller's verification can never disagree with the bytes on the wire.
 */

export const JOB_WEBHOOK_EVENT = "job.finished";

export type WebhookJobSummary = {
  readonly id: string;
  readonly type: Job["type"];
  readonly status: JobStatus;
  readonly attempts: number;
  readonly finishedAt: string | null;
  readonly result: unknown;
  readonly error: string | null;
};

export type WebhookDeliveryPayload = {
  readonly event: typeof JOB_WEBHOOK_EVENT;
  readonly deliveredAt: string;
  readonly job: WebhookJobSummary;
};

export function buildWebhookPayload(
  job: Pick<
    Job,
    "id" | "type" | "status" | "attempts" | "finishedAt" | "result" | "lastError"
  >,
  now: Date = new Date(),
): string {
  const payload: WebhookDeliveryPayload = {
    event: JOB_WEBHOOK_EVENT,
    deliveredAt: now.toISOString(),
    job: {
      id: job.id,
      type: job.type,
      status: job.status,
      attempts: job.attempts,
      finishedAt: job.finishedAt === null ? null : job.finishedAt.toISOString(),
      result: job.result ?? null,
      error: job.lastError,
    },
  };

  return JSON.stringify(payload);
}

/**
 * The owner-directed lifecycle makes `SUCCEEDED` and `DEAD` terminal; `FAILED` is
 * a retry-waiting state that will change again on the next attempt.
 *
 * PR-WEBHOOK-002 says "SUCCEEDED or FAILED" while its own preamble describes
 * notifying "when a job reaches a final state", and this follows the final-state
 * reading. Notifying on `FAILED` would tell a caller a job had finished while
 * attempts remain, with no way for them to tell that apart from a real terminal
 * failure. Flagged for owner confirmation.
 */
export function isTerminalJobStatus(status: JobStatus): boolean {
  switch (status) {
    case JobStatus.SUCCEEDED:
    case JobStatus.DEAD:
      return true;
    case JobStatus.QUEUED:
    case JobStatus.PROCESSING:
    case JobStatus.FAILED:
      return false;
    default: {
      const exhaustive: never = status;
      return exhaustive;
    }
  }
}
