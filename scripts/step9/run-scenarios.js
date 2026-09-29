// Step 9 adversarial scenarios.
//
// Owns the whole lifecycle itself — the target server runs in this process, the
// Next.js API and each worker are child processes, and the database is read
// through Prisma. Doing it in one place is deliberate: the scenarios kill
// workers with SIGKILL and start two workers at once, so a harness that
// depended on detached background processes would be measuring the wrong thing.
//
// Run: node scripts/step9/run-scenarios.js   (after `npm run build` and
// `npx tsc -p tsconfig.node.json`)

const { spawn } = require("node:child_process");
const https = require("node:https");
const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { PrismaClient } = require("@prisma/client");

const ROOT = path.resolve(__dirname, "..", "..");
const CERT_DIR = path.join(__dirname, "certs");
const TARGET_PORT = 8443;
const API_PORT = 3101;

const WORKER_ENTRY = path.join(ROOT, ".node-build", "worker", "index.js");
const NEXT_BIN = path.join(ROOT, "node_modules", "next", "dist", "bin", "next");

// Short stall settings so a heartbeat going stale is observable in seconds
// rather than the production 10 minutes. The heartbeat/timeout *relationship* is
// what is under test, not the absolute values.
const WORKER_ENV = {
  WORKER_CONCURRENCY: "10",
  WORKER_POLL_INTERVAL_MS: "200",
  WORKER_HEARTBEAT_INTERVAL_MS: "500",
  WORKER_STALL_TIMEOUT_MS: "3000",
  WORKER_SWEEP_INTERVAL_MS: "500",
};

const results = [];
let db;

function loadDotEnv() {
  const file = path.join(ROOT, ".env");
  if (!fs.existsSync(file)) {
    throw new Error(".env not found; the harness needs DATABASE_URL");
  }
  for (const rawLine of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(label, predicate, timeoutMs, intervalMs = 100) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await predicate();
    if (last) {
      return last;
    }
    await sleep(intervalMs);
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for: ${label}`);
}

function startTarget(hangMs) {
  const hits = new Map();
  let inFlight = 0;
  let peakInFlight = 0;

  const server = https.createServer(
    {
      key: fs.readFileSync(path.join(CERT_DIR, "key.pem")),
      cert: fs.readFileSync(path.join(CERT_DIR, "cert.pem")),
    },
    (req, res) => {
      const route = (req.url || "/").split("?")[0];
      const jobId = req.headers["idempotency-key"];
      const bucket = hits.get(jobId) || { total: 0, routes: {} };
      bucket.total += 1;
      bucket.routes[route] = (bucket.routes[route] || 0) + 1;
      hits.set(jobId, bucket);
      inFlight += 1;
      peakInFlight = Math.max(peakInFlight, inFlight);

      const reply = (code, body) => {
        inFlight -= 1;
        res.writeHead(code, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      };

      if (route === "/slow") {
        setTimeout(() => reply(200, { ok: true, route }), 1500);
        return;
      }
      if (route === "/hang") {
        // Long enough that the worker is unambiguously mid-execution when it is
        // killed, short enough that the recovered retry can still finish.
        setTimeout(() => reply(200, { ok: true, route }), hangMs);
        return;
      }
      if (route === "/fail") {
        reply(500, { ok: false, route });
        return;
      }
      reply(200, { ok: true, route });
    },
  );

  return new Promise((resolve) => {
    server.listen(TARGET_PORT, "127.0.0.1", () => {
      resolve({
        server,
        hits,
        peak: () => peakInFlight,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

function startWorker(label) {
  const child = spawn(process.execPath, ["--conditions=react-server", WORKER_ENTRY], {
    cwd: ROOT,
    env: {
      ...process.env,
      ...WORKER_ENV,
      NODE_EXTRA_CA_CERTS: path.join(CERT_DIR, "cert.pem"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const state = { label, child, stdout: "", stderr: "", peaks: [], exited: false, exitInfo: null };

  child.stdout.on("data", (chunk) => {
    const text = chunk.toString();
    state.stdout += text;
    process.stdout.write(`  [${label}] ${text}`);
    for (const match of text.matchAll(/high-water mark: (\d+) of (\d+)/g)) {
      state.peaks.push(Number(match[1]));
    }
  });
  child.stderr.on("data", (chunk) => {
    const text = chunk.toString();
    state.stderr += text;
    process.stderr.write(`  [${label}!] ${text}`);
  });
  child.on("exit", (code, signal) => {
    state.exited = true;
    state.exitInfo = { code, signal };
  });

  return state;
}

function stopWorker(state) {
  return new Promise((resolve) => {
    if (state.exited) {
      resolve();
      return;
    }
    state.child.on("exit", () => resolve());
    state.child.kill("SIGKILL");
  });
}

function startApi() {
  const child = spawn(process.execPath, [NEXT_BIN, "start", "-p", String(API_PORT)], {
    cwd: ROOT,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout.on("data", (c) => {
    log += c.toString();
  });
  child.stderr.on("data", (c) => {
    log += c.toString();
  });
  return {
    child,
    log: () => log,
    stop: () =>
      new Promise((resolve) => {
        if (child.exitCode !== null) {
          resolve();
          return;
        }
        child.on("exit", () => resolve());
        child.kill("SIGKILL");
      }),
  };
}

async function apiIsUp() {
  try {
    const res = await fetch(`http://127.0.0.1:${API_PORT}/api/v1/jobs/does-not-exist`, {
      headers: { authorization: "Bearer nothing" },
    });
    return res.status === 401 || res.status === 404;
  } catch {
    return false;
  }
}

