# ADR 0004: PDF rendering approach — Gotenberg (accepted)

## Status
Accepted (2026-07-20, WS12 documents slice — `docs/superpowers/plans/2026-07-20-service-phase1-ws12-documents.md`).
Originally Proposed pending product-owner sign-off (Non-Code Prerequisite 6);
confirmed when the document engine landed. See the addendum below for the
implementation and the still-open infra decision.

## Context
`06-roadmap.md` lists "PDF rendering approach" as a Phase 0 sync-spike output,
noting it "must also fit the DOCX pipeline" (`12-documents-templates.md`).
`15-testing-strategy.md` names Gotenberg as the container used for PDF-render
smoke tests — the only concrete signal in the spec docs, though no doc states
the decision outright.

## Decision (recommended, not yet confirmed)
Gotenberg — a stateless HTTP microservice wrapping LibreOffice + Chromium,
run as its own container (matches the fake-ERP server's "own small deployment"
pattern from Task 6). It renders both HTML→PDF (the built-in order-level
report) and DOCX→PDF (the mail-merge template engine) through one service,
avoiding a second rendering stack for the DOCX path.

## Alternative considered
Puppeteer/headless Chromium in-process: simpler for HTML→PDF alone, but
doesn't solve DOCX→PDF, meaning two rendering paths instead of one. Rejected
for that reason, not for capability.

## Consequences
- No code lands in Phase 0 either way — this ADR only needs to be confirmed
  before Phase 1's document engine starts, so it isn't designed twice.
- If confirmed, Gotenberg runs as a docker-compose service locally and its own
  small Vercel-adjacent deployment (or a Fly.io/Render container, since
  Gotenberg isn't a Vercel Function) in staging/production — record that
  infrastructure decision as an addendum once made.

## Addendum (2026-07-20) — implementation

Gotenberg is implemented as the converter for WS12. Both render paths go
through one service: the built-in order report renders HTML then
`/forms/chromium/convert/html`; a DOCX template merges then
`/forms/libreoffice/convert`.

- Client: `lib/documents/convert/gotenberg.ts` — global `fetch` multipart, read
  from `GOTENBERG_URL`. Typed errors distinguish retryable states:
  `ConverterUnavailableError` (env unset or connection refused),
  `ConverterTimeoutError`, `ConverterHttpError` (non-2xx), `ConverterBadOutputError`
  (2xx body isn't a `%PDF-`). The render job treats all of them as retryable
  (backoff → dead after 8 attempts) — the ERP push-queue taxonomy.
- **Graceful degradation:** when `GOTENBERG_URL` is unset/unreachable, render
  jobs stay queued and retry. Approval never blocks on rendering (it's off the
  critical path, enqueued in the approval transaction and drained by the
  `/api/cron/documents-tick` cron), so a converter outage delays reports without
  blocking field/approval work.
- Verified against a real `gotenberg/gotenberg:8` container (HTML→PDF and
  DOCX→PDF both produce valid `%PDF-` output); the live smoke lives at
  `tests/gotenberg/**`, gated on `RUN_GOTENBERG_TESTS=1` (`pnpm test:gotenberg`),
  excluded from the default/CI run.

**Still open — production hosting.** Gotenberg is not a Vercel Function; it
needs its own container (Fly.io / Render / a Vercel-adjacent deployment) with
`GOTENBERG_URL` pointed at it per environment. Until that container exists in
staging/production, reports queue and retry rather than render. This is the one
infra decision this ADR still defers.
