// Completes the Step 9 scenario 2 observation.
//
// Scenario 2 creates one job whose target always returns 500 and waits for it to
// be retried to exhaustion. Because the backoff is fixed in application code at a
// 30s base (AGENTS rule 8 forbids making it runtime-configurable), reaching the
// fifth attempt genuinely takes about ten minutes, and a harness process that is
// interrupted part-way leaves the job sitting between attempts.
//
// This adopts the job scenario 2 already created instead of starting a new one, so
// the attempt sequence is continuous: the same job, the same configuration, only
// the observation is resumed. Attempts 1-4 were recorded by the original run.

const { spawn } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");
const { PrismaClient } = require("@prisma/client");

const ROOT = path.resolve(__dirname, "..", "..");
const WORKER_ENTRY = path.join(ROOT, ".node-build", "worker", "index.js");

const WORKER_ENV = {
  WORKER_CONCURRENCY: "10",
  WORKER_POLL_INTERVAL_MS: "200",
  WORKER_HEARTBEAT_INTERVAL_MS: "500",
  WORKER_STALL_TIMEOUT_MS: "3000",
  WORKER_SWEEP_INTERVAL_MS: "500",
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function loadDotEnv() {
  for (const rawLine of fs.readFileSync(path.join(ROOT, ".env"), "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) {
      continue;
    }
    const eq = line.indexOf("=");
    if (eq < 0) {
      continue;
    }
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

async function main() {
  loadDotEnv();
  const db = new PrismaClient();
  await db.$connect();

  const job = await db.job.findFirst({
    where: { idempotencyKey: { startsWith: "s2-" } },
    orderBy: { createdAt: "desc" },
  });
  if (job === null) {
    throw new Error("no scenario 2 job found; run `node scripts/step9/run-scenarios.js 2` first");
  }
  console.log(`Adopting scenario 2 job ${job.id} (status=${job.status}, attempts=${job.attempts}/${job.maxAttempts})`);

  const worker = spawn(process.execPath, ["--conditions=react-server", WORKER_ENTRY], {
    cwd: ROOT,
    env: {
      ...process.env,
      ...WORKER_ENV,
      NODE_EXTRA_CA_CERTS: path.join(__dirname, "certs", "cert.pem"),
    },
    stdio: ["ignore", "inherit", "inherit"],
  });

  const deadline = Date.now() + 15 * 60_000;
  let final = null;
  while (Date.now() < deadline) {
    const current = await db.job.findUniqueOrThrow({ where: { id: job.id } });
    if (current.status === "DEAD" || current.status === "SUCCEEDED") {
      final = current;
      break;
    }
    await sleep(500);
  }

  worker.kill("SIGKILL");
  await db.$disconnect();

  if (final === null) {
    console.log("RESULT: FAIL - the job never reached a terminal state");
    process.exitCode = 1;
    return;
  }

  const attempts = await db.jobAttempt.findMany({
    where: { jobId: job.id },
    orderBy: { attemptNumber: "asc" },
  });

  const gaps = [];
  for (let i = 1; i < attempts.length; i += 1) {
    gaps.push({
      after: attempts[i - 1].attemptNumber,
      seconds: (attempts[i].startedAt - attempts[i - 1].finishedAt) / 1000,
    });
  }

  const increasing = gaps.every((g, i) => i === 0 || g.seconds >= gaps[i - 1].seconds);
  const complete = attempts.length === final.maxAttempts;
  const allFailed = attempts.every((a) => a.outcome === "FAILED");

  const passed = final.status === "DEAD" && complete && allFailed && increasing;

  console.log("");
  console.log(`  final status      : ${final.status}`);
  console.log(`  attempts          : ${final.attempts}/${final.maxAttempts} (rows=${attempts.length})`);
  console.log(`  every attempt lost: ${allFailed}`);
  console.log(`  last error        : ${final.lastError}`);
  console.log("  backoff gaps between attempts (s):");
  for (const g of gaps) {
    console.log(`    after attempt ${g.after}: ${g.seconds.toFixed(2)}s`);
  }
  console.log(`  monotonically increasing: ${increasing}`);
  console.log("");
  console.log(`  ${passed ? "PASS" : "FAIL"}  100% failure rate retries to DEAD`);

  process.exitCode = passed ? 0 : 1;
}

main().catch((error) => {
  console.error("Harness error:", error);
  process.exitCode = 1;
});
