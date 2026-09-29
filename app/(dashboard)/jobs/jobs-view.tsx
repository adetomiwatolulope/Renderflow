"use client";

import { useActionState } from "react";

import { loadJobs } from "./actions";
import { INITIAL_JOBS_VIEW_STATE } from "./state";
import type { JobResponse } from "../../../modules/jobs/dto";
import "./jobs.css";

/**
 * Read-only job list. Nothing on this screen changes a job's state: v1 has no
 * manual retry and no job mutation from the dashboard (see the dead-letter view
 * for the same constraint).
 *
 * The screen reuses the API key the caller already has rather than introducing a
 * second identity (AGENTS rule 4, PR-AUTH-005).
 *
 * The option lists and the badge switch use plain string literals rather than the
 * Prisma enums. This is a client component, so importing `@prisma/client` for its
 * runtime values would pull the Prisma engine into the browser bundle and break
 * the page. `import type` is erased at compile time, which is why the response
 * type below is still safe to import.
 */

const STATUS_OPTIONS = [
  "QUEUED",
  "PROCESSING",
  "SUCCEEDED",
  "FAILED",
  "DEAD",
] as const;

const TYPE_OPTIONS = [
  "PDF_GENERATION",
  "IMAGE_PROCESSING",
  "EMAIL_DELIVERY",
  "AI_REQUEST",
  "WEBHOOK_CALL",
  "CUSTOM",
] as const;

function formatWhen(iso: Date | string | null): string {
  if (iso === null) {
    return "—";
  }
  return new Date(iso).toISOString().replace("T", " ").replace(".000Z", "Z");
}

/**
 * One role token pair per status, so the badge reads the same way everywhere and
 * no status is signalled by colour alone: the status word is always present.
 */
function statusBadgeClass(status: JobResponse["status"]): string {
  switch (status) {
    case "SUCCEEDED":
      return "jobs-badge jobs-badge--succeeded";
    case "FAILED":
      return "jobs-badge jobs-badge--failed";
    case "DEAD":
      return "jobs-badge jobs-badge--dead";
    case "PROCESSING":
      return "jobs-badge jobs-badge--processing";
    case "QUEUED":
      return "jobs-badge jobs-badge--queued";
    default: {
      const exhaustive: never = status;
      return exhaustive;
    }
  }
}

function attemptsLabel(job: JobResponse): string {
  return `${job.attempts}/${job.maxAttempts}`;
}

function JobRow({ job }: { job: JobResponse }) {
  return (
    <tr>
      <td className="jobs-table__id">
        <code>{job.id}</code>
      </td>
      <td>{job.type}</td>
      <td>
        <span className={statusBadgeClass(job.status)}>{job.status}</span>
      </td>
      <td className="jobs-table__numeric">{attemptsLabel(job)}</td>
      <td>{formatWhen(job.createdAt)}</td>
      <td>{formatWhen(job.finishedAt)}</td>
      <td className="jobs-table__error">
        {job.lastError === null || job.lastError.length === 0 ? (
          <span className="jobs-table__none">—</span>
        ) : (
          job.lastError
        )}
      </td>
    </tr>
  );
}

function JobTable({ jobs }: { jobs: readonly JobResponse[] }) {
  return (
    <table className="jobs-table">
      <thead>
        <tr>
          <th scope="col">Job</th>
          <th scope="col">Type</th>
          <th scope="col">Status</th>
          <th scope="col">Attempts</th>
          <th scope="col">Created</th>
          <th scope="col">Finished</th>
          <th scope="col">Last error</th>
        </tr>
      </thead>
      <tbody>
        {jobs.map((job) => (
          <JobRow key={job.id} job={job} />
        ))}
      </tbody>
    </table>
  );
}

