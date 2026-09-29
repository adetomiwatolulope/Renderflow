---
name: ai-provider-adapter-builder
description: Anything inside /modules/ai — the Claude or DeepSeek adapters for the AI_REQUEST job type, provider validation, or the executor that calls into them. Load before touching either adapter file or the AI_REQUEST executor.
---

## Read first
Section 6 of the PRD says "no built-in provider integrations" as a v1 non-goal, in the same breath that treats `AI_REQUEST` as a working v1 job type under self-execution. The working interpretation this project uses: "no provider integrations" means no AI-specific *business logic* (no cost tracking, no prompt templates, no fallback, no streaming) — not "no code calls a provider at all." A minimal, generic, pass-through adapter is what makes the job type function. This is a flagged interpretation, not a settled decision — say so if you're touching this area for the first time.

## Ordered steps
1. **Confirm this is a pass-through, not an internal AI feature.** The caller's own payload is what gets sent — that's correct and expected, not a leak (AI-1).
2. **Validate `payload.provider` before anything else.** Only `"claude"` or `"deepseek"` are accepted. Missing or invalid → reject explicitly, `NON_RETRYABLE`, at validation time — never default silently to one provider (AI-3).
3. **Contain the blast radius.** Only that one job's own `payload` fields go to the provider. Never another job's data, another account's data, or any of RenderFlow's own operational data (API key hashes, abuse counters, webhook secrets) (AI-2).
4. **Write (or edit) exactly one adapter file per provider** — `/modules/ai/claude.ts` or `/modules/ai/deepseek.ts`. No vendor name or vendor-specific parameter may leak outside these two files (AI-4).
5. **If adding a RenderFlow-authored instruction** (a system prompt wrapping the caller's input): keep it in a separate field per the provider's own message-role structure — never string-concatenated with the caller's content, to prevent prompt injection overriding it. If the adapter is pure pass-through with no added instruction, say so explicitly in the file's own comments (AI-13).
6. **Pin the model version** from server config — never "latest" (AI-6).
7. **No tools, no side effects.** Text (and image, if applicable) in, text out. No function-calling that reaches RenderFlow's database, storage, or queue (AI-7).
8. **Map the provider's response into the standard outcome contract** — timeout/5xx/rate-limit → `RETRYABLE`; 4xx (bad request, RenderFlow's own invalid key, content-policy rejection) → `NON_RETRYABLE`. Same taxonomy as every other job type, no AI-specific retry count or backoff (AI-9).
9. **No fallback between providers on failure** — the job fails/retries under its own outcome; it never silently switches provider (AI-10).
10. **Use RenderFlow's own platform credentials**, one per provider, server-only env vars, read only inside the matching adapter file, never logged (AI-11).
11. **Validate the response before it becomes `Job.result`** — JSON-safe, within size limits — but don't judge whether the AI's answer is *correct*; that's the caller's problem (AI-8).
12. **Write the contract test fixture suite** for whichever adapter changed: success, malformed response, timeout, rate-limit, invalid-provider rejection — against a fake provider, never a real paid call (AI-14).

## Must never
- Let AI_REQUEST content feed into rate-limit decisions, abuse-cap logic, another account's jobs, or any "AI-powered insights" feature — none of that is authorized (AI-12).
- Give AI_REQUEST a higher or different abuse-cap treatment than any other job type (AI-11, PR-ABUSE-001).