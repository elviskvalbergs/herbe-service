// scripts/spikes/probe-wsvc-native-trigger.mjs
//
// MANUAL spike — NOT run as part of Task 21 or any automated suite. Requires
// Non-Code Prerequisite 1 (a dedicated test ERP company, never production —
// see docs/superpowers/plans/2026-07-08-phase-0-foundations.md "Non-Code
// Prerequisites & Decisions", item 1) to actually execute; without it this
// script has nothing to connect to.
//
// Question this answers: does a REST-created Work Sheet (WSVc, WONr=-1, no
// WOVc) trigger the ERP's own native stock/invoice processing on save, the
// way the ERP UI's paste-from-order flow does? `docs/04-erp-sync.md`
// establishes that posting a WSVc from the ERP UI does NOT touch stock —
// stock write-off and invoice basis fire only when the worksheet is later
// marked OK (OKFlag=1). This probe checks whether a bare REST create (never
// OK'd) behaves the same or differs, so the answer feeds an addendum to
// docs/adr/0003-sync-reconciliation.md.
//
// NOTE (as of Task 21): lib/erp/standard-books/adapter.ts's pushCreate()
// only implements the 'SVOVc' register in Phase 0 — calling it with 'WSVc'
// as written below will throw ("pushCreate not implemented for WSVc in
// Phase 0") until that adapter is extended. Extending pushCreate for WSVc is
// out of scope for Task 21 (docs + spike only, no production logic); it
// needs to land before this probe can actually run against Prerequisite 1's
// test ERP.
//
// Usage: node scripts/spikes/probe-wsvc-native-trigger.mjs <SVOVc SerNr>
import { createStandardBooksAdapter } from '../../lib/erp/standard-books/adapter.ts'

const adapter = createStandardBooksAdapter({
  baseUrl: process.env.TEST_ERP_BASE_URL,
  companyNumber: process.env.TEST_ERP_COMPANY_NUMBER,
  auth: { kind: 'basic', username: process.env.TEST_ERP_USER, password: process.env.TEST_ERP_PASSWORD },
})

const { erpRef } = await adapter.pushCreate('WSVc', {
  SVOSerNr: process.argv[2], // pass an existing SVOVc SerNr as the first CLI arg
  WONr: -1,
  EMCode: process.env.TEST_ERP_TECH_CODE,
})

console.log(`Created WSVc ${erpRef}. Now check in the ERP UI:`)
console.log('  1. Stock module — did a stock movement get created for any rows?')
console.log('  2. Invoice module — did an invoice draft appear?')
console.log('  3. Record the answer in docs/adr/0003-sync-reconciliation.md addendum.')
