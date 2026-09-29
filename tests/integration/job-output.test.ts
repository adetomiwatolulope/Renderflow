import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";

import { JobType } from "@prisma/client";

import { db } from "../../lib/db/client";
import {
  findJobOutput,
  produceOutputOnce,
  recordJobOutput,
} from "../../modules/jobs/outputs";

/**
 * Owner's Step 5: check whether the output already exists before producing it,
 * with the job id as the key. Requires a reachable PostgreSQL.
 */

const accountIds: string[] = [];

async function createJob(): Promise<string> {
  const account = await db.account.create({
    data: { name: `test-${randomUUID()}` },
    select: { id: true },
  });
  accountIds.push(account.id);

  const job = await db.job.create({
    data: {
      accountId: account.id,
      type: JobType.CUSTOM,
      payload: {},
      idempotencyKey: randomUUID(),
    },
    select: { id: true },
  });

  return job.id;
}

before(async () => {
  await db.$connect();
});

after(async () => {
  await db.jobOutput.deleteMany({});
  await db.jobAttempt.deleteMany({});
  await db.job.deleteMany({});
  await db.apiKey.deleteMany({});
  await db.account.deleteMany({ where: { id: { in: accountIds } } });
  await db.$disconnect();
});

test("a job with no output yet has none", async () => {
  const jobId = await createJob();
  assert.equal(await findJobOutput(jobId), null);
});

test("recording an output stores only a url reference", async () => {
  const jobId = await createJob();
  const url = `https://storage.example.com/outputs/${jobId}.pdf`;

  const { output, created } = await recordJobOutput({ jobId, url });
  assert.equal(created, true);
  assert.equal(output.url, url);
  assert.equal(output.jobId, jobId);
});

// The whole point: a second run must not produce a second output.
test("a second run finds the existing output and does not produce again", async () => {
  const jobId = await createJob();
  let produceCount = 0;

  const first = await produceOutputOnce({
    jobId,
    produce: async () => {
      produceCount += 1;
      return `https://storage.example.com/outputs/${jobId}.pdf`;
    },
  });
  assert.equal(first.produced, true);
  assert.equal(produceCount, 1);

  const second = await produceOutputOnce({
    jobId,
    produce: async () => {
      produceCount += 1;
      return "https://storage.example.com/outputs/something-else.pdf";
    },
  });

  assert.equal(second.produced, false, "a repeat run must not produce again");
  assert.equal(produceCount, 1, "produce must be called exactly once");
  assert.equal(second.output.url, first.output.url, "both runs agree on one reference");
});

test("a repeated record does not create a second row", async () => {
  const jobId = await createJob();

  const first = await recordJobOutput({ jobId, url: "https://storage.example.com/a.pdf" });
  const second = await recordJobOutput({ jobId, url: "https://storage.example.com/b.pdf" });

  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(second.output.url, "https://storage.example.com/a.pdf");
  assert.equal(await db.jobOutput.count({ where: { jobId } }), 1);
});

// The database resolves the race, not an application pre-check.
test("concurrent recording of one job's output yields one row", async () => {
  const jobId = await createJob();

  const results = await Promise.all(
    Array.from({ length: 5 }, (_, index) =>
      recordJobOutput({ jobId, url: `https://storage.example.com/run-${index}.pdf` }),
    ),
  );

  assert.equal(results.filter((r) => r.created).length, 1);
  assert.equal(await db.jobOutput.count({ where: { jobId } }), 1);

  const urls = new Set(results.map((r) => r.output.url));
  assert.equal(urls.size, 1, "every caller must receive the same reference");
});

test("concurrent production of one job's output yields one row and one winner", async () => {
  const jobId = await createJob();
  let produceCount = 0;

  const results = await Promise.all(
    Array.from({ length: 5 }, (_, index) =>
      produceOutputOnce({
        jobId,
        produce: async () => {
          produceCount += 1;
          return `https://storage.example.com/outputs/${jobId}.pdf?run=${index}`;
        },
      }),
    ),
  );

  assert.equal(await db.jobOutput.count({ where: { jobId } }), 1);
  assert.equal(new Set(results.map((r) => r.output.url)).size, 1);
  assert.ok(produceCount >= 1);
});

test("two different jobs each get their own output", async () => {
  const first = await createJob();
  const second = await createJob();

  await recordJobOutput({ jobId: first, url: "https://storage.example.com/first.pdf" });
  await recordJobOutput({ jobId: second, url: "https://storage.example.com/second.pdf" });

  assert.equal((await findJobOutput(first))?.url, "https://storage.example.com/first.pdf");
  assert.equal((await findJobOutput(second))?.url, "https://storage.example.com/second.pdf");
});

test("a failing produce records nothing and can be retried", async () => {
  const jobId = await createJob();

  await assert.rejects(() =>
    produceOutputOnce({
      jobId,
      produce: async () => {
        throw new Error("storage unavailable");
      },
    }),
  );

  assert.equal(await findJobOutput(jobId), null, "a failed produce must not record an output");

  const retried = await produceOutputOnce({
    jobId,
    produce: async () => `https://storage.example.com/outputs/${jobId}.pdf`,
  });
  assert.equal(retried.produced, true);
});
