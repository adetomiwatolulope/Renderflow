
import { Prisma } from "@prisma/client";

import { db } from "../lib/db/client";
import { createAccountWithApiKey } from "../modules/auth/api-keys";

/**
 * Seeds a demo account with a spread of job statuses so the dashboard jobs screen
 * has something to show. Operator-run, not part of the application.
 *
 *   npm run seed-demo
 *
 * Prints the API key once, the same way provisioning does.
 */

async function main(): Promise<void> {
  const issued = await createAccountWithApiKey(`demo-${Date.now()}`);

  const specs = [
    { status: "SUCCEEDED", type: "PDF_GENERATION", attempts: 1, maxAttempts: 5, error: null },
    { status: "SUCCEEDED", type: "EMAIL_DELIVERY", attempts: 2, maxAttempts: 5, error: null },
    { status: "SUCCEEDED", type: "WEBHOOK_CALL", attempts: 1, maxAttempts: 3, error: null },
    { status: "SUCCEEDED", type: "AI_REQUEST", attempts: 1, maxAttempts: 3, error: null },
    { status: "PROCESSING", type: "IMAGE_PROCESSING", attempts: 1, maxAttempts: 4, error: null },
    { status: "FAILED", type: "WEBHOOK_CALL", attempts: 2, maxAttempts: 3, error: "HTTP 503 from provider" },
    { status: "DEAD", type: "PDF_GENERATION", attempts: 5, maxAttempts: 5, error: "HTTP 400 from renderer: unsupported font" },
    { status: "DEAD", type: "EMAIL_DELIVERY", attempts: 5, maxAttempts: 5, error: "SMTP timeout after 3 connections" },
    { status: "QUEUED", type: "CUSTOM", attempts: 0, maxAttempts: 3, error: null },
  ] as const;

  for (const [index, spec] of specs.entries()) {
    const terminal = spec.status === "SUCCEEDED" || spec.status === "DEAD";
    await db.job.create({
      data: {
        accountId: issued.accountId,
        type: spec.type,
        payload: { index, note: "demo job" },
        idempotencyKey: `demo-${issued.accountId}-${index}`,
        status: spec.status,
        attempts: spec.attempts,
        maxAttempts: spec.maxAttempts,
        lastError: spec.error,
        startedAt: spec.attempts > 0 ? new Date() : null,
        finishedAt: terminal ? new Date() : null,
        result:
          spec.status === "SUCCEEDED"
            ? { ok: true, outputUrl: `https://example.com/out/${index}` }
            : Prisma.DbNull,
      },
    });
  }

  // A little history behind the failing jobs, so attempt history has something
  // coherent to show rather than a single row.
  const recent = await db.job.findMany({
    where: { accountId: issued.accountId, status: "DEAD" },
    orderBy: { createdAt: "asc" },
    select: { id: true, attempts: true },
  });
  for (const job of recent) {
    for (let attempt = 1; attempt <= job.attempts; attempt += 1) {
      await db.jobAttempt.create({
        data: {
          jobId: job.id,
          attemptNumber: attempt,
          startedAt: new Date(),
          finishedAt: new Date(),
          durationMs: 120 + attempt * 40,
          outcome: "FAILED",
          errorCode: "UPSTREAM_ERROR",
          errorMessage: `attempt ${attempt} failed`,
        },
      });
    }
  }

  process.stdout.write(
    `Seeded ${specs.length} demo jobs.\n` +
      `API key (shown once): ${issued.apiKey}\n` +
      "Open http://localhost:3001/jobs and paste that key.\n",
  );
}

main().catch((error: unknown) => {
  console.error("seed-demo failed:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
