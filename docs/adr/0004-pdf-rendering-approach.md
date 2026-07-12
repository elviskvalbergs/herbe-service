# ADR 0004: PDF rendering approach — Gotenberg (recommended, pending confirmation)

## Status
Proposed — pending product-owner sign-off (Non-Code Prerequisite 6). Not a
Phase 0 blocker: no PDF rendering ships until Phase 1's document engine
(`12-documents-templates.md`).

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
