import { JobType } from "@prisma/client";

import { InvalidJobSubmissionError } from "./errors";
import type { JsonObject, JsonValue } from "./json-value";

/** PR-JOB-008: the cap is on the serialized JSON byte size of `payload`. */
export const MAX_PAYLOAD_BYTES = 256 * 1024;

const JOB_TYPE_VALUES: readonly string[] = Object.values(JobType);

const ALLOWED_FIELDS: ReadonlySet<string> = new Set(["type", "payload", "idempotencyKey"]);

/**
 * Every other top-level field is refused, so a client can never set something
 * the server owns (AGENTS rule 5, CS-12). `priority` and `scheduledFor` do not
 * exist in v1 at all; `maxAttempts` comes from the fixed per-type config
 * (PR-RETRY-001); `status`, `attempts` and the lifecycle timestamps are worker
 * decisions. A tailored message for the ones a caller is most likely to try;
 * anything unrecognised is refused with a generic one.
 */
const SERVER_OWNED_FIELD_MESSAGES: Readonly<Record<string, string>> = {
  priority: "priority does not exist in v1",
  scheduledFor: "scheduledFor does not exist in v1",
  maxAttempts: "maxAttempts is set by the server and cannot be overridden",
  status: "status is set by the server and cannot be set on submission",
  attempts: "attempts is set by the server",
  runAt: "runAt is set by the server",
  result: "result is set by the server",
  lastError: "lastError is set by the server",
  accountId: "accountId comes from the API key and cannot be set on submission",
};

export type ValidatedJobSubmission = {
  type: JobType;
  payload: JsonObject;
  idempotencyKey: string;
};

type ParsedJson =
  | { readonly ok: true; readonly value: JsonValue }
  | { readonly ok: false };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJobType(value: unknown): value is JobType {
  return typeof value === "string" && JOB_TYPE_VALUES.includes(value);
}

function isJsonObject(value: JsonValue): value is JsonObject {
  return isPlainObject(value);
}

/**
 * CS-1: request data is parsed into a JSON type, never asserted into one. This
 * rejects anything JSON cannot represent (non-finite numbers, functions, class
 * instances), so nothing unserializable reaches the column.
 */
function parseJsonValue(value: unknown): ParsedJson {
  if (value === null) {
    return { ok: true, value: null };
  }

  if (typeof value === "string" || typeof value === "boolean") {
    return { ok: true, value };
  }

  if (typeof value === "number") {
    return Number.isFinite(value) ? { ok: true, value } : { ok: false };
  }

  if (Array.isArray(value)) {
    const items: JsonValue[] = [];
    for (const item of value) {
      const parsed = parseJsonValue(item);
      if (!parsed.ok) {
        return { ok: false };
      }
      items.push(parsed.value);
    }
    return { ok: true, value: items };
  }

  if (isPlainObject(value)) {
    const object: JsonObject = {};
    for (const [key, nested] of Object.entries(value)) {
      const parsed = parseJsonValue(nested);
      if (!parsed.ok) {
        return { ok: false };
      }
      object[key] = parsed.value;
    }
    return { ok: true, value: object };
  }

  return { ok: false };
}

/**
 * CS-12: runs on the server regardless of what any client validated, and before
 * any row is written, since PR-JOB-008's rejection must leave no job behind.
 */
export function validateJobSubmission(body: unknown): ValidatedJobSubmission {
  if (!isPlainObject(body)) {
    throw new InvalidJobSubmissionError({
      body: "Request body must be a JSON object",
    });
  }

  const fieldErrors: Record<string, string> = {};

  for (const field of Object.keys(body)) {
    if (!ALLOWED_FIELDS.has(field)) {
      fieldErrors[field] = SERVER_OWNED_FIELD_MESSAGES[field] ?? "Unrecognised field";
    }
  }

  let type: JobType | null = null;
  if (isJobType(body.type)) {
    type = body.type;
  } else {
    fieldErrors.type = `type must be one of: ${JOB_TYPE_VALUES.join(", ")}`;
  }

  let idempotencyKey: string | null = null;
  if (typeof body.idempotencyKey === "string" && body.idempotencyKey.trim().length > 0) {
    idempotencyKey = body.idempotencyKey;
  } else {
    fieldErrors.idempotencyKey = "idempotencyKey is required and must be a non-empty string";
  }

  let payload: JsonObject | null = null;
  if (!isPlainObject(body.payload)) {
    fieldErrors.payload = "payload is required and must be a JSON object";
  } else if (Buffer.byteLength(JSON.stringify(body.payload), "utf8") > MAX_PAYLOAD_BYTES) {
    // PR-JOB-008. Raised ahead of the other field errors so an oversized payload
    // is reported on its own rather than alongside unrelated complaints.
    throw new InvalidJobSubmissionError({
      payload: `payload exceeds the ${MAX_PAYLOAD_BYTES} byte limit`,
    });
  } else {
    const parsed = parseJsonValue(body.payload);
    if (parsed.ok && isJsonObject(parsed.value)) {
      payload = parsed.value;
    } else {
      fieldErrors.payload = "payload must be a JSON-serializable object";
    }
  }

  if (Object.keys(fieldErrors).length > 0) {
    throw new InvalidJobSubmissionError(fieldErrors);
  }

  if (type === null || idempotencyKey === null || payload === null) {
    // Unreachable: each null above already recorded a field error and threw.
    // Present so the return needs no assertion on request data (CS-1).
    throw new InvalidJobSubmissionError({ body: "Malformed submission" });
  }

  return { type, payload, idempotencyKey };
}
