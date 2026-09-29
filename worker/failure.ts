import type { ExecutionResult } from "./executors/types";

/**
 * Deciding what a thrown error means, kept separate from worker/process-job.ts so
 * it stays pure and testable without opening a database connection.
 */

function describeUnknownError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * A throw is a RETRYABLE failure (owner's Step 4: "when work throws" follows the
 * normal increment / lastError / backoff path). The blast radius is bounded by
 * maxAttempts, so a genuinely broken executor still ends at DEAD rather than
 * retrying forever.
 */
export function failureFromThrownError(error: unknown): ExecutionResult {
  return {
    kind: "failure",
    retryable: true,
    errorCode: "EXECUTOR_THREW",
    errorMessage: describeUnknownError(error),
  };
}
