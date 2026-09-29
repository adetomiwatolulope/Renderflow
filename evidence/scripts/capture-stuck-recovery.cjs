// Captures the stuck-job recovery evidence trio: 04a before the kill, 04b after
// the kill with the job wedged, 04c after the stall sweep recovers it.
//
// Lives in evidence/ because it is part of producing the evidence, not part of
// the product. It owns the whole lifecycle — the HTTPS target runs here, the
// worker is a child process, the dashboard screenshots are driven through
// headless Edge over CDP, and the database is read through Prisma.
//
// Run: node evidence/scripts/capture-stuck-recovery.cjs
//
// Assumes the dev server is already up on :3001 (npm run dev) and that the worker
// has been compiled (npm run build:node, or tsc -p tsconfig.node.json).

const { spawn } = require("node:child_process");
const https = require("node:https");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { createHash } = require("node:crypto");
const { PrismaClient } = require("@prisma/client");

const { recordFrame } = require("./frame-manifest.cjs");

const ROOT = path.resolve(__dirname, "..", "..");
const CERT_DIR = path.join(ROOT, "scripts", "step9", "certs");
const OUT_DIR = path.join(ROOT, "evidence");
const WORKER_ENTRY = path.join(ROOT, ".node-build", "worker", "index.js");
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";

const TARGET_PORT = 8443;
const DASHBOARD = "http://localhost:3001";
const RAW_KEY = "rf_evidence_stuck_recovery_key_01";
const ACCOUNT_NAME = "Evidence Stuck Recovery";

// Wall-clock settings. The point of the capture is the *relationship* between the
// heartbeat interval and the stall timeout, not the production values, so these
// are compressed: a 10s heartbeat against a 45s timeout leaves room to photograph
// the wedged state before the sweep requeues the job.
const HEARTBEAT_INTERVAL_MS = 10_000;
const STALL_TIMEOUT_MS = 45_000;
const HANG_MS = 30_000;

