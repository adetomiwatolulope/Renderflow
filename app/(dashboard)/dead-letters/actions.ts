"use server";

import { resolveAccountIdFromAuthorizationHeader } from "../../../lib/auth/resolve-account";
import { listDeadJobsForAccount } from "../../../modules/jobs/list-dead-jobs";
import type { DeadLetterViewState } from "./state";

/**
 * PR-AUTH-005: the dashboard identifies the operator with the same account API
 * key the API itself uses, submitted through a form.
 *
 * AGENTS rule 4: v1 has no separate dashboard identity, so there is no session,
 * no password, and no cookie here. The key arrives in the POST body, is used once
 * to resolve an account, and is never echoed back into the returned state, the
 * HTML, or a log. Nothing is persisted, so a page refresh asks for it again.
 *
 * The state type and its initial value live in `./state`: this module exports only
 * the async action, because a `"use server"` file that also exports a plain object
 * fails to load.
 */

export async function loadDeadLetters(
  _previousState: DeadLetterViewState,
  formData: FormData,
): Promise<DeadLetterViewState> {
  const submitted = formData.get("apiKey");

  if (typeof submitted !== "string" || submitted.trim().length === 0) {
    return { status: "unauthorized", message: "Enter your account API key." };
  }

  const accountId = await resolveAccountIdFromAuthorizationHeader(
    `Bearer ${submitted.trim()}`,
  );

  // PR-AUTH-001: an unknown key resolves to no account. The message does not
  // distinguish a malformed key from a valid key belonging to no account, so this
  // cannot be used to probe which keys exist.
  if (accountId === null) {
    return { status: "unauthorized", message: "That API key was not recognised." };
  }

  const listing = await listDeadJobsForAccount(accountId);
  return { status: "loaded", listing };
}
