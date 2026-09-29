import { db } from "../../lib/db/client";
import { assertHttpsWebhookUrl } from "./endpoint-url";
import { generateWebhookSecret } from "./signature";

/**
 * PR-WEBHOOK-001: an account registers exactly one callback URL. Registering a
 * second URL replaces the first in v1, so this is an upsert on the account's
 * unique `accountId` rather than an insert.
 *
 * The `https://` rule itself lives in `endpoint-url` so it is testable without a
 * database; this file is only the persistence half.
 */

export type RegisteredEndpoint = {
  readonly id: string;
  readonly url: string;
  readonly secret: string;
  readonly replaced: boolean;
};

export async function registerWebhookEndpoint(
  accountId: string,
  rawUrl: string,
): Promise<RegisteredEndpoint> {
  const url = assertHttpsWebhookUrl(rawUrl).toString();

  // A replaced URL gets a fresh secret. Handing back the old secret alongside a
  // new URL would let anyone who had captured it keep forging deliveries for an
  // endpoint it no longer points at.
  const secret = generateWebhookSecret();

  const existing = await db.webhookEndpoint.findUnique({
    where: { accountId },
    select: { id: true },
  });

  const endpoint = await db.webhookEndpoint.upsert({
    where: { accountId },
    create: { accountId, url, secret },
    update: { url, secret },
    select: { id: true, url: true, secret: true },
  });

  return { ...endpoint, replaced: existing !== null };
}
