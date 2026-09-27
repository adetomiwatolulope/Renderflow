// Captures the two read-only screens: the jobs table and the dead-letter view.
//
// Verifies the rendered table before taking each picture rather than after, so a
// screenshot that does not show what its filename claims is never written. Every
// frame's table text is recorded in evidence/frames.json alongside the image.
//
// Run: node evidence/scripts/capture-views.cjs <account-api-key>
//
// Start no worker first. A running worker would claim the seeded QUEUED and
// PROCESSING rows and the "every status in one frame" claim would stop being true
// by the time the picture was taken.

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const { recordFrame } = require("./frame-manifest.cjs");

const ROOT = path.resolve(__dirname, "..", "..");
const OUT_DIR = path.join(ROOT, "evidence");
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const DASHBOARD = "http://localhost:3001";
const PORT = 9224;

const KEY = process.argv[2];
if (!KEY) {
  console.error("usage: node evidence/scripts/capture-views.cjs <account-api-key>");
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function openBrowser() {
  const edge = spawn(EDGE, [
    "--headless=new",
    "--disable-gpu",
    "--hide-scrollbars",
    "--no-first-run",
    "--no-default-browser-check",
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${path.join(os.tmpdir(), "rf-evidence-views")}`,
    "about:blank",
  ], { stdio: "ignore" });

  let target = null;
  for (let i = 0; i < 60 && !target; i += 1) {
    await sleep(500);
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
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

  const evaluate = async (expression) => {
    const r = await send("Runtime.evaluate", { expression, returnByValue: true });
    return r.result.value;
  };

  return {
    async open(url) {
      await send("Page.navigate", { url });
      await sleep(3000);
      // React must be hydrated or the submit click is swallowed.
      for (let i = 0; i < 40; i += 1) {
        const ready = await evaluate(
          `!!document.querySelector('input[name="apiKey"]') && !!window.next`,
        );
        if (ready === true) break;
        await sleep(400);
      }
      await evaluate(`
        (() => {
          const input = document.querySelector('input[name="apiKey"]');
          const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
          setter.call(input, ${JSON.stringify(KEY)});
          input.dispatchEvent(new Event('input', { bubbles: true }));
          document.querySelector('form').requestSubmit();
          return 'SUBMITTED';
        })()
      `);
      await sleep(3000);
    },

    async readText(selector) {
      return evaluate(
        `(() => { const n = document.querySelector(${JSON.stringify(selector)}); return n ? n.innerText : ''; })()`,
      );
    },

    // Counted from the rendered DOM so the number reported in the manifest is the
    // number actually visible in the picture, not one read from the database.
    async countSelector(selector) {
      return evaluate(`document.querySelectorAll(${JSON.stringify(selector)}).length`);
    },

    async shoot(file) {
      const metrics = await send("Page.getLayoutMetrics");
      const size = metrics.cssContentSize;
      const shot = await send("Page.captureScreenshot", {
        format: "png",
        captureBeyondViewport: true,
        clip: { x: 0, y: 0, width: size.width, height: size.height, scale: 1 },
      });
      fs.writeFileSync(path.join(OUT_DIR, file), Buffer.from(shot.data, "base64"));
      console.log(`  wrote evidence/${file}`);
    },

    close() {
      ws.close();
      edge.kill();
    },
  };
}

// The claim each screenshot has to support, checked against the rendered text.
const JOBS_REQUIRED = ["QUEUED", "PROCESSING", "SUCCEEDED", "FAILED", "DEAD"];

async function main() {
  const browser = await openBrowser();
  try {
    await browser.open(`${DASHBOARD}/jobs`);
    const table = await browser.readText("table");
    if (table === "") throw new Error("the jobs table did not render");

    const missing = JOBS_REQUIRED.filter((status) => !table.includes(status));
    if (missing.length > 0) {
      throw new Error(`jobs table is missing status(es): ${missing.join(", ")}`);
    }
    const rows = table.split("\n").length - 1;
    console.log(`  jobs table verified: ${rows} rows, all five statuses present`);
    await browser.shoot("01-jobs-table.png");
    recordFrame("01-jobs-table.png", `Jobs table for one account: ${rows} jobs covering all five statuses.`, table);

    await browser.open(`${DASHBOARD}/dead-letters`);
    const deadText = await browser.readText("body");
    if (!deadText.includes("DEAD")) {
      throw new Error("the dead-letter view rendered no DEAD job");
    }
    const cards = await browser.countSelector(".dead-card");
    if (cards < 1) throw new Error("the dead-letter view rendered no dead-card elements");
    console.log(`  dead-letter view verified: ${cards} dead job(s) present`);
    await browser.shoot("05-dead-letters.png");
    recordFrame("05-dead-letters.png", `Dead-letter view holding ${cards} exhausted job(s).`, deadText);
  } finally {
    browser.close();
  }
  console.log("  both views captured and verified");
}

main().catch((error) => {
  console.error(`  FAILED: ${error.message}`);
  process.exit(1);
});
