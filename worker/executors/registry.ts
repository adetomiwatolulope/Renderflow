import { JobType } from "@prisma/client";

import type { ExecutorRegistry } from "./types";
import { executeWebhookCall } from "./webhook-call";

/**
 * WEBHOOK_CALL is the one implemented type. It is the only job type whose work
 * needs no third-party credentials and no new dependency, and PR-RETRY-002
 * gives HTTP-backed types an explicit outcome mapping, so it is the type that
 * can actually be exercised end to end.
 *
 * The other five are unregistered on purpose. `executableJobTypes()` is fed to
 * `claimNextJob`, so a job whose type has no executor is never claimed and stays
 * QUEUED — it is not burned to DEAD by attempts that could never have done
 * anything. Registering one is a deliberate, visible change.
 */
const EXECUTORS: ExecutorRegistry = {
  [JobType.WEBHOOK_CALL]: executeWebhookCall,
};

export function resolveExecutor(type: JobType) {
  return EXECUTORS[type] ?? null;
}

export function executableJobTypes(): JobType[] {
  return Object.values(JobType).filter((type) => EXECUTORS[type] !== undefined);
}
