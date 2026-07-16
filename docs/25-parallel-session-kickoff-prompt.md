# 25 — Parallel-session kickoff prompt

Copy the block below into a fresh Claude Code session to assign it one Phase-1 workstream.
Replace the `<WS## ...>` line. One session per workstream; check the conflict map in
`docs/24-phase1-status-and-parallel-handoff.md` §4 before assigning (WS4 must not run
alongside another adapter-touching session; Phase 2 recurrence is already owned).

```
You are working on herbe.service (Bitbucket burti/herbe-service, ~/AI/herbe-service).
Your assignment: <WS## — e.g. "WS12 Documents: worksheet/order report PDF + DOCX engine">.
Work autonomously; only stop for decisions that genuinely need me.

## Setup — do this first, in order
1. Fetch, then create an isolated git worktree on a new branch cut from origin/preview:
   branch name feature/service-phase1-<ws-slug>. Do ALL work in the worktree.
   preview is the deploy branch (service-test.herbe.app): feature branch + PR into preview.
   NEVER push to main. NEVER force-push.
2. If your workstream touches the ERP, materialize the creds into the worktree WITHOUT
   printing any value:
   grep -E '^ERP_DEMO_' ~/AI/herbe-service/.env.local > <worktree>/.env.vars
   printf 'RUN_LIVE_ERP_TESTS=1\n' >> <worktree>/.env.vars
   (.env.vars is git-ignored. Never commit, print, or paste its values anywhere.)
3. Postgres for tests (Homebrew PG14 on 5432):
   export PATH="/opt/homebrew/opt/postgresql@14/bin:$PATH"
   export TEST_DATABASE_URL="postgres://$(whoami)@localhost:5432/postgres"

## Read before planning — in this order
1. docs/24-phase1-status-and-parallel-handoff.md — current status, module map, verified
   ERP facts, conventions, and the parallel-job conflict map. Confirm your WS is not
   already done or owned by another session (Phase 2 recurrence is taken). Note the
   deferred items doc 24 folds into your area — they are part of your scope.
2. docs/21-phase-1-implementation-plan.md — your WS section, plus §2 load-bearing
   constraints (do not violate).
3. Every docs/superpowers/plans/*.md that touches your area — past slices' design
   decisions are binding unless doc 24 says otherwise.
4. If API-facing: the /api/ext contract is FROZEN against the portal
   (lib/api/ext/dto.ts mirrors herbe-portal lib/service/dto.ts) — never change shapes.

## Working method
- Write a slice plan FIRST at docs/superpowers/plans/<today>-service-phase1-<slug>.md:
  resolve design decisions up front and mark them FINAL; commit the plan before coding.
- Execute task-by-task with one fresh subagent per task (subagent-driven development),
  TDD: tests first where practical. Commit after each green task.
- Verification gates for EVERY task, no exceptions:
  pnpm exec tsc --noEmit (clean) ; pnpm exec vitest run (all green) ;
  pnpm exec vitest run --coverage (exit 0 — 90% gates on lib/erp/**, lib/sync/**,
  packages/erp-core/**). Never lower a threshold; add tests instead.
- If your code touches the ERP: extend tests/live/erp-contract.test.ts and run
  pnpm test:live — it must pass against the real ERP before the slice is done.
  Assert/log counts and shapes ONLY, never row values (client data), never credentials.
  If the live run exposes a real-data mismatch, fix the code — do not weaken the test.
- Migrations: scripts/migrations/NNNN_*.sql (next free number, idempotent
  IF NOT EXISTS, filename-sorted; this repo has NO _journal.json).
- Follow the established idioms from doc 24 §2–3: ingest patterns, erp_refs matching
  for entities without a scalar erpRef, deferred-FK conventions (nullable FK → null +
  next-run pickup; NOT NULL FK → skip + count), labelId placeholder format,
  booksNumeric/parseBooksDate/isBooksTrue for Books data quirks.
- Fake-ERP (packages/fake-erp) must model the REAL envelope
  ({ data: { <Register>: [...] }, '@sequence': N }); extend fixtures anonymized only.

## When done
1. Push the feature branch and tell me it's ready to merge into preview (or open the PR).
2. UPDATE docs/24-phase1-status-and-parallel-handoff.md on your branch before the final
   push: flip your WS status in §1, add a §2-style bullet for any infrastructure others
   will build on, record any newly-verified ERP facts, list new deferred items in §4,
   and refresh the "Last updated" line. This is mandatory — the doc is the shared state
   between parallel sessions.
3. Final report: what shipped, proof (test counts + live results), commit SHAs,
   deferred items.
```