export function JobsView() {
  const [state, submit, pending] = useActionState(loadJobs, INITIAL_JOBS_VIEW_STATE);

  const unauthorized = state.status === "unauthorized";
  const errored = state.status === "error";
  const errorId = "jobs-key-error";
  const messageId = "jobs-message";

  // "Load more" submits the key again; it is never stored in component state or a
  // hidden field beyond this form, and never rendered back to the operator.
  const loaded = state.status === "loaded" ? state : null;
  const jobs: readonly JobResponse[] = loaded === null ? [] : loaded.listing.jobs;
  const filters = loaded?.filters ?? { status: "", type: "" };

  return (
    <div className="jobs-view">
      <header className="jobs-view__header">
        <h1 className="jobs-view__title typography-headline-medium">Jobs</h1>
        <p className="jobs-view__subtitle typography-body-medium">
          Every job for one account, newest first. Read-only: this build has no way to
          re-run or cancel a job.
        </p>
      </header>

      <form className="jobs-form" action={submit}>
        <div className="jobs-form__row">
          <div className="jobs-form__field">
            <label className="jobs-form__label typography-label-medium" htmlFor="api-key">
              Account API key
            </label>
            <input
              className="jobs-form__input"
              id="api-key"
              name="apiKey"
              type="password"
              autoComplete="off"
              spellCheck={false}
              required
              aria-invalid={unauthorized}
              aria-describedby={unauthorized ? errorId : undefined}
            />
          </div>

          <div className="jobs-form__field">
            <label className="jobs-form__label typography-label-medium" htmlFor="status">
              Status
            </label>
            <select
              className="jobs-form__select"
              id="status"
              name="status"
              defaultValue={filters.status}
            >
              <option value="">All</option>
              {STATUS_OPTIONS.map((status) => (
                <option key={status} value={status}>
                  {status}
                </option>
              ))}
            </select>
          </div>

          <div className="jobs-form__field">
            <label className="jobs-form__label typography-label-medium" htmlFor="type">
              Type
            </label>
            <select
              className="jobs-form__select"
              id="type"
              name="type"
              defaultValue={filters.type}
            >
              <option value="">All</option>
              {TYPE_OPTIONS.map((type) => (
                <option key={type} value={type}>
                  {type}
                </option>
              ))}
            </select>
          </div>
        </div>

        {loaded !== null && loaded.listing.nextCursor !== null ? (
          // The cursor lives in the same form as the key so paging onward never
          // needs the key held in component state or written into the HTML
          // (AGENTS rule 4: the key is submitted, never persisted).
          <input type="hidden" name="cursor" value={loaded.listing.nextCursor} />
        ) : null}

        <div className="jobs-form__actions">
          <button
            className="jobs-form__button typography-label-medium"
            type="submit"
            name="intent"
            value="search"
            disabled={pending}
          >
            {pending ? "Loading…" : "View jobs"}
          </button>

          {loaded !== null && loaded.listing.nextCursor !== null ? (
            <button
              className="jobs-form__button typography-label-medium"
              type="submit"
              name="intent"
              value="more"
              disabled={pending}
            >
              Load more
            </button>
          ) : null}
        </div>

        {unauthorized || errored ? (
          <p
            className="jobs-form__error typography-body-small"
            id={unauthorized ? errorId : messageId}
            role="alert"
          >
            {unauthorized || errored ? state.message : null}
          </p>
        ) : null}
      </form>

      {loaded === null ? null : jobs.length === 0 ? (
        // DS-15: an explicit empty state, so a valid key with no matching jobs is
        // never mistaken for a rejected key.
        <p className="jobs-view__empty typography-body-medium">
          No jobs match these filters for this account.
        </p>
      ) : (
        <section className="jobs-results" aria-label="Jobs">
          <div className="jobs-results__scroll">
            <JobTable jobs={jobs} />
          </div>

          <p className="jobs-results__summary typography-body-small">
            {loaded.appended
              ? `${jobs.length} jobs loaded so far`
              : `Showing ${jobs.length} job${jobs.length === 1 ? "" : "s"}`}
          </p>
        </section>
      )}
    </div>
  );
}
