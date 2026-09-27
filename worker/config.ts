import { readPositiveInteger } from "../lib/config/env";

/**
 * PR-QUEUE-004: the most jobs this process runs at once, default 10.
 *
 * AGENTS rule 16: this is a per-process cap. It equals the system-wide cap only
 * because v1 runs exactly one worker process (PR-TECH-002). Nothing here
 * coordinates across instances, and must not be written as if it did.
 *
 * This is also the knob that keeps the worker inside a third party's rate
 * limit, which is why it is configuration rather than a constant.
 */
export const WORKER_CONCURRENCY = readPositiveInteger("WORKER_CONCURRENCY", 10, process.env);

/** How long to wait after finding nothing claimable before polling again. */
export const WORKER_POLL_INTERVAL_MS = readPositiveInteger("WORKER_POLL_INTERVAL_MS", 1_000, process.env);

/**
 * PR-RETRY-003: while a job is PROCESSING, its lastHeartbeatAt is refreshed on
 * this interval for as long as execution continues. Default 30 seconds.
 */
export const WORKER_HEARTBEAT_INTERVAL_MS = readPositiveInteger(
  "WORKER_HEARTBEAT_INTERVAL_MS",
  30_000,
  process.env,
);

/**
 * PR-RETRY-003 / AGENTS rule 10: a job is only requeued once its heartbeat has
 * been stale for this long. Default 10 minutes.
 *
 * This is measured from the last heartbeat, NOT from the claim. That distinction
 * is the whole point: it separates a dead worker (heartbeat stopped) from a slow
 * but healthy one (heartbeat still ticking), so a legitimately long job is never
 * requeued and double-executed.
 */
export const WORKER_STALL_TIMEOUT_MS = readPositiveInteger(
  "WORKER_STALL_TIMEOUT_MS",
  10 * 60_000,
  process.env,
);

/** How often the sweep looks for jobs whose heartbeat has gone stale. */
export const WORKER_SWEEP_INTERVAL_MS = readPositiveInteger(
  "WORKER_SWEEP_INTERVAL_MS",
  60_000,
  process.env,
);
