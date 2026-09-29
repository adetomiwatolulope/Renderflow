# Retry backoff: absolute attempt timestamps

Job `cmuk8epnx000ltrzoq5el01zb` (WEBHOOK_CALL), final status **DEAD** after 5 of 5 attempts.

Each row is one `JobAttempt`, written by the worker when the attempt
settled. The wait column is the gap between one attempt finishing and the
next one starting, which is the backoff the job actually waited out.
The expected band is computed from `modules/retry/backoff.ts` with jitter
pinned to its minimum and maximum, so any wait outside it came from
something other than the backoff policy.

| Attempt | Outcome | Error | Started (UTC) | Finished (UTC) | Duration | Waited before this attempt | Expected band |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | FAILED | HTTP_500 | 2026-09-27T19:48:47.273Z | 2026-09-27T19:48:47.339Z | 66ms | - | - |
| 2 | FAILED | HTTP_500 | 2026-09-27T19:49:22.468Z | 2026-09-27T19:49:22.479Z | 11ms | 35.13s | 30-45s |
| 3 | FAILED | HTTP_500 | 2026-09-27T19:50:28.291Z | 2026-09-27T19:50:28.305Z | 14ms | 65.81s | 60-90s |
| 4 | FAILED | HTTP_500 | 2026-09-27T19:52:29.615Z | 2026-09-27T19:52:29.625Z | 10ms | 121.31s | 120-180s |
| 5 | FAILED | HTTP_500 | 2026-09-27T20:14:01.797Z | 2026-09-27T20:14:01.972Z | 175ms | 1292.17s | 240-360s **off-band** |

Waits between attempts: 35.13s -> 65.81s -> 121.31s -> 1292.17s

Strictly increasing: **yes**

## Waits that are not backoff

- Wait 4 -> 5 was 1292.17s, but the policy allows 240-360s. The delay is longer than the policy can produce, and the policy is fixed in code, so the difference is time the schedule was not in control of: most often the job waiting in `FAILED` while no worker was running to pick it up. It is reported rather than folded into the ladder, because it measures downtime, not backoff.

Retry configuration is fixed in application code and is not runtime- or
account-configurable (AGENTS rule 8, PR-RETRY-001), so these delays are the
only schedule a caller can observe. Jitter is a fraction of the exponential term
(`JITTER_RATIO = 0.5`) with the total capped at `BACKOFF_MAX_MS`.
