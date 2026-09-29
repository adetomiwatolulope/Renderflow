"use server";

import { resolveAccountIdFromAuthorizationHeader } from "../../../lib/auth/resolve-account";
import {
  InvalidJobListQueryError,
  listJobsForAccount,
} from "../../../modules/jobs/list-jobs";
import type { JobsViewState } from "./state";

/**
 * PR-AUTH-005: the dashboard identifies the operator with the same account API
 * key the API itself uses, submitted through a form.
 *
 * AGENTS rule 4: v1 has no separate dashboard identity, so there is no session, no
 * password and no cookie here. The key arrives in the POST body, is used once to
 * resolve an account, and is never echoed into the returned state, the HTML or a
 * log. A refresh asks for it again.
 *
 * PR-JOB-005 filters and cursor are read from the same function the public route
 * uses, so the screen cannot drift from the API's idea of what is listable.
 *
 * This module exports only the async action. The state type and its initial value
 * live in `./state`, because a `"use server"` file that exports a plain object
 * fails to load.
 */

function readFilter(formData: FormData, field: string): string {
  const value = formData.get(field);
  return typeof value === "string" ? value : "";
}

export async function loadJobs(
  previousState: JobsViewState,
  formData: FormData,
): Promise<JobsViewState> {
  const submitted = formData.get("apiKey");
  const intent = formData.get("intent");

  if (typeof submitted !== "string" || submitted.trim().length === 0) {
    return { status: "unauthorized", message: "Enter your account API key." };
  }

  const accountId = await resolveAccountIdFromAuthorizationHeader(
    `Bearer ${submitted.trim()}`,
  );

  // PR-AUTH-001: the message does not distinguish a malformed key from a valid key
  // belonging to no account, so this cannot be used to probe which keys exist.
  if (accountId === null) {
    return { status: "unauthorized", message: "That API key was not recognised." };
  }

  const status = readFilter(formData, "status");
  const type = readFilter(formData, "type");
  const cursor = intent === "more" ? readFilter(formData, "cursor") : "";

  try {
    const listing = await listJobsForAccount(accountId, {
      status: status === "" ? undefined : status,
      type: type === "" ? undefined : type,
      cursor: cursor === "" ? undefined : cursor,
    });

    // "Load more" extends the current result; a fresh lookup replaces it.
    //
    // Appending is only allowed when the previous result was produced by the same
    // filters, otherwise a changed filter would page onward from a cursor that
    // belongs to a different result set. The comparison is here rather than in the
    // component so the accumulated list is always server-derived.
    const sameFilters =
      previousState.status === "loaded" &&
      previousState.filters.status === status &&
      previousState.filters.type === type;

    if (intent === "more" && sameFilters) {
      return {
        status: "loaded",
        listing: {
          jobs: [...previousState.listing.jobs, ...listing.jobs],
          nextCursor: listing.nextCursor,
        },
        appended: true,
        filters: { status, type },
      };
    }

    return { status: "loaded", listing, appended: false, filters: { status, type } };
  } catch (error) {
    if (error instanceof InvalidJobListQueryError) {
      return { status: "error", message: error.message };
    }
    // CS-10: the cause goes to the server log, not to the operator's screen.
    console.error("Jobs view failed", error);
    return { status: "error", message: "Jobs could not be loaded." };
  }
}
