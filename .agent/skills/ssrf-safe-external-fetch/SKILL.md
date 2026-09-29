---
name: ssrf-safe-external-fetch
description: Any code where RenderFlow's own server makes an outbound HTTP call to a URL supplied by a caller — outbound webhook delivery, or a job payload's source URL (e.g., IMAGE_PROCESSING fetching an image to process). Load before writing or editing either call site.
---

## What this teaches
RenderFlow's trusted infrastructure making a request to a caller-controlled URL is a live SSRF vector against itself — cloud metadata endpoints, internal services, localhost, private IP ranges. This is the same underlying technique required at two distinct call sites (SEC-12, UP-7).

## Ordered steps
1. **Scheme check is necessary but not sufficient.** `https://` is required for registered webhook URLs (PR-WEBHOOK-001), but scheme alone doesn't stop SSRF.
2. **Resolve the hostname and reject non-public IP ranges** — private, loopback, link-local — **before every delivery/fetch attempt**, not only once at registration or job creation. DNS can change after the URL was first validated (DNS rebinding) — re-check every time.
3. **Do not follow redirects to an unvalidated destination.** Either disable automatic redirect-following entirely, or re-validate the destination IP at every hop.
4. **Implement this once, in one shared function** (e.g., `/lib/fetch-external`), called from both webhook delivery (`/modules/webhooks`) and any job executor that fetches a caller-supplied source URL. Never reimplemented per call site.
5. **If this is a job-payload source fetch** (not webhook delivery): also enforce a max content-length and a content-type allowlist matching what the job type expects, *before* handing bytes to any processing step. Oversized or wrong-type → `NON_RETRYABLE` (it's a caller input problem, not transient) (UP-8).
6. **Never treat fetched content as executable** — no template evaluation, no script/markup interpretation of fetched bytes (UP-9).

## Must never
- Validate the URL once at registration/job-creation time and trust it forever.
- Let a validation failure here silently fall back to "fetch anyway" to make an attempt succeed.