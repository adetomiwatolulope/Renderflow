import { test } from "node:test";
import assert from "node:assert/strict";

import { db } from "../../lib/db/client";
import { createAccountWithApiKey } from "../../modules/auth/api-keys";
import { loadJobs } from "../../app/(dashboard)/jobs/actions";
import { INITIAL_JOBS_VIEW_STATE } from "../../app/(dashboard)/jobs/state";
import { JobStatus } from "@prisma/client";

/**
 * The dashboard jobs screen reuses the account API key as its identity
 * (PR-AUTH-005, AGENTS rule 4). These tests cover the screen's own rules: the key
 * is required, a bad key is refused without revealing whether it exists, results
 * are scoped to one account, filters are passed through to PR-JOB-005, and paging
 * appends only within one filter set.
 */

function form(entries: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(entries)) {
    data.set(key, value);
  }
  return data;
}

async function clearAccount(accountId: string): Promise<void> {
  await db.jobAttempt.deleteMany({ where: { job: { accountId } } });
  await db.jobOutput.deleteMany({ where: { job: { accountId } } });
  await db.job.deleteMany({ where: { accountId } });
  await db.apiKey.deleteMany({ where: { accountId } });
  await db.account.deleteMany({ where: { id: accountId } });
}

async function seed(accountId: string, label: string, count: number): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const job = await db.job.create({
      data: {
        accountId,
        type: "WEBHOOK_CALL",
        payload: {},
        idempotencyKey: `${label}-${i}-${Date.now()}`,
        status: i % 2 === 0 ? JobStatus.SUCCEEDED : JobStatus.DEAD,
        attempts: 1,
        maxAttempts: 5,
        finishedAt: new Date(),
      },
      select: { id: true },
    });
    ids.push(job.id);
  }
  return ids;
}

test("an empty key is refused before any lookup", async () => {
  const state = await loadJobs(INITIAL_JOBS_VIEW_STATE, form({ apiKey: "   " }));
  assert.equal(state.status, "unauthorized");
});

test("PR-AUTH-001: an unrecognised key is refused with a non-specific message", async () => {
  const state = await loadJobs(
    INITIAL_JOBS_VIEW_STATE,
    form({ apiKey: "rf_definitely_not_a_real_key" }),
  );

  assert.equal(state.status, "unauthorized");
  if (state.status === "unauthorized") {
    assert.match(state.message, /not recognised/i);
    assert.doesNotMatch(state.message, /exist|invalid key format/i);
  }
});

test("a valid key lists only that account's jobs", async () => {
  const mine = await createAccountWithApiKey(`screen-mine-${Date.now()}`);
  const theirs = await createAccountWithApiKey(`screen-theirs-${Date.now()}`);

  try {
    const mineIds = await seed(mine.accountId, "mine", 3);
    const theirIds = await seed(theirs.accountId, "theirs", 2);

    const state = await loadJobs(INITIAL_JOBS_VIEW_STATE, form({ apiKey: mine.apiKey }));
    assert.equal(state.status, "loaded");
    if (state.status !== "loaded") return;

    const shown = state.listing.jobs.map((job) => job.id);
    for (const id of mineIds) {
      assert.ok(shown.includes(id), "own job should be listed");
    }
    for (const id of theirIds) {
      assert.ok(!shown.includes(id), "another account's job must never be listed");
    }
  } finally {
    await clearAccount(mine.accountId);
    await clearAccount(theirs.accountId);
  }
});

test("the status filter is applied", async () => {
  const account = await createAccountWithApiKey(`screen-filter-${Date.now()}`);
  try {
    await seed(account.accountId, "filtered", 4);

    const state = await loadJobs(
      INITIAL_JOBS_VIEW_STATE,
      form({ apiKey: account.apiKey, status: "SUCCEEDED" }),
    );

    assert.equal(state.status, "loaded");
    if (state.status !== "loaded") return;
    assert.ok(state.listing.jobs.length > 0);
    assert.ok(state.listing.jobs.every((job) => job.status === "SUCCEEDED"));
  } finally {
    await clearAccount(account.accountId);
  }
});

