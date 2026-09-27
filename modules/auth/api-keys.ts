import { randomBytes } from "node:crypto";

import { hashApiKey } from "../../lib/auth/hash-api-key";
import { db } from "../../lib/db/client";

/**
 * API key provisioning.
 *
 * The PRD defines no HTTP endpoint for issuing keys, so this is exposed as module
 * functions driven by an operator CLI rather than as a public route. Inventing
 * `POST /v1/keys` would put an unauthenticated bootstrap path on the public API
 * surface, which is a worse trade than an operator running a command. A later
 * version that wants self-service issuance can wrap exactly these functions
 * behind an authenticated route.
 *
 * PR-AUTH-003: the plaintext key is returned once, here, and only its SHA-256
 * hash is ever stored. There is no code path that can read a key back.
 * PR-AUTH-002: exactly one key row exists per account, enforced by
 * `ApiKey.accountId @unique`, so rotation cannot leave a second active key
 * behind.
 */

const KEY_PREFIX = "rf_";
/** Characters kept for operator-facing identification. Never used to authorise. */
const DISPLAY_PREFIX_LENGTH = 12;
const SECRET_BYTES = 32;

function generateRawKey(): string {
  return `${KEY_PREFIX}${randomBytes(SECRET_BYTES).toString("base64url")}`;
}

export type IssuedApiKey = {
  readonly accountId: string;
  /** Plaintext. Returned once; store it now, it cannot be retrieved later. */
  readonly apiKey: string;
  /** Safe to display and log. Not a secret. */
  readonly prefix: string;
  readonly rotatedAt: Date | null;
};

export class AccountHasNoApiKeyError extends Error {
  constructor(accountId: string) {
    super(`Account ${accountId} has no API key to rotate`);
    this.name = "AccountHasNoApiKeyError";
  }
}

export class AccountNameTakenError extends Error {
  constructor(name: string) {
    super(`An account named "${name}" already exists`);
    this.name = "AccountNameTakenError";
  }
}

export async function createAccountWithApiKey(name: string): Promise<IssuedApiKey> {
  const trimmed = name.trim();
  if (trimmed.length === 0) {
    throw new Error("Account name must not be empty");
  }

  const rawKey = generateRawKey();
  const prefix = rawKey.slice(0, DISPLAY_PREFIX_LENGTH);

  try {
    return await db.$transaction(async (tx) => {
      const account = await tx.account.create({ data: { name: trimmed } });
      await tx.apiKey.create({
        data: { accountId: account.id, hashedKey: hashApiKey(rawKey), prefix },
      });
      return { accountId: account.id, apiKey: rawKey, prefix, rotatedAt: null };
    });
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error as { code?: string }).code === "P2002"
    ) {
      throw new AccountNameTakenError(trimmed);
    }
    throw error;
  }
}

/**
 * Replaces the account's key in place. The old hash is overwritten in the same
 * statement, so the previous key stops authenticating the moment this returns —
 * there is no window where both keys are valid (PR-AUTH-002).
 *
 * Overwriting rather than inserting is what keeps the one-key invariant: a second
 * row would violate `accountId @unique` anyway, and a delete-then-insert pair
 * would briefly leave the account unable to authenticate at all.
 */
export async function rotateApiKey(accountId: string): Promise<IssuedApiKey> {
  const rawKey = generateRawKey();
  const prefix = rawKey.slice(0, DISPLAY_PREFIX_LENGTH);
  const now = new Date();

  return db.$transaction(async (tx) => {
    // CS-7: the rotation is the write. Asserting the count means an unknown
    // account fails loudly here instead of appearing to succeed and returning a
    // key that was never stored.
    const updated = await tx.apiKey.updateMany({
      where: { accountId },
      data: { hashedKey: hashApiKey(rawKey), prefix, rotatedAt: now },
    });

    if (updated.count !== 1) {
      throw new AccountHasNoApiKeyError(accountId);
    }

    return { accountId, apiKey: rawKey, prefix, rotatedAt: now };
  });
}
