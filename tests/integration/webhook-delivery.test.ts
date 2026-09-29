import { test } from "node:test";
import assert from "node:assert/strict";

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { ServerResponse } from "node:http";

import { JobStatus } from "@prisma/client";

import { db } from "../../lib/db/client";
import { createAccountWithApiKey } from "../../modules/auth/api-keys";
import { registerWebhookEndpoint } from "../../modules/webhooks/register-endpoint";
import { deliverTerminalJobNotification } from "../../modules/webhooks/deliver-notification";
import { signWebhookPayload, SIGNATURE_HEADER } from "../../modules/webhooks/signature";
import { MAX_DELIVERY_ATTEMPTS } from "../../modules/webhooks/delivery-policy";

/**
 * PR-WEBHOOK-001/003/004 and PR-TECH-005, exercised against a real local HTTP
 * server so signature bytes, status handling, attempt counting, and the rule that
 * delivery failure cannot alter a job are all observed rather than mocked.
 *
 * The server is plain HTTP, and the endpoint is written to the database directly
 * rather than through `registerWebhookEndpoint`, because that function correctly
 * refuses a non-https URL and these tests are about what happens after
 * registration.
 */

type Received = { readonly headers: Record<string, string>; readonly body: string };

function startTarget(
  handler: (received: Received, res: ServerResponse) => void,
): Promise<{ server: Server; port: number; received: Received[] }> {
  const received: Received[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const headers: Record<string, string> = {};
      for (const [key, value] of Object.entries(req.headers)) {
        if (typeof value === "string") {
          headers[key] = value;
        }
      }
      const entry = { headers, body: Buffer.concat(chunks).toString("utf8") };
      received.push(entry);
      handler(entry, res);
    });
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolve({ server, port, received });
    });
  });
}

