import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * PR-WEBHOOK-003: every delivery is signed with an HMAC over the exact bytes sent,
 * using a per-account secret, in `X-RenderFlow-Signature`.
 *
 * The signature covers the raw body rather than a re-serialised version of it. If
 * the signer and the sender disagreed about key order or spacing the caller's
 * verification would fail intermittently, and debugging that is miserable, so the
 * payload is serialised exactly once and the same string is both signed and sent.
 */

export const SIGNATURE_HEADER = "X-RenderFlow-Signature";

/**
 * `sha256=<hex>` prefix so the scheme is self-describing and a future key rotation
 * can introduce a second algorithm without changing the header.
 */
const SIGNATURE_PREFIX = "sha256=";

export function signWebhookPayload(secret: string, rawBody: string): string {
  const mac = createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
  return `${SIGNATURE_PREFIX}${mac}`;
}

/** Provided so callers can test verification with the same comparison we use. */
export function verifyWebhookSignature(
  secret: string,
  rawBody: string,
  signatureHeader: string,
): boolean {
  if (!signatureHeader.startsWith(SIGNATURE_PREFIX)) {
    return false;
  }
  const received = signatureHeader.slice(SIGNATURE_PREFIX.length);
  const expected = signWebhookPayload(secret, rawBody).slice(SIGNATURE_PREFIX.length);

  const receivedBytes = Buffer.from(received, "utf8");
  const expectedBytes = Buffer.from(expected, "utf8");

  // timingSafeEqual throws on a length mismatch, and the length of a digest is
  // not itself secret, so an early length check is both safe and necessary.
  if (receivedBytes.length !== expectedBytes.length) {
    return false;
  }
  return timingSafeEqual(receivedBytes, expectedBytes);
}

/**
 * The caller's secret, generated server-side. 32 bytes of CSPRNG output: this is
 * a long-lived shared secret that the caller verifies with, so it gets the same
 * treatment as our own key material.
 */
export function generateWebhookSecret(): string {
  return `whsec_${randomBytes(32).toString("base64url")}`;
}
