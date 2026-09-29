import type { JobType } from "@prisma/client";

/**
 * PR-RETRY-001: retry configuration is fixed in application code for v1. It is
 * not in the database and there is no API surface to change it (AGENTS rule 8).
 *
 * The PRD marks the exact per-type values as an unconfirmed assumption and
 * names only `EMAIL_DELIVERY: 3` as an illustration. No override has been
 * decided, so the override table is intentionally empty and every type uses the
 * documented default of 5. Adding a value here is the only way a type's
 * maxAttempts ever changes.
 */
export const DEFAULT_MAX_ATTEMPTS = 5;

const MAX_ATTEMPTS_BY_TYPE: Readonly<Partial<Record<JobType, number>>> = {};

export function maxAttemptsForType(type: JobType): number {
  return MAX_ATTEMPTS_BY_TYPE[type] ?? DEFAULT_MAX_ATTEMPTS;
}
