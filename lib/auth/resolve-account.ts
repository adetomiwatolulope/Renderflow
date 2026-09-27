import "server-only";

import { db } from "../db/client";
import { hashApiKey } from "./hash-api-key";

const BEARER_PREFIX = "Bearer ";

/**
 * PR-AUTH-001: a missing or invalid key resolves to no account, which every
 * caller turns into 401. The lookup goes through `ApiKey.hashedKey`, served by
 * the locked `@@index([hashedKey])` (DB-4).
 *
 * This is the whole of "identifying a user" for v1: no session, no password,
 * no roles (PR-AUTH-005 gives the dashboard the same key, and v1 has none of
 * the rest).
 */
export async function resolveAccountIdFromAuthorizationHeader(
  authorization: string | null,
): Promise<string | null> {
  if (authorization === null || !authorization.startsWith(BEARER_PREFIX)) {
    return null;
  }

  const rawKey = authorization.slice(BEARER_PREFIX.length).trim();
  if (rawKey.length === 0) {
    return null;
  }

  const apiKey = await db.apiKey.findUnique({
    where: { hashedKey: hashApiKey(rawKey) },
    select: { accountId: true },
  });

  return apiKey?.accountId ?? null;
}
