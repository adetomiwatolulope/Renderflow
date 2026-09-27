/** Field-level rejection of a submission (CS-12, PR-JOB-001). */
export class InvalidJobSubmissionError extends Error {
  readonly fieldErrors: Readonly<Record<string, string>>;

  constructor(fieldErrors: Record<string, string>) {
    super("Invalid job submission");
    this.name = "InvalidJobSubmissionError";
    this.fieldErrors = fieldErrors;
  }
}

/**
 * PR-IDEM-002 / AGENTS rule 13: an existing idempotency key whose payload does
 * not match is refused outright. No job is created and no job is returned.
 */
export class IdempotencyConflictError extends Error {
  constructor() {
    super("Idempotency key already used with a different payload");
    this.name = "IdempotencyConflictError";
  }
}
