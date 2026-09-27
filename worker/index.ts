import type { JobType } from "@prisma/client";

import { claimNextJob, type ClaimedJob } from "../modules/queue/claim";
import { startStalledJobSweep } from "../modules/queue/sweep";
import {
  WORKER_CONCURRENCY,
  WORKER_HEARTBEAT_INTERVAL_MS,
  WORKER_POLL_INTERVAL_MS,
  WORKER_STALL_TIMEOUT_MS,
  WORKER_SWEEP_INTERVAL_MS,
} from "./config";
import { executableJobTypes } from "./executors/registry";
import { processClaimedJob } from "./process-job";

/**
 * The standalone worker process (PR-TECH-002). Separate from the web app: it has
 * its own entrypoint, its own event loop, and its own configuration, and it is
 * started with `npm run worker`, never by a request.
 *
 * This file is only the process lifecycle. Deciding what a failure means lives
 * in worker/process-job.ts, and deciding what a delay is lives in
 * modules/retry/backoff.ts.
 */

let inFlight = 0;
let peakInFlight = 0;
let shuttingDown = false;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Tracks the per-process concurrency high-water mark (PR-QUEUE-004) and logs each
 * new peak. The cap is what stops one account's backlog from starving everyone
 * else, so the highest level actually reached is worth seeing in the worker's
 * output rather than having to be inferred from the configured limit.
 */
function beginJob(): void {
  inFlight += 1;
  if (inFlight > peakInFlight) {
    peakInFlight = inFlight;
    console.log(`Concurrency high-water mark: ${peakInFlight} of ${WORKER_CONCURRENCY}`);
  }
}

async function claimAndStartJobs(types: readonly JobType[]): Promise<boolean> {
  let startedAny = false;

  while (!shuttingDown && inFlight < WORKER_CONCURRENCY) {
    const job: ClaimedJob | null = await claimNextJob(types);
    if (job === null) {
      break;
    }

    startedAny = true;
    beginJob();

    void processClaimedJob(job, WORKER_HEARTBEAT_INTERVAL_MS).finally(() => {
      inFlight -= 1;
    });
  }

  return startedAny;
}

async function waitForInFlightJobsToFinish(): Promise<void> {
  while (inFlight > 0) {
    await sleep(50);
  }
}

export async function runWorker(): Promise<void> {
  const types = executableJobTypes();

  console.log(`Worker starting with concurrency ${WORKER_CONCURRENCY}`);
  console.log(`Claimable job types: ${types.length === 0 ? "none" : types.join(", ")}`);
  console.log(
    `Heartbeat every ${WORKER_HEARTBEAT_INTERVAL_MS}ms; ` +
      `sweeping every ${WORKER_SWEEP_INTERVAL_MS}ms for heartbeats stale past ` +
      `${WORKER_STALL_TIMEOUT_MS}ms`,
  );

  // Owner's Step 6: recovers jobs whose worker died mid-job. Runs in this same
  // process; v1 has exactly one worker (PR-TECH-002), so no other process is
  // needed to find its casualties.
  const stopSweep = startStalledJobSweep(WORKER_SWEEP_INTERVAL_MS, WORKER_STALL_TIMEOUT_MS);

  while (!shuttingDown) {
    const startedAny = await claimAndStartJobs(types);
    if (!startedAny) {
      await sleep(WORKER_POLL_INTERVAL_MS);
    }
  }

  // Stop claiming first, then let in-flight work finish, so a shutdown never
  // abandons a job in PROCESSING.
  stopSweep();
  console.log(`Worker shutting down; waiting for ${inFlight} in-flight job(s)`);
  await waitForInFlightJobsToFinish();
  console.log(
    `Worker stopped; peak concurrency ${peakInFlight} of ${WORKER_CONCURRENCY}`,
  );
}

function requestShutdown(signal: string): void {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  console.log(`Received ${signal}`);
}

process.on("SIGINT", () => requestShutdown("SIGINT"));
process.on("SIGTERM", () => requestShutdown("SIGTERM"));

runWorker().catch((error) => {
  console.error("Worker crashed", error);
  process.exitCode = 1;
});
