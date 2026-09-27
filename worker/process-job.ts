import type { ClaimedJob } from "../modules/queue/claim";
import { startHeartbeat } from "../modules/queue/heartbeat";
import { markJobSucceeded, settleAttemptFailure } from "../modules/queue/settle";
import { resolveExecutor } from "./executors/registry";
import type { ExecutionResult } from "./executors/types";
import { failureFromThrownError } from "./failure";

/**
 * Running one claimed job to a settled outcome. Split out of worker/index.ts so
 * the process lifecycle is not tangled with the failure decision.
 */

export async function processClaimedJob(
  job: ClaimedJob,
  heartbeatIntervalMs: number,
): Promise<void> {
  const executor = resolveExecutor(job.type);
  if (executor === null) {
    // Unreachable in practice: claimNextJob only claims types the registry
    // reports as executable. Guarded anyway so a registry bug surfaces instead
    // of leaving the job stuck in PROCESSING.
    console.error(`No executor registered for type ${job.type}; job ${job.id} left PROCESSING`);
    return;
  }

  // Started before the executor runs and stopped once the job settles, so the
  // whole execution is covered. Without it the sweep would eventually requeue a
  // job that is still legitimately running (PR-RETRY-003, AGENTS rule 10).
  const stopHeartbeat = startHeartbeat(job.id, heartbeatIntervalMs);

  let outcome: ExecutionResult;
  try {
    outcome = await executor(job);
  } catch (error) {
    console.error(`Executor for job ${job.id} threw`, error);
    outcome = failureFromThrownError(error);
  }

  try {
    if (outcome.kind === "success") {
      await markJobSucceeded(job, outcome.result);
      return;
    }

    const status = await settleAttemptFailure(job, {
      retryable: outcome.retryable,
      errorCode: outcome.errorCode,
      errorMessage: outcome.errorMessage,
    });

    console.log(
      `Job ${job.id} attempt ${job.attempts}/${job.maxAttempts} failed -> ${status}` +
        ` (${outcome.errorCode})`,
    );
  } catch (error) {
    console.error(`Failed to settle job ${job.id}`, error);
  } finally {
    stopHeartbeat();
  }
}
