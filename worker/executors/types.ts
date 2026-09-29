import type { JobType } from "@prisma/client";

import type { ClaimedJob } from "../../modules/queue/claim";
import type { JsonObject } from "../../modules/jobs/json-value";

/**
 * AGENTS rule 9 / PR-RETRY-002: the code that runs a job decides explicitly
 * whether a failure is retryable. An executor never signals retryability by
 * throwing, and never by returning an HTTP status — the reason is part of the
 * result, not something inferred from a transport detail.
 */
export type ExecutionResult =
  | {
      readonly kind: "success";
      readonly result: JsonObject | null;
    }
  | {
      readonly kind: "failure";
      readonly retryable: boolean;
      readonly errorCode: string;
      readonly errorMessage: string;
    };

/**
 * An executor's work MUST be safe to run twice (owner's Step 5).
 *
 * A worker can die after the side effect has happened but before the job is
 * marked succeeded, which leaves the job claimable and the retry a genuine
 * repeat of the same logical work. Nothing in the queue can prevent this, and
 * nothing should try: the guarantee belongs in the work itself.
 *
 * In practice that means producing the effect under a key derived from the
 * job's own id, which is stable across every attempt, and checking for an
 * existing result before producing a new one. For an HTTP-backed type that is
 * the `Idempotency-Key` request header; see worker/executors/webhook-call.ts.
 *
 * v1 stores no job outputs, because PR-TECH-007 forbids keeping binary output
 * in the database, so an executor that produces a file has nowhere in v1 to
 * check for an existing one. That limitation is flagged, not worked around.
 */
export type JobExecutor = (job: ClaimedJob) => Promise<ExecutionResult>;

/** Partial: a type with no executor yet is a normal state, not a type error. */
export type ExecutorRegistry = Readonly<Partial<Record<JobType, JobExecutor>>>;
