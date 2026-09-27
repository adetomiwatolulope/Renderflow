import { db } from "../../lib/db/client";

/**
 * PR-RETRY-003 / AGENTS rule 10.
 *
 * A job is only ever recovered because its heartbeat stopped, so the heartbeat
 * has to be refreshed for the whole duration a job is being processed. Without
 * this, the sweep would have to guess from the claim time and would requeue
 * jobs that are still legitimately running.
 *
 * Every timestamp in this cycle is the database's clock, never the Node
 * process's. The claim writes `now()` in SQL, the sweep measures staleness in
 * SQL, so a heartbeat taken from `new Date()` would be compared against a
 * cutoff produced by a different clock. If this host ran ahead of the database,
 * a job that had just been heartbeated would look older than the timeout and
 * be requeued while it was still running.
 */

/**
 * A single heartbeat. The write is conditioned on the job still being PROCESSING
 * (CS-7), so a job that has already settled is never touched — a heartbeat
 * arriving after the settle must not resurrect or re-stamp a finished job.
 *
 * Raw SQL is required because Prisma cannot set a column to the database's
 * current time; it would require a JavaScript Date, reintroducing the clock
 * mismatch this avoids. The id is passed as a bound parameter, not interpolated.
 */
export async function recordHeartbeat(jobId: string): Promise<void> {
  await db.$executeRaw`
    UPDATE "jobs"
    SET "lastHeartbeatAt" = now()
    WHERE "id" = ${jobId}
      AND "status" = 'PROCESSING'::"JobStatus"
  `;
}

/**
 * Starts refreshing the heartbeat until the returned function is called.
 *
 * The caller must call the returned function when the job settles. It clears the
 * timer, so a finished job does not keep an interval alive, and it is safe to
 * call more than once.
 */
export function startHeartbeat(jobId: string, intervalMs: number): () => void {
  const timer = setInterval(() => {
    void recordHeartbeat(jobId).catch((error) => {
      // A failed heartbeat must not crash the worker, but it does need to be
      // visible: it is what allows the sweep to declare the job stalled.
      console.error(`Heartbeat failed for job ${jobId}`, error);
    });
  }, intervalMs);

  // Never hold the process open for a heartbeat.
  timer.unref();

  let stopped = false;
  return () => {
    if (stopped) {
      return;
    }
    stopped = true;
    clearInterval(timer);
  };
}
