import type { DeadLetterListing } from "../../../modules/jobs/list-dead-jobs";

/**
 * State shape for the dead-letter view, kept out of `actions.ts` on purpose: a
 * `"use server"` file may only export async functions, and exporting this
 * constant from there would fail the page at module evaluation.
 */

export type DeadLetterViewState =
  | { readonly status: "idle" }
  | { readonly status: "unauthorized"; readonly message: string }
  | { readonly status: "loaded"; readonly listing: DeadLetterListing };

export const INITIAL_DEAD_LETTER_STATE: DeadLetterViewState = { status: "idle" };
