# Evidence package

Everything for this evidence bundle lives in this folder, so it can be read, moved
or archived as one unit.

| File | What it is |
|------|------------|
| `EVIDENCE.md` | The evidence document: one section per claim, with the captured output and the screenshot embedded |
| `frames.json` | The exact table text each screenshot was taken with, so a picture can be checked without opening it |
| `01-jobs-table.png` | `/jobs` with rows in all five statuses |
| `04a-before-kill.png` | Stuck job in flight with a live heartbeat, before the worker is killed |
| `04b-after-kill.png` | Same job right after `SIGKILL`: still `PROCESSING`, not yet reclaimed |
| `04c-after-recovery.png` | Same job after the sweep and the retry: `SUCCEEDED`, `2/5` |
| `05-dead-letters.png` | `/dead-letter` view with two `DEAD` job cards |
| `logs/` | Verbatim harness output, plus the generated backoff timestamp table |
| `scripts/` | The capture scripts that produced the screenshots |

## Regenerating

All five screenshots are produced by script, not by hand, and each script verifies
what it is about to photograph **before** taking the picture. A frame that does not
show what its filename claims is never written.

Prerequisites: the dev server running on `http://localhost:3001` (`npm run dev`)
and the worker compiled (`npx tsc -p tsconfig.node.json`).

```powershell
# Jobs table and dead-letter view. Seeds first, and starts no worker: a running
# worker would claim the seeded QUEUED and PROCESSING rows, so by capture time
# the table would no longer contain all five statuses.
npm run seed-demo
node evidence/scripts/capture-views.cjs <the key seed-demo printed>

# Stuck-job recovery: spawns its own failing/slow target and its own workers.
node evidence/scripts/capture-stuck-recovery.cjs
```

`capture-stuck-recovery.cjs` takes about a minute and needs no manual stepping. It
SIGKILLs worker A while the delivery is in flight, lets the stall sweep notice, and
starts worker B to finish the retry. Note the timing constraint it works around:
the webhook executor gives up on a delivery after 10s, so the kill has to land
inside that window, and the in-flight frame is taken from an already-primed page
because a cold load costs longer than the window itself.

## Regenerating the backoff timestamps

```powershell
node evidence/scripts/capture-backoff.cjs      # ~10 min: walks the retry ladder to DEAD
node evidence/scripts/report-backoff.cjs <job id>
```

The report calls the real `backoffDelayMs` with jitter pinned to its bounds and
flags any wait that falls outside the resulting band, so downtime is not presented
as backoff. If a capture is interrupted and its worker dies with it, the parked job
can be finished with `node evidence/scripts/resume-backoff.cjs`.

## A note on the seeded data

`npm run seed-demo` writes attempt rows with hand-written timestamps so the screens
have something to show. Those rows are **not** used as backoff evidence anywhere in
this package: they are fabricated, and quoting them would present fiction as
measurement. Every backoff number here comes from a job a worker actually executed.
