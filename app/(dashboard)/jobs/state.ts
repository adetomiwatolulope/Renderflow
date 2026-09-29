import type { JobPage } from "../../../modules/jobs/list-jobs";

/**
 * State shape for the jobs screen, kept out of `actions.ts` on purpose.
 *
 * A `"use server"` module may only export async functions: Next.js turns every
 * export into a server action reference, and exporting a plain object throws
 * "A 'use server' file can only export async functions, found object" at module
 * evaluation, which fails the whole page.
 */

export type JobsViewState =
  | { readonly status: "idle" }
  | { readonly status: "unauthorized"; readonly message: string }
  | { readonly status: "error"; readonly message: string }
  | {
      readonly status: "loaded";
      readonly listing: JobPage;
      /** True when this page was appended to earlier ones rather than replacing them. */
      readonly appended: boolean;
      readonly filters: { readonly status: string; readonly type: string };
    };

export const INITIAL_JOBS_VIEW_STATE: JobsViewState = { status: "idle" };
