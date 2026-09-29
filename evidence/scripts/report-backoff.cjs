// Reads the retry-backoff evidence straight out of the database and writes a
// markdown table of absolute attempt timestamps.
//
// The step 9 log already showed the growing gaps between attempts. This exists
// because those gaps are elapsed times, not clock times: they show *that* the
// delay grew but not *when* the attempts ran. A reviewer asking for timestamps
// wants the latter, so the table is generated from JobAttempt.startedAt and
// JobAttempt.finishedAt rather than transcribed from console output.
//
// Run: node evidence/scripts/report-backoff.cjs

const fs = require("node:fs");
const path = require("node:path");
const { PrismaClient } = require("@prisma/client");

const ROOT = path.resolve(__dirname, "..", "..");
const OUT = path.join(ROOT, "evidence", "logs", "backoff-timestamps.md");

// The job scenario 2 drove to DEAD by exhausting its retries.
const JOB_ID = process.argv[2] || "cmuk4sden0001trlghohfqaxe";

function loadDotEnv() {
  for (const raw of fs.readFileSync(path.join(ROOT, ".env"), "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

// The expected wait is taken from the compiled backoff module rather than mirrored
// here. Copying the constants into this script would let the report drift away from
// the policy it is checking, which is exactly the failure it exists to catch.
//
// The wait recorded before attempt N is the delay that follows the settling of
// attempt N-1, so the band is evaluated with jitter pinned to both 0 and 1: the
// result is the full range the policy can produce for that attempt.
const backoff = require(path.join(ROOT, ".node-build", "modules", "retry", "backoff.js"));

function expectedBandMs(attemptNumber) {
  const settledAttempt = attemptNumber - 1;
  return {
    low: backoff.backoffDelayMs(settledAttempt, () => 0),
    high: backoff.backoffDelayMs(settledAttempt, () => 0.999999),
  };
}

async function main() {
  loadDotEnv();
  const db = new PrismaClient();

  const job = await db.job.findUnique({
    where: { id: JOB_ID },
    include: { jobAttempts: { orderBy: { startedAt: "asc" } } },
  });

  if (job === null) {
    throw new Error(`job ${JOB_ID} not found; the database may have been reseeded`);
  }

  const lines = [];
  lines.push(`# Retry backoff: absolute attempt timestamps`);
  lines.push("");
  lines.push(`Job \`${job.id}\` (${job.type}), final status **${job.status}** after ${job.jobAttempts.length} of ${job.maxAttempts} attempts.`);
  lines.push("");
  lines.push("Each row is one `JobAttempt`, written by the worker when the attempt");
  lines.push("settled. The wait column is the gap between one attempt finishing and the");
  lines.push("next one starting, which is the backoff the job actually waited out.");
  lines.push("The expected band is computed from `modules/retry/backoff.ts` with jitter");
  lines.push("pinned to its minimum and maximum, so any wait outside it came from");
  lines.push("something other than the backoff policy.");
  lines.push("");
  lines.push("| Attempt | Outcome | Error | Started (UTC) | Finished (UTC) | Duration | Waited before this attempt | Expected band |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- | --- |");

  let previousFinished = null;
  const waits = [];
  for (const attempt of job.jobAttempts) {
    const waitedMs =
      previousFinished === null ? null : attempt.startedAt.getTime() - previousFinished.getTime();
    if (waitedMs !== null) waits.push({ attempt: attempt.attemptNumber, ms: waitedMs });

    const band = expectedBandMs(attempt.attemptNumber);
    const inBand = waitedMs === null || (waitedMs >= band.low && waitedMs <= band.high);
    const bandCell = waitedMs === null
      ? "-"
      : `${(band.low / 1000).toFixed(0)}-${(band.high / 1000).toFixed(0)}s` +
        (inBand ? "" : " **off-band**");

    lines.push(
      `| ${attempt.attemptNumber} | ${attempt.outcome} | ${attempt.errorCode ?? "-"} | ` +
        `${attempt.startedAt.toISOString()} | ` +
        `${attempt.finishedAt ? attempt.finishedAt.toISOString() : "-"} | ` +
        `${attempt.durationMs}ms | ` +
        `${waitedMs === null ? "-" : `${(waitedMs / 1000).toFixed(2)}s`} | ${bandCell} |`,
    );
    if (attempt.finishedAt !== null) previousFinished = attempt.finishedAt;
  }

  lines.push("");
  const observed = waits.map((w) => `${(w.ms / 1000).toFixed(2)}s`);
  lines.push(`Waits between attempts: ${observed.join(" -> ")}`);
  lines.push("");
  lines.push(`Strictly increasing: **${waits.every((w, i) => i === 0 || w.ms > waits[i - 1].ms) ? "yes" : "no"}**`);
  lines.push("");

  const offBand = waits.filter((w) => {
    const band = expectedBandMs(w.attempt);
    return w.ms < band.low || w.ms > band.high;
  });
  if (offBand.length > 0) {
    lines.push("## Waits that are not backoff");
    lines.push("");
    for (const w of offBand) {
      const band = expectedBandMs(w.attempt);
      const direction = w.ms > band.high ? "longer" : "shorter";
      lines.push(
        `- Wait ${w.attempt - 1} -> ${w.attempt} was ${(w.ms / 1000).toFixed(2)}s, but the policy allows ` +
          `${(band.low / 1000).toFixed(0)}-${(band.high / 1000).toFixed(0)}s. The delay is ${direction} than the ` +
          "policy can produce, and the policy is fixed in code, so the difference is time " +
          "the schedule was not in control of: most often the job waiting in `FAILED` " +
          "while no worker was running to pick it up. It is reported rather than folded " +
          "into the ladder, because it measures downtime, not backoff.",
      );
    }
    lines.push("");
  }

  lines.push(
    "Retry configuration is fixed in application code and is not runtime- or",
    "account-configurable (AGENTS rule 8, PR-RETRY-001), so these delays are the",
    "only schedule a caller can observe. Jitter is a fraction of the exponential term",
    "(`JITTER_RATIO = 0.5`) with the total capped at `BACKOFF_MAX_MS`.",
  );

  fs.writeFileSync(OUT, lines.join("\n") + "\n");
  console.log(lines.join("\n"));
  console.log(`\nwrote evidence/logs/backoff-timestamps.md`);

  await db.$disconnect();
}

main().catch((error) => {
  console.error(`FAILED: ${error.message}`);
  process.exit(1);
});