async function submitJob(apiKey, body) {
  const res = await fetch(`http://127.0.0.1:${API_PORT}/api/v1/jobs`, {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // left as null; the caller reports the raw status
  }
  return { status: res.status, body: json, raw: text };
}

async function makeAccount(name, rawKey) {
  const account = await db.account.create({ data: { name } });
  await db.apiKey.create({
    data: {
      accountId: account.id,
      hashedKey: createHash("sha256").update(rawKey, "utf8").digest("hex"),
      prefix: rawKey.slice(0, 8),
    },
  });
  return account;
}

function record(name, passed, detail) {
  results.push({ name, passed, detail });
  console.log(`\n  ${passed ? "PASS" : "FAIL"}  ${name}\n        ${detail}\n`);
}

async function clearQueue() {
  await db.jobAttempt.deleteMany({});
  await db.jobOutput.deleteMany({});
  await db.webhookDelivery.deleteMany({});
  await db.job.deleteMany({});
}

// ---------------------------------------------------------------------------
// Scenario 1: 50 jobs submitted at once must not be executed 50 at once.
// The per-process cap is 10 (PR-QUEUE-004), so the target must never see more
// than 10 simultaneous requests.
// ---------------------------------------------------------------------------
async function scenario1(apiKey, target) {
  console.log("\n[1/5] 50 jobs submitted together against a 10-slot worker");
  await clearQueue();
  target.hits.clear();

  const submitted = [];
  for (let i = 0; i < 50; i += 1) {
    const res = await submitJob(apiKey, {
      type: "WEBHOOK_CALL",
      idempotencyKey: `s1-${i}-${Date.now()}`,
      payload: { url: `https://localhost:${TARGET_PORT}/slow` },
    });
    submitted.push(res);
  }

  const accepted = submitted.filter((r) => r.status === 202).length;
  if (accepted !== 50) {
    record("50 jobs, peak concurrency <= 10", false, `only ${accepted}/50 were accepted`);
    return;
  }

  const worker = startWorker("w1");
  try {
    await waitFor(
      "all 50 jobs to settle",
      async () => {
        const counts = await db.job.groupBy({ by: ["status"], _count: { _all: true } });
        const settled = counts
          .filter((c) => c.status === "SUCCEEDED" || c.status === "DEAD")
          .reduce((sum, c) => sum + c._count._all, 0);
        return settled === 50 ? true : false;
      },
      180_000,
      500,
    );

    const peak = target.peak();
    const observed = worker.peaks.length === 0 ? 0 : Math.max(...worker.peaks);
    const succeeded = await db.job.count({ where: { status: "SUCCEEDED" } });
    const attempts = await db.job.aggregate({ _sum: { attempts: true } });

    const ok = peak <= 10 && observed === 10 && succeeded === 50;
    record(
      "50 jobs, peak concurrency <= 10",
      ok,
      `target peak simultaneous requests=${peak} (cap 10); ` +
        `worker high-water mark=${observed}/10; ${succeeded}/50 SUCCEEDED; ` +
        `total attempts=${attempts._sum.attempts} (50 means no job ran twice)`,
    );
  } finally {
    await stopWorker(worker);
  }
}

// ---------------------------------------------------------------------------
// Scenario 2: a target that always fails must be retried on the backoff
// schedule until attempts are exhausted, then land in DEAD (PR-RETRY-001,
// AGENTS rule 6). The delays are fixed in code, so this genuinely waits out
// four backoffs; nothing here shortens them.
// ---------------------------------------------------------------------------
async function scenario2(apiKey) {
  console.log("\n[2/5] one job, target always 500s, retried to exhaustion");
  await clearQueue();

  const created = await submitJob(apiKey, {
    type: "WEBHOOK_CALL",
    idempotencyKey: `s2-${Date.now()}`,
    payload: { url: `https://localhost:${TARGET_PORT}/fail` },
  });
  if (created.status !== 202) {
    record("100% failure rate retries to DEAD", false, `submit returned ${created.status}`);
    return;
  }
  const jobId = created.body.id;

  const worker = startWorker("w2");
  try {
    await waitFor(
      "job to reach a terminal state",
      async () => {
        const job = await db.job.findUnique({ where: { id: jobId } });
        return job && (job.status === "DEAD" || job.status === "SUCCEEDED") ? job : false;
      },
      // Four backoffs of 30/60/120/240s plus jitter is ~7.5-11 minutes.
      20 * 60_000,
      1000,
    );

    const job = await db.job.findUniqueOrThrow({
      where: { id: jobId },
      include: { jobAttempts: { orderBy: { attemptNumber: "asc" } } },
    });

    const delays = [];
    for (let i = 1; i < job.jobAttempts.length; i += 1) {
      const previous = job.jobAttempts[i - 1];
      const current = job.jobAttempts[i];
      if (previous.finishedAt && current.startedAt) {
        delays.push(Math.round((current.startedAt - previous.finishedAt) / 1000));
      }
    }

    const increasing = delays.every((d, i) => i === 0 || d >= delays[i - 1]);
    const ok =
      job.status === "DEAD" &&
      job.attempts === job.maxAttempts &&
      job.jobAttempts.length === job.maxAttempts &&
      job.jobAttempts.every((a) => a.outcome === "FAILED") &&
      increasing;

    record(
      "100% failure rate retries to DEAD",
      ok,
      `status=${job.status}; attempts=${job.attempts}/${job.maxAttempts}; ` +
        `attempt rows=${job.jobAttempts.length}; gaps between attempts (s)=[${delays.join(", ")}]; ` +
        `monotonically increasing=${increasing}; lastError=${JSON.stringify(job.lastError)}`,
    );
  } finally {
    await stopWorker(worker);
  }
}

// ---------------------------------------------------------------------------
// Scenario 3: a worker killed mid-job must be recovered exactly once.
//
// 3a is the half that protects against double execution: a job that is slow but
// still heartbeating must NOT be requeued, however far past the claim it runs
// (AGENTS rule 10). 3b kills a worker with SIGKILL mid-execution and shows the
// stall sweep recovering the job.
// ---------------------------------------------------------------------------
async function scenario3(apiKey, target) {
  console.log("\n[3/5] worker killed mid-job; slow-but-alive job must not be requeued");
  await clearQueue();
  target.hits.clear();

  // 3a: outlives the stall timeout several times over while heartbeating.
  const slow = await submitJob(apiKey, {
    type: "WEBHOOK_CALL",
    idempotencyKey: `s3a-${Date.now()}`,
    payload: { url: `https://localhost:${TARGET_PORT}/hang` },
  });
  if (slow.status !== 202) {
    record("a slow but heartbeating job is never requeued", false, `submit returned ${slow.status}: ${slow.raw.slice(0, 200)}`);
    await stopWorker(worker);
    return;
  }
  const slowId = slow.body.id;

  const worker = startWorker("w3");
  let slowHits = 0;
  try {
    // Runs for HANG_MS (8s) against a 3s stall timeout with 500ms heartbeats.
    await waitFor(
      "the slow job to be claimed and run past the stall timeout",
      async () => {
        const job = await db.job.findUniqueOrThrow({ where: { id: slowId } });
        slowHits = target.hits.get(slowId)?.total ?? 0;
        return job.status === "PROCESSING" && Date.now() > 0 ? slowHits >= 1 : false;
      },
      30_000,
      100,
    );

    // Let it run well past the timeout; the heartbeat must keep it alive.
    await sleep(6000);

    const midway = await db.job.findUniqueOrThrow({ where: { id: slowId } });
    const midwayHits = target.hits.get(slowId)?.total ?? 0;

    await waitFor(
      "the slow job to succeed",
      async () => {
        const job = await db.job.findUnique({ where: { id: slowId } });
        return job && job.status === "SUCCEEDED" ? job : false;
      },
      30_000,
      200,
    );

    const done = await db.job.findUniqueOrThrow({ where: { id: slowId } });
    const finalHits = target.hits.get(slowId)?.total ?? 0;
    const notRequeued = midway.status === "PROCESSING" && midwayHits === 1;
    const ranOnce = finalHits === 1 && done.attempts === 1;

    record(
      "a slow but heartbeating job is never requeued",
      notRequeued && ranOnce,
      `after 6s in flight (>3x the 3s stall timeout) status=${midway.status}, ` +
        `target hits=${midwayHits}; final status=${done.status}, attempts=${done.attempts}, ` +
        `total target hits=${finalHits} (1 means executed exactly once)`,
    );
  } finally {
    await stopWorker(worker);
  }

  // 3b: hard kill mid-execution, then a fresh worker recovers it.
  await clearQueue();
  target.hits.clear();

  const doomed = await submitJob(apiKey, {
    type: "WEBHOOK_CALL",
    idempotencyKey: `s3b-${Date.now()}`,
    payload: { url: `https://localhost:${TARGET_PORT}/hang` },
  });
  if (doomed.status !== 202) {
    record("killed worker's job is recovered once", false, `submit returned ${doomed.status}: ${doomed.raw.slice(0, 200)}`);
    return;
  }
  const doomedId = doomed.body.id;

  const dying = startWorker("w3-doomed");
  try {
    await waitFor(
      "the job to reach the target before the kill",
      async () => (target.hits.get(doomedId)?.total ?? 0) >= 1,
      30_000,
      50,
    );
    const beforeKill = await db.job.findUniqueOrThrow({ where: { id: doomedId } });
    await stopWorker(dying);

    if (!dying.exited) {
      record("killed worker's job is recovered once", false, "the worker did not die");
      return;
    }
    const afterKill = await db.job.findUniqueOrThrow({ where: { id: doomedId } });

    const recovery = startWorker("w3-recovery");
    try {
      await waitFor(
        "the recovered job to finish",
        async () => {
          const job = await db.job.findUnique({ where: { id: doomedId } });
          return job && (job.status === "SUCCEEDED" || job.status === "DEAD") ? job : false;
        },
        180_000,
        500,
      );

      const job = await db.job.findUniqueOrThrow({ where: { id: doomedId } });
      const hits = target.hits.get(doomedId)?.total ?? 0;
      const attempts = await db.jobAttempt.count({ where: { jobId: doomedId } });
      const ok = job.status === "SUCCEEDED" && job.attempts === 2 && hits === 2;

      record(
        "killed worker's job is recovered once",
        ok,
        `at kill time status=${beforeKill.status} attempts=${beforeKill.attempts}; ` +
          `after SIGKILL status=${afterKill.status} (left PROCESSING, awaiting staleness); ` +
          `final status=${job.status} attempts=${job.attempts}; attempt rows=${attempts}; ` +
          `target hits=${hits} (2 = the killed attempt plus exactly one recovery, not a double run)`,
      );
    } finally {
      await stopWorker(recovery);
    }
  } finally {
    await stopWorker(dying);
  }
}

// ---------------------------------------------------------------------------
// Scenario 4: the idempotency key is honoured for a matching payload and
// refused for a different one (PR-IDEM-002).
// ---------------------------------------------------------------------------
async function scenario4(apiKey) {
  console.log("\n[4/5] one idempotency key, replayed with same and differing payloads");
  await clearQueue();

  const key = `s4-${Date.now()}`;
  const payload = { url: `https://localhost:${TARGET_PORT}/ok`, marker: 1 };
  const body = { type: "WEBHOOK_CALL", idempotencyKey: key, payload };

  const first = await submitJob(apiKey, body);
  const replay = await submitJob(apiKey, body);
  const conflicting = await submitJob(apiKey, {
    ...body,
    payload: { ...payload, marker: 2 },
  });

  const rows = await db.job.count({ where: { idempotencyKey: key } });
  const ids = new Set([first.body?.id, replay.body?.id]);

  const ok =
    first.status === 202 &&
    replay.status === 200 &&
    ids.size === 1 &&
    first.body.id === replay.body.id &&
    conflicting.status === 409 &&
    rows === 1;

  record(
    "replayed idempotency key returns the same job; a changed payload is 409",
    ok,
    `first=${first.status} (202 created); replay=${replay.status} (200 existing); ` +
      `same job id=${first.body.id === replay.body.id}; ` +
      `conflicting payload=${conflicting.status} (409); rows with that key in the database=${rows}`,
  );
}

// ---------------------------------------------------------------------------
// Scenario 5: two workers, one queue, no job claimed twice.
//
// v1 runs a single worker (PR-TECH-002), so this is deliberately an unsupported
// topology used only to prove the claim is atomic. Nothing here assumes the two
// processes coordinate their concurrency caps (AGENTS rule 16).
// ---------------------------------------------------------------------------
async function scenario5(apiKey, target) {
  console.log("\n[5/5] two worker processes racing on one queue");
  await clearQueue();
  target.hits.clear();

  const jobIds = [];
  for (let i = 0; i < 20; i += 1) {
    const res = await submitJob(apiKey, {
      type: "WEBHOOK_CALL",
      idempotencyKey: `s5-${i}-${Date.now()}`,
      payload: { url: `https://localhost:${TARGET_PORT}/slow` },
    });
    jobIds.push(res.body.id);
  }

  const a = startWorker("w5-a");
  const b = startWorker("w5-b");
  try {
    await waitFor(
      "all 20 jobs to settle",
      async () => {
        const settled = await db.job.count({
          where: { id: { in: jobIds }, status: { in: ["SUCCEEDED", "DEAD"] } },
        });
        return settled === 20;
      },
      180_000,
      500,
    );

    const jobs = await db.job.findMany({
      where: { id: { in: jobIds } },
      select: { id: true, status: true, attempts: true },
    });
    const duplicated = jobs.filter((j) => j.attempts !== 1);
    const succeeded = jobs.filter((j) => j.status === "SUCCEEDED");
    const hitCounts = jobIds.map((id) => target.hits.get(id)?.total ?? 0);
    const overClaimed = hitCounts.filter((c) => c !== 1);

    const ok = duplicated.length === 0 && overClaimed.length === 0 && succeeded.length === 20;

    record(
      "two workers, every job claimed exactly once",
      ok,
      `${succeeded.length}/20 SUCCEEDED; jobs with attempts != 1: ${duplicated.length}; ` +
        `jobs whose target saw a request count other than 1: ${overClaimed.length} ` +
        `(distribution ${hitCounts.join(",")})`,
    );
  } finally {
    await stopWorker(a);
    await stopWorker(b);
  }
}

async function main() {
  loadDotEnv();

  if (!fs.existsSync(WORKER_ENTRY)) {
    throw new Error(`${WORKER_ENTRY} is missing; run: npx tsc -p tsconfig.node.json`);
  }
  if (!fs.existsSync(path.join(CERT_DIR, "cert.pem"))) {
    throw new Error("step9 certificate is missing; run scripts/step9/make-cert.ps1");
  }
  if (!fs.existsSync(path.join(ROOT, ".next"))) {
    throw new Error("no .next build; run: npm run build");
  }

  db = new PrismaClient();
  await db.$connect();

  const started = Date.now();
  console.log(`Step 9 scenarios starting (${new Date(started).toISOString()})`);

  const target = await startTarget(8000);
  const api = startApi();
  const rawKey = `rk_step9_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  const account = await makeAccount(`step9-${Date.now()}`, rawKey);

  try {
    await waitFor("the Next.js API to accept requests", apiIsUp, 120_000, 500);

    const apiKey = rawKey;

    // Optional single-scenario selector, e.g. `node run-scenarios.js 2`. Scenario
    // 2 alone takes ~10 minutes of real backoff, so it is worth being able to
    // run just that one.
    const only = process.argv[2];
    const ordered = [
      ["1", () => scenario1(apiKey, target)],
      ["3", () => scenario3(apiKey, target)],
      ["4", () => scenario4(apiKey)],
      ["5", () => scenario5(apiKey, target)],
      ["2", () => scenario2(apiKey)],
    ];
    for (const [number, run] of ordered) {
      if (only !== undefined && only !== number) {
        continue;
      }
      await run();
    }
  } finally {
    await api.stop();
    await target.close();
    await db.$disconnect();
  }

  const passed = results.filter((r) => r.passed).length;
  console.log(`\n================ STEP 9 SUMMARY ================`);
  for (const r of results) {
    console.log(`  ${r.passed ? "PASS" : "FAIL"}  ${r.name}`);
  }
  console.log(`  ${passed}/${results.length} scenarios passed in ${Math.round((Date.now() - started) / 1000)}s`);
  process.exitCode = passed === results.length ? 0 : 1;
}

main().catch(async (error) => {
  console.error("\nHarness error:", error);
  process.exitCode = 1;
});
