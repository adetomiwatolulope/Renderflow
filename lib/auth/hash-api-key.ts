import { createHash } from "node:crypto";

/**
 * SEC-1: an API key is a high-entropy machine-generated secret, not a
 * user-chosen password, so a slow adaptive hash would only make the
 * per-request `@@index([hashedKey])` lookup expensive. Fast, one-way, and
 * never reversible to the raw key.
 */
export function hashApiKey(rawKey: string): string {
  return createHash("sha256").update(rawKey, "utf8").digest("hex");
}
