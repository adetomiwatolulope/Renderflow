/** PR-RETRY-001: `min(30s * 2^(attemptNumber - 1), 30min)`, fixed in code. */
export const BACKOFF_BASE_MS = 30_000;
export const BACKOFF_MAX_MS = 30 * 60_000;

/**
 * Owner's Step 4: a random offset is added to the exponential term, so a hundred
 * jobs that failed in the same instant do not all retry in the same instant and
 * stampede the same dependency again.
 *
 * The random component is a fraction of the exponential term rather than a flat
 * constant, because a flat offset stops mattering once the exponential term
 * dwarfs it and the herd returns.
 */
export const JITTER_RATIO = 0.5;

/**
 * @param attemptNumber 1-based number of the attempt that just failed, so the
 * first failure waits one base delay and each later one doubles.
 * @param random Entropy source, injectable so the jitter is deterministically
 * testable. Defaults to `Math.random`.
 *
 * PR-RETRY-001's cap applies to the total delay, jitter included, so the jitter
 * may only use the headroom left between the exponential term and that cap. A
 * consequence is that once the exponential term reaches the cap there is no
 * headroom left and the delay is exactly the cap; capping the exponential term
 * below the cap instead would silently shorten the maximum delay.
 *
 * Owner Step 4 words the term as `base * 2^attempts`, which is one doubling
 * ahead of PR-RETRY-001's `base * 2^(attemptNumber - 1)`. The PRD's form is used
 * because the owner's wording was explicitly approximate ("something like") and
 * the PRD is the precise source. Change `attemptNumber - 1` to `attemptNumber`
 * here if the owner's reading was intended.
 */
export function backoffDelayMs(
  attemptNumber: number,
  random: () => number = Math.random,
): number {
  const exponent = Math.max(0, attemptNumber - 1);
  const exponential = Math.min(BACKOFF_BASE_MS * 2 ** exponent, BACKOFF_MAX_MS);
  const jitterCeiling = BACKOFF_MAX_MS - exponential;
  const jitter = Math.floor(Math.min(exponential * JITTER_RATIO, jitterCeiling) * random());
  return exponential + jitter;
}

/**
 * When a failed job becomes claimable again (PR-JOB-004). Always strictly in the
 * future, so the claim query cannot pick the job straight back up and spin.
 */
export function nextRunAt(now: Date, attemptNumber: number, random?: () => number): Date {
  return new Date(now.getTime() + backoffDelayMs(attemptNumber, random));
}
