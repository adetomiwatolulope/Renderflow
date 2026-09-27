// Drives one job to DEAD through the real retry path and records absolute attempt
// timestamps.
//
// Why this exists: the step 9 run measured the backoff gaps, but the job it used is
// no longer in the database, and the only DEAD jobs that remain are the ones
// `npm run seed-demo` fabricates. Seeded rows are inserted with hand-written
// timestamps; quoting them as evidence of a growing backoff would be presenting
// fiction as measurement. So the schedule is reproduced for real and the table is
// generated from JobAttempt rows the worker actually wrote.
//
// The target answers 500, which the webhook executor classifies RETRYABLE
// (PR-RETRY-002), so the job walks the full retry ladder and finishes DEAD.
//
// Run: node evidence/scripts/capture-backoff.cjs
// Takes roughly ten minutes: the four waits are about 43s, 70s, 133s and 297s.

const { spawn } = require("node:child_process");
const https = require("node:https");
const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { PrismaClient } = require("@prisma/client");

const ROOT = path.resolve(__dirname, "..", "..");
const CERT_DIR = path.join(ROOT, "scripts", "step9", "certs");
const WORKER_ENTRY = path.join(ROOT, ".node-build", "worker", "index.js");
const DASHBOARD = "http://localhost:3001";

const TARGET_PORT = 8444;
const RAW_KEY = "rf_evidence_backoff_key_01";
const ACCOUNT_NAME = "Evidence Backoff";

// Production-like cadence. Unlike the stall-recovery capture this run is not
// racing a timeout, so the defaults are kept: the point is the backoff ladder, and
// compressing it would be measuring something the product does not do.
const WORKER_ENV = {
  WORKER_CONCURRENCY: "10",
  WORKER_POLL_INTERVAL_MS: "200",
  WORKER_HEARTBEAT_INTERVAL_MS: "30000",
  WORKER_STALL_TIMEOUT_MS: "600000",
  WORKER_SWEEP_INTERVAL_MS: "5000",
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

function startTarget() {
  const server = https.createServer(
    {
      key: fs.readFileSync(path.join(CERT_DIR, "key.pem")),
      cert: fs.readFileSync(path.join(CERT_DIR, "cert.pem")),
    },
    (_req, res) => {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false }));
    },
  );
  return new Promise((resolve) => {
    server.listen(TARGET_PORT, "127.0.0.1", () =>
      resolve({ close: () => new Promise((done) => server.close(done)) }),
    );
  });
}

function startWorker() {
  const child = spawn(process.execPath, ["--conditions=react-server", WORKER_ENTRY], {
    cwd: ROOT,
    env: {
      ...process.env,
      ...WORKER_ENV,
      NODE_EXTRA_CA_CERTS: path.join(CERT_DIR, "cert.pem"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (c) => process.stdout.write(`  [worker] ${c.toString()}`));
  child.stderr.on("data", (c) => process.stderr.write(`  [worker!] ${c.toString()}`));
  return child;
}

async function main() {
  loadDotEnv();
  const db = new PrismaClient();

  if (!fs.existsSync(WORKER_ENTRY)) {
    throw new Error(`worker build missing: ${WORKER_ENTRY}`);
  }

  // Re-runnable: clear the previous run's rows in dependency order.
  const previous = await db.job.findMany({
    where: { account: { name: ACCOUNT_NAME } },
    select: { id: true },
  });
  for (const job of previous) {
    await db.webhookDelivery.deleteMany({ where: { jobId: job.id } });
    await db.jobOutput.deleteMany({ where: { jobId: job.id } });
    await db.jobAttempt.deleteMany({ where: { jobId: job.id } });
  }
  await db.job.deleteMany({ where: { account: { name: ACCOUNT_NAME } } });
  await db.apiKey.deleteMany({ where: { account: { name: ACCOUNT_NAME } } });
  await db.account.deleteMany({ where: { name: ACCOUNT_NAME } });

  const account = await db.account.create({ data: { name: ACCOUNT_NAME } });
  await db.apiKey.create({
    data: {
      accountId: account.id,
      hashedKey: createHash("sha256").update(RAW_KEY, "utf8").digest("hex"),
      prefix: RAW_KEY.slice(0, 8),
    },
  });

  const target = await startTarget();
  const worker = startWorker();
  await sleep(2000);

  try {
    const res = await fetch(`${DASHBOARD}/api/v1/jobs`, {
      method: "POST",
      headers: { authorization: `Bearer ${RAW_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({
        type: "WEBHOOK_CALL",
        payload: { url: `https://127.0.0.1:${TARGET_PORT}/fail` },
        idempotencyKey: "evidence-backoff-1",
      }),
    });
    if (res.status !== 202) {
      throw new Error(`submit returned ${res.status}: ${(await res.text()).slice(0, 300)}`);
    }
    const jobId = (await res.json()).id;
    console.log(`\n  submitted ${jobId}; walking the retry ladder to DEAD\n`);

    const deadline = Date.now() + 20 * 60_000;
    while (Date.now() < deadline) {
      const job = await db.job.findUnique({ where: { id: jobId } });
      const rows = await db.jobAttempt.count({ where: { jobId } });
      console.log(`  status=${job.status} counter=${job.attempts}/${job.maxAttempts} attemptRows=${rows}`);
      if (job.status === "DEAD") {
        console.log(`\n  job ${jobId} is DEAD after ${rows} attempts\n`);
        fs.writeFileSync(
          path.join(ROOT, "evidence", "logs", "backoff-job-id.txt"),
          jobId + "\n",
          "utf8",
        );
        break;
      }
      await sleep(15_000);
    }

    const final = await db.job.findUnique({ where: { id: jobId } });
    if (final.status !== "DEAD") {
      throw new Error(`job finished ${final.status}, expected DEAD`);
    }
  } finally {
    worker.kill("SIGKILL");
    await target.close();
    await db.$disconnect();
  }
}

main().catch((error) => {
  console.error(`FAILED: ${error.message}`);
  process.exit(1);
});