test("an invalid filter surfaces an error rather than an empty list", async () => {
  const account = await createAccountWithApiKey(`screen-badfilter-${Date.now()}`);
  try {
    const state = await loadJobs(
      INITIAL_JOBS_VIEW_STATE,
      form({ apiKey: account.apiKey, status: "NOT_A_STATUS" }),
    );

    assert.equal(state.status, "error");
    if (state.status === "error") {
      assert.match(state.message, /status/i);
    }
  } finally {
    await clearAccount(account.accountId);
  }
});

test("a search replaces the previous result set", async () => {
  const account = await createAccountWithApiKey(`screen-replace-${Date.now()}`);
  try {
    await seed(account.accountId, "replace", 6);

    const first = await loadJobs(
      INITIAL_JOBS_VIEW_STATE,
      form({ apiKey: account.apiKey, intent: "search" }),
    );
    assert.equal(first.status, "loaded");
    if (first.status !== "loaded") return;

    const second = await loadJobs(
      first,
      form({ apiKey: account.apiKey, intent: "search" }),
    );
    assert.equal(second.status, "loaded");
    if (second.status !== "loaded") return;

    assert.equal(second.appended, false, "a fresh search must not accumulate");
    assert.ok(second.listing.jobs.length <= 6, "results must not grow on a repeat search");
  } finally {
    await clearAccount(account.accountId);
  }
});

test("paging appends within one filter set and stops at the last page", async () => {
  const account = await createAccountWithApiKey(`screen-page-${Date.now()}`);
  try {
    const ids = await seed(account.accountId, "paged", 5);

    let state = await loadJobs(INITIAL_JOBS_VIEW_STATE, form({ apiKey: account.apiKey }));
    assert.equal(state.status, "loaded");
    if (state.status !== "loaded") return;

    const seen = [...state.listing.jobs.map((job) => job.id)];
    let pages = 1;

    while (state.status === "loaded" && state.listing.nextCursor !== null && pages < 10) {
      const next = await loadJobs(
        state,
        form({
          apiKey: account.apiKey,
          intent: "more",
          cursor: state.listing.nextCursor,
        }),
      );
      if (next.status !== "loaded") break;

      assert.equal(next.appended, true);
      seen.push(...next.listing.jobs.map((job) => job.id));
      state = next;
      pages += 1;
    }

    assert.deepEqual([...seen].sort(), [...ids].sort(), "every job appears exactly once");
    assert.equal(new Set(seen).size, seen.length, "no job repeated across pages");
  } finally {
    await clearAccount(account.accountId);
  }
});

test("paging with a changed filter does not append to the old result set", async () => {
  const account = await createAccountWithApiKey(`screen-switch-${Date.now()}`);
  try {
    await seed(account.accountId, "switch", 4);

    const first = await loadJobs(INITIAL_JOBS_VIEW_STATE, form({ apiKey: account.apiKey }));
    assert.equal(first.status, "loaded");
    if (first.status !== "loaded") return;

    const cursor = first.listing.nextCursor;
    const second = await loadJobs(
      first,
      form({ apiKey: account.apiKey, intent: "more", cursor: cursor ?? "", status: "DEAD" }),
    );

    assert.equal(second.status, "loaded");
    if (second.status !== "loaded") return;
    assert.equal(second.appended, false, "a filter change must start a new result set");
    assert.ok(second.listing.jobs.every((job) => job.status === "DEAD"));
  } finally {
    await clearAccount(account.accountId);
  }
});

test("a rotated key stops working on the screen, as it does on the API", async () => {
  const account = await createAccountWithApiKey(`screen-rotate-${Date.now()}`);
  try {
    const before = await loadJobs(INITIAL_JOBS_VIEW_STATE, form({ apiKey: account.apiKey }));
    assert.equal(before.status, "loaded");

    const { rotateApiKey } = await import("../../modules/auth/api-keys");
    const rotated = await rotateApiKey(account.accountId);

    const withOld = await loadJobs(INITIAL_JOBS_VIEW_STATE, form({ apiKey: account.apiKey }));
    assert.equal(withOld.status, "unauthorized", "the old key must stop working");

    const withNew = await loadJobs(INITIAL_JOBS_VIEW_STATE, form({ apiKey: rotated.apiKey }));
    assert.equal(withNew.status, "loaded", "the new key must work immediately");
  } finally {
    await clearAccount(account.accountId);
  }
});
