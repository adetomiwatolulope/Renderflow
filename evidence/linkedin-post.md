# LinkedIn post

> Publish the text below, then upload `01-jobs-table.png` as the image.
> Suggested caption: *Five statuses, one queue, and a Postgres row lock doing the
> coordinating. The `Attempts` column is the whole story.*

---

Two workers, one queue, zero coordination between them.

The trick is that the claim query never distinguishes FAILED from QUEUED.

[IMAGE: 01-jobs-table.png — the jobs table showing all five statuses]

That table is the whole system. Read the Attempts column against the Status column:

```
QUEUED      0/3    waiting for a worker
PROCESSING  1/4    claimed, in flight
FAILED      2/3    attempt lost, budget left, scheduled for later
SUCCEEDED   2/5    done (this one failed once first)
DEAD        5/5    budget gone, terminal
```

FAILED is not an error. It's a schedule. Here is the entire claim:

```sql
WHERE status IN ('QUEUED', 'FAILED')
  AND (runAt IS NULL OR runAt <= now())
```

Two claimable states, and the only thing separating them is a timestamp. FAILED is
QUEUED with a date in the future. "The job failed" and "the job is waiting to run
again" are not two facts the queue stores, they are one fact plus a clock.

Worth doing for one reason: an operator reading a dashboard needs to know whether to
wait or to intervene. Collapse FAILED and DEAD into a single status and every
failure looks urgent, and none of them are.

Then I killed a worker mid-job.

SIGKILL, mid-flight, on a job that had been heartbeating every 10 seconds. The
interesting part is not that the job recovered. It is what recovery cost:

```
attempt 1   FAILED      WORKER_STALLED   45,699ms
attempt 2   SUCCEEDED                     114ms
```

The sweep does not requeue. It settles a failed attempt.

The crash spent budget. A worker dying is not a free retry, it is attempt 1 of 5,
spent. A job that crashes on every attempt reaches DEAD like anything else instead
of looping forever. "Recover the stuck job" and "retry the failed job" are the same
code path, which is satisfying, because they are the same problem.

The detail that bit me: while that job was in flight, its counter said 1 and there
were zero attempt rows. The counter increments at claim, the audit row is written
when the attempt settles. A job killed mid-flight has a counter but no history. If
you count attempts from your rows, you are wrong exactly when it matters.

One more, and this is the one people get wrong. The sweep fires when the heartbeat
goes stale, never because a job has been running a long time. A slow but alive job
is left completely alone. In testing, a job ran 6 seconds against a 3 second stall
timeout and was correctly left running. Invert that check and you double-send every
legitimately slow job in the system.

The guarantees, stated plainly:

- Never executed twice at once. The claim is `FOR UPDATE SKIP LOCKED`, and the
  status change is the same statement that selects the row, so there is no window
  between choosing a job and owning it.
- Never executed more times than its budget, crashes included.
- At-least-once, not exactly-once. A crash after the side effect re-runs it, so
  every attempt carries a stable Idempotency-Key and the receiver collapses the
  repeat.

That last one is the answer people do not want to hear, but for a Postgres queue it
is the only honest one. The alternative is claiming exactly-once and discovering
the duplicate email in production.

---

## Notes for me, not for the post

- The screenshot is from `npm run seed-demo`, so its timestamps are illustrative
  rather than measured. Every number quoted in the post body is real: the
  WORKER_STALLED/45,699ms/114ms figures come from a live capture
  (`evidence/logs/stuck-recovery-capture.log`), and the 50-jobs-at-peak-10 and
  backoff figures are in `evidence/logs/`.
- The 10s heartbeat and 45s stall timeout in the capture are compressed for
  reproducibility. Production is 30s and 10 minutes
  (`worker/config.ts`). Worth saying if asked, not worth putting in the post.