const WORKER_ENV = {
  WORKER_CONCURRENCY: "10",
  WORKER_POLL_INTERVAL_MS: "200",
  WORKER_HEARTBEAT_INTERVAL_MS: String(HEARTBEAT_INTERVAL_MS),
  WORKER_STALL_TIMEOUT_MS: String(STALL_TIMEOUT_MS),
  WORKER_SWEEP_INTERVAL_MS: "1000",
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
let db;

function loadDotEnv() {
  const file = path.join(ROOT, ".env");
  for (const rawLine of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
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

function record(name, passed, detail) {
  results.push({ name, passed, detail });
  console.log(`  ${passed ? "PASS" : "FAIL"}  ${name}\n        ${detail}\n`);
}

// ---------------------------------------------------------------------------
// Target: hangs the first delivery so the worker is unambiguously mid-execution
// when it is killed, then answers 200 immediately on the recovered retry so the
// final frame shows a succeeded job rather than a second failure.
// ---------------------------------------------------------------------------

function startTarget() {
  const seen = new Set();
  const server = https.createServer(
    {
      key: fs.readFileSync(path.join(CERT_DIR, "key.pem")),
      cert: fs.readFileSync(path.join(CERT_DIR, "cert.pem")),
    },
    (req, res) => {
      const key = req.headers["idempotency-key"] || "anon";
      const first = !seen.has(key);
      seen.add(key);
      const reply = () => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, attempt: first ? 1 : 2 }));
      };
      if (first) {
        setTimeout(reply, HANG_MS);
        return;
      }
      reply();
    },
  );
  return new Promise((resolve) => {
    server.listen(TARGET_PORT, "127.0.0.1", () =>
      resolve({ close: () => new Promise((done) => server.close(done)) }),
    );
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
  const state = { label, child, exited: false, output: "" };
  child.stdout.on("data", (c) => {
    state.output += c.toString();
    process.stdout.write(`  [${label}] ${c.toString()}`);
  });
  child.stderr.on("data", (c) => {
    state.output += c.toString();
    process.stderr.write(`  [${label}!] ${c.toString()}`);
  });
  child.on("exit", () => {
    state.exited = true;
  });
  return state;
}

function stopWorker(state) {
  if (state.exited) return Promise.resolve();
  return new Promise((resolve) => {
    state.child.on("exit", resolve);
    state.child.kill("SIGKILL");
  });
}

async function waitFor(label, predicate, timeoutMs, intervalMs = 150) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await sleep(intervalMs);
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for: ${label}`);
}

// ---------------------------------------------------------------------------
// Screenshots: one headless Edge for the whole capture, reused across frames.
// ---------------------------------------------------------------------------

async function openBrowser() {
  const userDataDir = path.join(os.tmpdir(), "rf-evidence-edge");
  const edge = spawn(EDGE, [
    "--headless=new",
    "--disable-gpu",
    "--hide-scrollbars",
    "--no-first-run",
    "--no-default-browser-check",
    "--remote-debugging-port=9223",
    `--user-data-dir=${userDataDir}`,
    "about:blank",
  ], { stdio: "ignore" });

  let target = null;
  for (let i = 0; i < 60 && !target; i += 1) {
    await sleep(500);
    try {
      const list = await (await fetch("http://127.0.0.1:9223/json/list")).json();
      target = list.find((t) => t.type === "page");
    } catch {}
  }
  if (!target) throw new Error("could not reach the headless browser");

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  ws.addEventListener("message", (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(JSON.stringify(msg.error)));
      else resolve(msg.result);
    }
  });
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve);
    ws.addEventListener("error", reject);
  });

  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      id += 1;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });

  await send("Page.enable");
  await send("Runtime.enable");
  await send("Emulation.setDeviceMetricsOverride", {
    width: 1500,
    height: 1000,
    deviceScaleFactor: 2,
    mobile: false,
  });

  // Loads the screen and submits the key. Used both to prime the page and to take
  // any frame that can afford a cold load.
  async function loadAndSubmit() {
    await send("Page.navigate", { url: `${DASHBOARD}/jobs` });
    await sleep(3000);
    for (let i = 0; i < 40; i += 1) {
      const ready = await send("Runtime.evaluate", {
        expression: `!!document.querySelector('input[name="apiKey"]') && !!window.next`,
        returnByValue: true,
      });
      if (ready.result.value === true) break;
      await sleep(400);
    }
    await send("Runtime.evaluate", {
      expression: `
        (() => {
          const input = document.querySelector('input[name="apiKey"]');
          const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
          setter.call(input, ${JSON.stringify(RAW_KEY)});
          input.dispatchEvent(new Event('input', { bubbles: true }));
          document.querySelector('form').requestSubmit();
          return 'SUBMITTED';
        })()
      `,
      returnByValue: true,
    });
  }

  async function readStatusCell() {
    const cell = await send("Runtime.evaluate", {
      expression: `(() => {
        const row = document.querySelector('tbody tr');
        if (!row) return '';
        const target = row.children[2];
        return target ? target.innerText.trim() : '';
      })()`,
      returnByValue: true,
    });
    return cell.result.value;
  }

  return {
    // A cold load of this screen costs roughly ten seconds, which is why the
    // in-flight frame is taken from an already-primed page: the webhook executor
    // abandons the delivery after 10s, so a reload would miss the window entirely.
    async prime() {
      await loadAndSubmit();
      await sleep(2500);
    },

    // `expectStatus` is matched against the row's own status cell, never against
    // the whole page: the status filter dropdown lists every status, so a
    // body-text match succeeds instantly and captures the previous frame.
    //
    // `reload` forces a cold load instead of trusting the primed render. A React
    // action form does not reliably re-run under a programmatic requestSubmit, so
    // a frame that is not reloaded can silently show the state from before the
    // event it is meant to be showing.
    async shoot(file, expectStatus, note, reload) {
      if (reload) {
        await loadAndSubmit();
      } else {
        await send("Runtime.evaluate", {
          expression: `document.querySelector('form').requestSubmit(); 'RESUBMITTED'`,
          returnByValue: true,
        });
      }

      let seen = "";
      for (let i = 0; i < 60; i += 1) {
        await sleep(200);
        seen = await readStatusCell();
        if (seen === expectStatus) break;
      }
      if (seen !== expectStatus) {
        throw new Error(`${file}: status cell reads "${seen}", expected "${expectStatus}"`);
      }
      await sleep(500);

      // Read the table back out so the frame is self-describing.
      const text = await send("Runtime.evaluate", {
        expression: `(() => {
          const t = document.querySelector('table');
          return t ? t.innerText : '(no table rendered)';
        })()`,
        returnByValue: true,
      });

      const metrics = await send("Page.getLayoutMetrics");
      const size = metrics.cssContentSize;
      const shot = await send("Page.captureScreenshot", {
        format: "png",
        captureBeyondViewport: true,
        clip: { x: 0, y: 0, width: size.width, height: size.height, scale: 1 },
      });
      fs.writeFileSync(path.join(OUT_DIR, file), Buffer.from(shot.data, "base64"));
      recordFrame(file, note, text.result.value);
      console.log(`  wrote evidence/${file} (${reload ? "reloaded" : "primed render"})`);
    },
    close() {
      ws.close();
      edge.kill();
    },
  };
}

// ---------------------------------------------------------------------------

// Two different attempt numbers exist and conflating them makes the evidence
// wrong. `Job.attempts` is the counter the UI shows, incremented when a job is
// claimed. `JobAttempt` rows are written only when an attempt settles, so a job
// that is in flight, or that was killed mid-flight, has a counter ahead of its
// row count. Both are reported.
async function snapshot(jobId) {
  const job = await db.job.findUnique({
    where: { id: jobId },
    include: { jobAttempts: { orderBy: { startedAt: "asc" } } },
  });
  return {
    status: job.status,
    attempts: job.attempts,
    attemptRows: job.jobAttempts.length,
    lastHeartbeatAt: job.lastHeartbeatAt ? job.lastHeartbeatAt.toISOString() : null,
    updatedAt: job.updatedAt.toISOString(),
  };
}

async function main() {
  loadDotEnv();
  db = new PrismaClient();

  if (!fs.existsSync(WORKER_ENTRY)) {
    throw new Error(`worker build missing: ${WORKER_ENTRY} (run tsc -p tsconfig.node.json)`);
  }
  if (!fs.existsSync(path.join(CERT_DIR, "cert.pem"))) {
    throw new Error(`certs missing in ${CERT_DIR} (run scripts/step9/make-cert.ps1)`);
  }

  // Re-runnable: a previous attempt may have left the account and its key behind,
  // and hashedKey is unique, so clear the prior run before creating a new one.
  // Child rows go first, in dependency order.
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
  const browser = await openBrowser();
  let workerA = null;
  let workerB = null;

  try {
    console.log(`\n  account ${account.id}  key ${RAW_KEY}\n`);

    workerA = startWorker("workerA");
    const res = await fetch(`${DASHBOARD}/api/v1/jobs`, {
      method: "POST",
      headers: { authorization: `Bearer ${RAW_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({
        type: "WEBHOOK_CALL",
        payload: { url: `https://127.0.0.1:${TARGET_PORT}/hang` },
        idempotencyKey: "evidence-stuck-recovery-1",
      }),
    });
    if (res.status !== 202) {
      throw new Error(`submit returned ${res.status}: ${(await res.text()).slice(0, 300)}`);
    }
    const created = await res.json();
    const jobId = created.id;
    console.log(`  submitted ${jobId}\n`);

    await waitFor(
      "the job to be claimed and put in flight",
      async () => {
        const s = await snapshot(jobId);
        return s.status === "PROCESSING" ? s : null;
      },
      30_000,
      100,
    );

    // The webhook executor gives up after 10s, so the worker has to die while the
    // delivery is still in flight. Anything later and the job would have moved to
    // FAILED on its own and the stall sweep would have nothing to recover.
    await browser.prime();
    const before = await snapshot(jobId);
    record(
      "a: job is in flight with a live heartbeat",
      before.status === "PROCESSING",
      `status=${before.status} counter=${before.attempts}/5 attemptRows=${before.attemptRows} lastHeartbeatAt=${before.lastHeartbeatAt} (the counter advances at claim; a row is only written when the attempt settles, so a job in flight has no row yet)`,
    );
    await browser.shoot("04a-before-kill.png", "PROCESSING", "Job in flight with a live heartbeat, before the worker is killed.", false);

    await stopWorker(workerA);
    workerA = null;
    console.log("  worker A SIGKILLed while the delivery was in flight\n");

    const wedged = await snapshot(jobId);
    record(
      "b: job stays wedged in PROCESSING after the worker dies",
      wedged.status === "PROCESSING" && wedged.attemptRows === 0,
      `status=${wedged.status} counter=${wedged.attempts}/5 attemptRows=${wedged.attemptRows} (requeue is ${Math.max(0, Date.now() - Date.parse(wedged.lastHeartbeatAt))}ms away on a ${STALL_TIMEOUT_MS}ms timeout)`,
    );
    await browser.shoot("04b-after-kill.png", "PROCESSING", "Worker SIGKILLed; job still PROCESSING and wedged, no attempt settled yet.", true);

    workerB = startWorker("workerB");
    console.log("  worker B started, waiting for the retry to complete\n");

    // FAILED is not terminal: it is the retry-waiting state. The sweep settles the
    // killed attempt as its own WORKER_STALLED row, the job waits out its backoff,
    // and worker B picks it up again. Waiting on a terminal status alone would stop
    // at that first FAILED and call the recovery finished when nothing had been
    // retried yet, so the wait requires the second settled attempt as well.
    const done = await waitFor(
      "the retry to be claimed and settle",
      async () => {
        const s = await snapshot(jobId);
        const settled = s.attempts >= 2;
        const terminal = s.status === "SUCCEEDED" || s.status === "DEAD";
        return settled && terminal ? s : null;
      },
      300_000,
    );

    record(
      "c: the job is recovered and completes with exactly one extra attempt",
      done.status === "SUCCEEDED" && done.attempts === 2,
      `status=${done.status} counter=${done.attempts}/5 attemptRows=${done.attemptRows}`,
    );
    await browser.shoot("04c-after-recovery.png", done.status, "After recovery: the stall sweep recorded the killed attempt as WORKER_STALLED and the retry succeeded.", true);

    console.log("\n  recovery timeline");
    for (const attempt of (
      await db.jobAttempt.findMany({ where: { jobId }, orderBy: { startedAt: "asc" } })
    )) {
      console.log(
        `    attempt ${attempt.attemptNumber}  ${attempt.outcome}  ${attempt.errorCode ?? "-"}  started ${attempt.startedAt.toISOString()}  finished ${attempt.finishedAt ? attempt.finishedAt.toISOString() : "-"}  ${attempt.durationMs}ms`,
      );
    }
    const targetHits = await db.webhookDelivery.count({ where: { jobId } });
    console.log(`    webhook deliveries for this job: ${targetHits}`);
    console.log("");
  } finally {
    browser.close();
    if (workerA) await stopWorker(workerA);
    if (workerB) await stopWorker(workerB);
    await target.close();
    await db.$disconnect();
  }

  const failed = results.filter((r) => !r.passed);
  console.log(`  ${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(`  FAILED: ${error.message}`);
  process.exit(1);
});
