import type { ClaimedJob } from "../modules/queue/claim";
import { startHeartbeat } from "../modules/queue/heartbeat";
import { markJobSucceeded, settleAttemptFailure } from "../modules/queue/settle";
import { deliverTerminalJobNotification } from "../modules/webhooks/deliver-notification";
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
      await notifyCallerOfTerminalState(job.id);
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

    // Only the exhausted/non-retryable case is terminal. A retry-waiting FAILED
    // is not a final state, so the caller is not told about it (PR-WEBHOOK-002).
    await notifyCallerOfTerminalState(job.id);
  } catch (error) {
    console.error(`Failed to settle job ${job.id}`, error);
  } finally {
    stopHeartbeat();
  }
}

/**
 * PR-TECH-005: the worker notifies the caller, after the terminal state is
 * committed, and never lets delivery trouble be mistaken for a job failure.
 * `deliverTerminalJobNotification` decides internally whether the job actually
 * reached a terminal state, and a delivery error must not propagate into the
 * settle path, so it is caught and logged here.
 */
async function notifyCallerOfTerminalState(jobId: string): Promise<void> {
  try {
    await deliverTerminalJobNotification(jobId);
  } catch (error) {
    console.error(`Webhook notification for job ${jobId} raised; job status is unaffected`, error);
  }
}
