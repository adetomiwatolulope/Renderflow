"use client";

import { useActionState } from "react";

import { loadDeadLetters } from "./actions";
import { INITIAL_DEAD_LETTER_STATE } from "./state";
import type { DeadJobSummary } from "../../../modules/jobs/list-dead-jobs";
import "./dead-letters.css";

/**
 * The dead-letter view: a login form and a read-only list of the jobs that need a
 * human. There is no control here that changes a job's state, because manual
 * replay is a v2 feature (see modules/jobs/list-dead-jobs.ts).
 */

function formatWhen(iso: string | null): string {
  if (iso === null) {
    return "unknown";
  }
  return new Date(iso).toISOString().replace("T", " ").replace(".000Z", "Z");
}

function DeadJobCard({ job }: { job: DeadJobSummary }) {
  return (
    <li className="dead-card">
      <div className="dead-card__header">
        <span className="dead-badge typography-label-medium">DEAD</span>
        <span className="dead-card__type typography-label-medium">{job.type}</span>
        <span className="dead-card__attempts typography-body-small">
          {job.attempts} of {job.maxAttempts} attempts used
        </span>
      </div>

      <dl className="dead-card__meta typography-body-small">
        <dt>Job</dt>
        <dd>
          <code>{job.id}</code>
        </dd>
        <dt>Failed at</dt>
        <dd>{formatWhen(job.finishedAt)}</dd>
        <dt>Created</dt>
        <dd>{formatWhen(job.createdAt)}</dd>
      </dl>

      <div className="dead-card__block">
        <h3 className="dead-card__heading typography-title-small">Last error</h3>
        {job.lastError === null || job.lastError.length === 0 ? (
          <p className="dead-card__empty typography-body-small">
            No error was recorded for this job.
          </p>
        ) : (
          <p className="dead-card__error typography-body-small">{job.lastError}</p>
        )}
      </div>

      <div className="dead-card__block">
        <h3 className="dead-card__heading typography-title-small">Payload</h3>
        <pre className="dead-card__payload typography-body-small">
          {JSON.stringify(job.payload, null, 2)}
        </pre>
      </div>
    </li>
  );
}

export function DeadLetterView() {
  const [state, submit, pending] = useActionState(
    loadDeadLetters,
    INITIAL_DEAD_LETTER_STATE,
  );

  const unauthorized = state.status === "unauthorized";
  const listing = state.status === "loaded" ? state.listing : null;
  const errorId = "api-key-error";

  return (
    <div className="dead-view">
      <header className="dead-view__header">
        <h1 className="dead-view__title typography-headline-medium">Dead letters</h1>
        <p className="dead-view__subtitle typography-body-medium">
          Jobs that exhausted their retries or failed unrecoverably. This view is
          read-only: re-running a job is not part of this build.
        </p>
      </header>

      <form className="dead-form" action={submit}>
        <label className="dead-form__label typography-label-medium" htmlFor="api-key">
          Account API key
        </label>
        <input
          className="dead-form__input"
          id="api-key"
          name="apiKey"
          type="password"
          autoComplete="off"
          spellCheck={false}
          required
          aria-invalid={unauthorized}
          aria-describedby={unauthorized ? errorId : undefined}
        />
        <button className="dead-form__button typography-label-medium" type="submit" disabled={pending}>
          {pending ? "Checking…" : "View dead jobs"}
        </button>
        {unauthorized ? (
          <p className="dead-form__error typography-body-small" id={errorId} role="alert">
            {state.message}
          </p>
        ) : null}
      </form>

      {listing === null ? null : listing.totalDead === 0 ? (
        // DS-15: an explicit empty state, so a key that resolved to an account
        // with nothing dead is never confused with a rejected key.
        <p className="dead-view__empty typography-body-medium">No dead jobs for this account.</p>
      ) : (
        <section className="dead-results">
          <p className="dead-results__summary typography-body-medium">
            {listing.jobs.length === listing.totalDead
              ? `${listing.totalDead} dead job${listing.totalDead === 1 ? "" : "s"}`
              : `Showing the ${listing.jobs.length} most recent of ${listing.totalDead} dead jobs`}
          </p>
          <ul className="dead-results__list">
            {listing.jobs.map((job) => (
              <DeadJobCard key={job.id} job={job} />
            ))}
          </ul>
          {listing.jobs.length < listing.totalDead ? (
            <p className="dead-results__note typography-body-small">
              {listing.totalDead - listing.jobs.length} older dead jobs are not shown.
              This page lists at most {listing.pageSize}.
            </p>
          ) : null}
        </section>
      )}
    </div>
  );
}
