---
trigger: always_on
---

# git-conventions.md — Build Rules: Version Control

Scope: every commit, branch, and PR made by or for the build agent.
Precedence: PRD (features) > AGENTS.md (process) > this file. If this file conflicts with either, follow them and flag the conflict.
Every rule here is a failure condition. Style preferences (commit prefixes, branch names, subject length, squash vs merge) are deliberately not rules.

## Rules

**GIT-1 Never commit secrets.** No `.env` files (only `.env.example` with names and placeholders), no database URLs with passwords, no API-key hashing pepper/salt, no webhook-secret generation key, and — once billing exists — no Flutterwave keys. Review the staged diff before every commit; never stage with a blind `git add -A`. If a secret ever reaches a pushed commit, treat it as compromised: report it and rotate it. Rewriting history is not remediation.

**GIT-2 Never commit real data.** No real customer API keys, real job payloads, real webhook URLs, or logs containing them. Fixtures are synthetic.

**GIT-3 Protected branches.** No direct commits or pushes to `main` or any shared branch. Work on a branch and open a PR. Never force-push or rewrite history on a shared branch. The agent never merges its own PR and never deploys.

**GIT-4 Destructive commands need an explicit instruction naming them.** `reset --hard`, `clean -fd`, `checkout -- .`, `branch -D`, `push --force`, `stash drop`, or anything else that can destroy uncommitted or unpushed work.

**GIT-5 Schema and migration travel together.** A `schema.prisma` change and its migration (including any required index, database-schema.md DB-4) are in the same commit. A merged migration file is never edited; a fix is a new migration.

**GIT-6 Every commit or PR names the requirement IDs it implements** (PR-XXX-NNN). Work that cannot be tied to an ID is out of scope (AGENTS Q1). The PR description includes the Question 6 checklist and the list of open items from Question 7.

**GIT-7 One phase per PR.** A PR contains work for a single roadmap phase. v2 or v3 code (PRD Section 13) never rides along in a v1 PR — this includes any Flutterwave/billing code, which additionally needs AGENTS rule 21 cleared before it can exist at all.

**GIT-8 Checks are never bypassed.** No `--no-verify`. No disabling, skipping, or loosening CI, lint, type, or test steps to get green — that includes `.skip` on tests and relaxing tsconfig strictness.

**GIT-9 Dependency changes are isolated and visible.** Package additions, removals, and upgrades go in their own commit with the reason in the message. The lockfile is committed and never hand-edited.