function stop(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

async function clearAccount(accountId: string): Promise<void> {
  await db.webhookDelivery.deleteMany({ where: { job: { accountId } } });
  await db.jobAttempt.deleteMany({ where: { job: { accountId } } });
  await db.jobOutput.deleteMany({ where: { job: { accountId } } });
  await db.job.deleteMany({ where: { accountId } });
  await db.webhookEndpoint.deleteMany({ where: { accountId } });
  await db.apiKey.deleteMany({ where: { accountId } });
  await db.account.deleteMany({ where: { id: accountId } });
  await db.rateLimitWindow.deleteMany({ where: { key: accountId } });
}

async function makeJobWithEndpoint(
  label: string,
  url: string,
  status: JobStatus,
): Promise<{ accountId: string; jobId: string; secret: string }> {
  const issued = await createAccountWithApiKey(`${label}-${Date.now()}-${Math.random()}`);
  const endpoint = await registerWebhookEndpoint(issued.accountId, "https://placeholder.invalid/hook");
  // Written directly so a local http:// target can be used.
  await db.webhookEndpoint.update({
    where: { id: endpoint.id },
    data: { url },
  });

  const job = await db.job.create({
    data: {
      accountId: issued.accountId,
      type: "WEBHOOK_CALL",
      payload: { url: "https://example.com" },
      idempotencyKey: `${label}-${Date.now()}`,
      status,
      attempts: 1,
      maxAttempts: 5,
      finishedAt: status === JobStatus.SUCCEEDED || status === JobStatus.DEAD ? new Date() : null,
    },
    select: { id: true },
  });

  return { accountId: issued.accountId, jobId: job.id, secret: endpoint.secret };
}

test("PR-WEBHOOK-003: the delivered body is signed and the signature verifies", async () => {
  const target = await startTarget((_received, res) => {
    res.writeHead(200).end("ok");
  });

  try {
    const { accountId, jobId, secret } = await makeJobWithEndpoint(
      "hook-signed",
      `http://127.0.0.1:${target.port}/hook`,
      JobStatus.SUCCEEDED,
    );

    try {
      const outcome = await deliverTerminalJobNotification(jobId);
      assert.equal(outcome.delivered, true);
      assert.equal(target.received.length, 1);

      const sent = target.received[0]!;
      assert.equal(sent.headers["content-type"], "application/json");
      assert.ok(sent.headers[SIGNATURE_HEADER.toLowerCase()], "signature header must be present");
      assert.equal(
        sent.headers[SIGNATURE_HEADER.toLowerCase()],
        signWebhookPayload(secret, sent.body),
        "signature must cover the exact bytes sent",
      );

      const payload = JSON.parse(sent.body);
      assert.equal(payload.job.id, jobId);
      assert.equal(payload.job.status, "SUCCEEDED");
    } finally {
      await clearAccount(accountId);
    }
  } finally {
    await stop(target.server);
  }
});

test("PR-WEBHOOK-004: a 500 is retried up to 3 times and then recorded FAILED", async () => {
  const target = await startTarget((_received, res) => {
    res.writeHead(500).end("no");
  });

  try {
    const { accountId, jobId } = await makeJobWithEndpoint(
      "hook-500",
      `http://127.0.0.1:${target.port}/hook`,
      JobStatus.SUCCEEDED,
    );

    try {
      const outcome = await deliverTerminalJobNotification(jobId);
      assert.equal(outcome.delivered, false);
      assert.equal(outcome.attempts, MAX_DELIVERY_ATTEMPTS);
      assert.equal(target.received.length, MAX_DELIVERY_ATTEMPTS, "no fourth attempt");

      // PR-TECH-005: every attempt logged, none overwritten.
      const deliveries = await db.webhookDelivery.findMany({
        where: { jobId },
        orderBy: { attemptNumber: "asc" },
      });
      assert.equal(deliveries.length, MAX_DELIVERY_ATTEMPTS);
      assert.deepEqual(
        deliveries.map((row) => row.attemptNumber),
        [1, 2, 3],
      );
      assert.ok(deliveries.every((row) => row.status === "FAILED"));
      assert.ok(deliveries.every((row) => row.responseCode === 500));
    } finally {
      await clearAccount(accountId);
    }
  } finally {
    await stop(target.server);
  }
});

test("PR-WEBHOOK-004: delivery succeeding on a later attempt stops the ladder", async () => {
  let calls = 0;
  const target = await startTarget((_received, res) => {
    calls += 1;
    if (calls === 1) {
      res.writeHead(503).end("later");
      return;
    }
    res.writeHead(200).end("ok");
  });

  try {
    const { accountId, jobId } = await makeJobWithEndpoint(
      "hook-recover",
      `http://127.0.0.1:${target.port}/hook`,
      JobStatus.SUCCEEDED,
    );

    try {
      const outcome = await deliverTerminalJobNotification(jobId);
      assert.equal(outcome.delivered, true);
      assert.equal(outcome.attempts, 2);
      assert.equal(calls, 2);

      const deliveries = await db.webhookDelivery.findMany({
        where: { jobId },
        orderBy: { attemptNumber: "asc" },
      });
      assert.equal(deliveries.length, 2);
      assert.equal(deliveries[0]?.status, "FAILED");
      assert.equal(deliveries[1]?.status, "DELIVERED");
    } finally {
      await clearAccount(accountId);
    }
  } finally {
    await stop(target.server);
  }
});

test("PR-WEBHOOK-004: an unreachable endpoint is retried and never touches the job", async () => {
  // Port 1 on loopback refuses connections.
  const { accountId, jobId } = await makeJobWithEndpoint(
    "hook-unreachable",
    "http://127.0.0.1:1/hook",
    JobStatus.SUCCEEDED,
  );

  try {
    const before = await db.job.findUnique({ where: { id: jobId }, select: { status: true } });
    const outcome = await deliverTerminalJobNotification(jobId);
    const after = await db.job.findUnique({ where: { id: jobId }, select: { status: true } });

    assert.equal(outcome.delivered, false);
    assert.equal(outcome.attempts, MAX_DELIVERY_ATTEMPTS);
    // AGENTS rule 18: delivery failure is independent of job status.
    assert.equal(after?.status, JobStatus.SUCCEEDED);
    assert.deepEqual(after?.status, before?.status);
  } finally {
    await clearAccount(accountId);
  }
});

test("PR-WEBHOOK-002: a non-terminal job produces no delivery attempt at all", async () => {
  const target = await startTarget((_received, res) => {
    res.writeHead(200).end("ok");
  });

  try {
    const { accountId, jobId } = await makeJobWithEndpoint(
      "hook-processing",
      `http://127.0.0.1:${target.port}/hook`,
      JobStatus.PROCESSING,
    );

    try {
      const outcome = await deliverTerminalJobNotification(jobId);
      assert.equal(outcome.delivered, false);
      assert.equal(outcome.attempts, 0);
      assert.equal(target.received.length, 0, "must not notify before the job finishes");
      assert.equal(await db.webhookDelivery.count({ where: { jobId } }), 0);
    } finally {
      await clearAccount(accountId);
    }
  } finally {
    await stop(target.server);
  }
});

test("an account with no registered endpoint is not an error", async () => {
  const issued = await createAccountWithApiKey(`hook-none-${Date.now()}`);
  try {
    const job = await db.job.create({
      data: {
        accountId: issued.accountId,
        type: "WEBHOOK_CALL",
        payload: {},
        idempotencyKey: `hook-none-${Date.now()}`,
        status: JobStatus.SUCCEEDED,
        attempts: 1,
        maxAttempts: 5,
        finishedAt: new Date(),
      },
      select: { id: true },
    });

    const outcome = await deliverTerminalJobNotification(job.id);
    assert.equal(outcome.delivered, false);
    assert.equal(outcome.attempts, 0);
    assert.equal(outcome.lastError, null, "not registering a webhook is a normal state");
  } finally {
    await clearAccount(issued.accountId);
  }
});
