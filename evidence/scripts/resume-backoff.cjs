// Finishes the backoff capture started by capture-backoff.cjs.
//
// The first script's own deadline expired while the job was waiting out its fourth
// backoff, and its worker went down with it, leaving the job parked at 4/5 with
// nothing to retry it. This picks the job back up: it restarts the failing target
// and a worker, then waits for the last attempt to settle.
//
// Run: node evidence/scripts/resume-backoff.cjs

const { spawn } = require("node:child_process");
const https = require("node:https");
const fs = require("node:fs");
const path = require("node:path");
const { PrismaClient } = require("@prisma/client");

const ROOT = path.resolve(__dirname, "..", "..");
const CERT_DIR = path.join(ROOT, "scripts", "step9", "certs");
const WORKER_ENTRY = path.join(ROOT, ".node-build", "worker", "index.js");
const LOG_DIR = path.join(ROOT, "evidence", "logs");
const TARGET_PORT = 8444;

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

async function main() {
  loadDotEnv();
  const db = new PrismaClient();
  const log = path.join(LOG_DIR, "backoff-capture.log");

  const job = await db.job.findFirst({
    where: { account: { name: "Evidence Backoff" } },
    orderBy: { createdAt: "desc" },
  });
  if (job === null) throw new Error("no Evidence Backoff job found; run capture-backoff.cjs first");
  if (job.status === "DEAD") {
    fs.writeFileSync(path.join(LOG_DIR, "backoff-job-id.txt"), job.id + "\n", "utf8");
    console.log(`job already DEAD: ${job.id}`);
    await db.$disconnect();
    return;
  }

  const target = await startTarget();
  const worker = spawn(process.execPath, ["--conditions=react-server", WORKER_ENTRY], {
    cwd: ROOT,
    env: { ...process.env, ...WORKER_ENV, NODE_EXTRA_CA_CERTS: path.join(CERT_DIR, "cert.pem") },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const pipe = (c) => {
    const text = c.toString();
    fs.appendFileSync(log, text, "utf8");
    process.stdout.write(`  [worker] ${text}`);
  };
  worker.stdout.on("data", pipe);
  worker.stderr.on("data", pipe);

  try {
    const deadline = Date.now() + 15 * 60_000;
    while (Date.now() < deadline) {
      const current = await db.job.findUnique({ where: { id: job.id } });
      const rows = await db.jobAttempt.count({ where: { jobId: job.id } });
      console.log(`  status=${current.status} counter=${current.attempts}/${current.maxAttempts} attemptRows=${rows}`);
      if (current.status === "DEAD") {
        fs.writeFileSync(path.join(LOG_DIR, "backoff-job-id.txt"), job.id + "\n", "utf8");
        fs.appendFileSync(log, `\n  job ${job.id} is DEAD after ${rows} attempts\n`, "utf8");
        console.log(`\n  job ${job.id} is DEAD after ${rows} attempts`);
        break;
      }
      await sleep(10_000);
    }

    const final = await db.job.findUnique({ where: { id: job.id } });
    if (final.status !== "DEAD") throw new Error(`job finished ${final.status}, expected DEAD`);
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
