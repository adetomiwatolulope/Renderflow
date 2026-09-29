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
 * PR-JOB-008 / AGENTS rule 7: a payload over the cap is refused with 413, not
 * 422.
 *
 * A distinct class so the route maps it to the right status without matching on
 * a message string. It extends `InvalidJobSubmissionError` because it *is* a
 * rejection of the submission, so any caller that only needs to know the body was
 * refused keeps working unchanged - but the route must test for this class first,
 * because it is a subclass and would otherwise be caught by the generic 422 branch.
 */
export class PayloadTooLargeError extends InvalidJobSubmissionError {
  readonly byteLimit: number;

  constructor(byteLimit: number) {
    super({ payload: `payload exceeds the ${byteLimit} byte limit` });
    this.name = "PayloadTooLargeError";
    this.byteLimit = byteLimit;
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
