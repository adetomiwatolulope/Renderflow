/**
 * PR-WEBHOOK-004 delivery timing, kept free of database and network imports so the
 * policy is testable on its own and the constants have one home.
 */

/** Total attempts, not additional retries. A fourth attempt would be a new delivery. */
export const MAX_DELIVERY_ATTEMPTS = 3;

export const DELIVERY_REQUEST_TIMEOUT_MS = 10_000;

/**
 * Backoff between delivery attempts. Deliberately shorter than the job retry
 * ladder: the caller is waiting on this notification, and PR-WEBHOOK-002 asks for
 * delivery within 5 seconds of the state change under normal load.
 */
export const DELIVERY_BACKOFF_MS: readonly number[] = [1_000, 4_000];

/** Last entry repeats once the ladder is exhausted. */
export function deliveryBackoffMs(attemptNumber: number): number {
  const index = attemptNumber - 1;
  return DELIVERY_BACKOFF_MS[index] ?? DELIVERY_BACKOFF_MS[DELIVERY_BACKOFF_MS.length - 1];
}
