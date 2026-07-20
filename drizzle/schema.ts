// drizzle/schema.ts
import { bigint, index, jsonb, numeric, pgTable, text, timestamp, uuid, boolean, integer, primaryKey, unique } from 'drizzle-orm/pg-core'
import type { AnyPgColumn } from 'drizzle-orm/pg-core'
import type { InferSelectModel } from 'drizzle-orm'

export const tenants = pgTable('tenants', {
  id: uuid('id').primaryKey().defaultRandom(),
  slug: text('slug').notNull().unique(),
  name: text('name').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

export const erpCompanies = pgTable('erp_companies', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
  displayName: text('display_name').notNull(),
  adapterType: text('adapter_type').notNull(), // 'standard_books' | future adapters
  adapterConfigJson: jsonb('adapter_config_json').notNull().default({}),
  apiCredsEncrypted: text('api_creds_encrypted'),
  secretVersion: integer('secret_version').notNull().default(1),
  active: boolean('active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

export const erpSyncState = pgTable(
  'erp_sync_state',
  {
    erpCompanyId: uuid('erp_company_id').notNull().references(() => erpCompanies.id),
    register: text('register').notNull(), // e.g. 'CUVc', 'INVc'
    syncCursor: text('sync_cursor').notNull().default('0'),
    lastSyncAt: timestamp('last_sync_at', { withTimezone: true }),
    lastFullSyncAt: timestamp('last_full_sync_at', { withTimezone: true }),
    syncStatus: text('sync_status').notNull().default('idle'), // 'idle' | 'running' | 'error'
    errorMessage: text('error_message'),
  },
  (t) => [primaryKey({ columns: [t.erpCompanyId, t.register] })],
)

// changeSeq is bumped by the bump_change_seq() plpgsql trigger (0002 migration)
// via a single shared `domain_change_seq` sequence, so a per-user delta feed
// can query `WHERE tenant_id = ? AND change_seq > ?` across entity types.
export const customers = pgTable(
  'customers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
    erpCompanyId: uuid('erp_company_id').notNull().references(() => erpCompanies.id),
    erpRef: text('erp_ref').notNull(),
    name: text('name').notNull(),
    changeSeq: bigint('change_seq', { mode: 'bigint' }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [unique().on(t.erpCompanyId, t.erpRef), index('idx_customers_change_seq').on(t.changeSeq)],
)

export type CustomerRow = InferSelectModel<typeof customers>

// The Phase-0 outbound round-trip (04-erp-sync.md outbox). id is the
// CLIENT-generated UUID, not server-assigned — it's the idempotency key a
// device replays a queued op under, so a retried POST never double-pushes.
export const outboxOps = pgTable('outbox_ops', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
  entity: text('entity').notNull(),
  op: text('op').notNull(),
  payloadJson: jsonb('payload_json').notNull(),
  baseVersion: integer('base_version').notNull().default(0),
  status: text('status').notNull().default('pending'), // 'pending' | 'applied' | 'failed'
  erpRef: text('erp_ref'),
  errorMessage: text('error_message'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  appliedAt: timestamp('applied_at', { withTimezone: true }),
})

export const items = pgTable(
  'items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
    erpCompanyId: uuid('erp_company_id').notNull().references(() => erpCompanies.id),
    erpRef: text('erp_ref').notNull(),
    name: text('name').notNull(),
    changeSeq: bigint('change_seq', { mode: 'bigint' }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [unique().on(t.erpCompanyId, t.erpRef), index('idx_items_change_seq').on(t.changeSeq)],
)

// ItemModel registry (docs/11-service-items-and-parts.md "Model registry is
// the join point"): make/model/category, referenced by serviceItems.modelId
// and (later) PartCompatibility rows.
export const itemModels = pgTable(
  'item_models',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
    make: text('make'),
    model: text('model'),
    category: text('category'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    changeSeq: bigint('change_seq', { mode: 'bigint' }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    index('item_models_tenant_idx').on(t.tenantId),
    index('item_models_change_seq_idx').on(t.changeSeq),
  ],
)

// The service-item location tree (docs/11-service-items-and-parts.md "Part 1
// — The service item hierarchy"): system/unit/lot nodes, self-referencing
// parentId, materialized path. changeSeq is bumped by the same
// bump_change_seq() trigger as customers/items (0009_service_items.sql).
export const serviceItems = pgTable(
  'service_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
    erpCompanyId: uuid('erp_company_id').references(() => erpCompanies.id),
    erpRef: text('erp_ref'),
    parentId: uuid('parent_id').references((): AnyPgColumn => serviceItems.id),
    customerId: uuid('customer_id').references(() => customers.id),
    kind: text('kind').notNull(), // NodeKind: 'system' | 'unit' | 'lot'
    name: text('name').notNull(),
    serialNr: text('serial_nr'),
    secondarySerial: text('secondary_serial'),
    quantity: integer('quantity'),
    modelId: uuid('model_id').references(() => itemModels.id),
    path: text('path').notNull().default(''),
    positionCode: text('position_code'),
    labelId: text('label_id').notNull(),
    attributes: jsonb('attributes').notNull().default({}),
    siteName: text('site_name'),
    warrantyUntil: timestamp('warranty_until', { withTimezone: true }),
    warrantyLaborCovered: boolean('warranty_labor_covered').notNull().default(false),
    warrantyPartsCovered: boolean('warranty_parts_covered').notNull().default(false),
    changeSeq: bigint('change_seq', { mode: 'bigint' }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    unique().on(t.erpCompanyId, t.erpRef),
    unique().on(t.labelId),
    index('service_items_tenant_idx').on(t.tenantId),
    index('service_items_parent_idx').on(t.parentId),
    index('service_items_label_idx').on(t.labelId),
    index('service_items_change_seq_idx').on(t.changeSeq),
    index('service_items_customer_idx').on(t.customerId),
  ],
)

export type ItemModelRow = InferSelectModel<typeof itemModels>
export type ServiceItemRow = InferSelectModel<typeof serviceItems>

// Task 14: the app's own identity table (docs/05-users-auth.md). External
// logins (Entra ID, Baltic eID, ...) attach as separate identity links in a
// later phase; this table is the identity itself, not a link. Declared here
// (ahead of its usual place below) because worksheets.technicianUserId
// references it.
export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
    email: text('email').notNull(),
    role: text('role').notNull().default('technician'),
    sessionVersion: integer('session_version').notNull().default(1),
    passwordHash: text('password_hash'),
    mfaSecretEncrypted: text('mfa_secret_encrypted'),
    mfaEnabled: boolean('mfa_enabled').notNull().default(false),
    mfaTotpLastUsedEpoch: integer('mfa_totp_last_used_epoch'),
    // WS1 Task 3 (settings model — user prefs): validated in application code
    // (lib/settings/user-prefs.ts) against lib/i18n/config.ts's locale list
    // and the 'standard' | 'sunlight' | 'dark' display-scheme union.
    locale: text('locale').notNull().default('lv'),
    displayScheme: text('display_scheme').notNull().default('standard'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique().on(t.tenantId, t.email)],
)

export const identityLinks = pgTable(
  'identity_links',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
    userId: uuid('user_id').notNull().references(() => users.id),
    provider: text('provider').notNull(), // 'erp' | future: 'entra-id' | 'eid'
    erpCompanyId: uuid('erp_company_id').references(() => erpCompanies.id),
    externalId: text('external_id').notNull(), // UserVc.Code for provider = 'erp'
    linkedAt: timestamp('linked_at', { withTimezone: true }).notNull().defaultNow(),
    linkedBy: text('linked_by').notNull(), // 'auto-match:email' | admin user id
  },
  (t) => [
    unique().on(t.userId, t.provider, t.erpCompanyId),
    index('identity_links_erp_lookup_idx').on(t.erpCompanyId, t.externalId),
  ],
)
export type IdentityLinkRow = InferSelectModel<typeof identityLinks>

// Service orders (docs/02-data-model.md, 11-service-items-and-parts.md): the
// top-level job entity. orderNumber is the app's OWN number — the ERP
// register ref lives in erpRefs (below), not a scalar erpRef column here: a
// service order has no single scalar ERP counterpart (see erpRefs comment).
// changeSeq is bumped by the same bump_change_seq() trigger as
// customers/items/serviceItems (0010_service_orders.sql).
export const serviceOrders = pgTable(
  'service_orders',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
    erpCompanyId: uuid('erp_company_id').references(() => erpCompanies.id),
    customerId: uuid('customer_id').notNull().references(() => customers.id),
    siteName: text('site_name'),
    contactName: text('contact_name'),
    description: text('description'),
    priority: text('priority'),
    requestedAt: timestamp('requested_at', { withTimezone: true }),
    promisedDate: timestamp('promised_date', { withTimezone: true }),
    status: text('status').notNull().default('New'), // OrderStatus
    defaultChargeType: text('default_charge_type').notNull().default('invoiceable'), // ChargeType
    orderNumber: text('order_number'),
    crewGroupId: uuid('crew_group_id'),
    changeSeq: bigint('change_seq', { mode: 'bigint' }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    index('service_orders_tenant_idx').on(t.tenantId),
    index('service_orders_customer_idx').on(t.customerId),
    index('service_orders_status_idx').on(t.status),
    index('service_orders_change_seq_idx').on(t.changeSeq),
  ],
)

// Per-line group-service rows (lib/domain/coverage.ts resolves `coverage`
// against a member set). Child rows of an order: no independent
// changeSeq/tombstone of their own, same as the order they belong to.
export const serviceOrderRows = pgTable(
  'service_order_rows',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orderId: uuid('order_id').notNull().references(() => serviceOrders.id),
    serviceItemId: uuid('service_item_id').references(() => serviceItems.id),
    coverage: jsonb('coverage'), // Coverage
    symptom: text('symptom'),
    workType: text('work_type'),
    chargeType: text('charge_type'), // ChargeType
  },
  (t) => [index('service_order_rows_order_idx').on(t.orderId)],
)

// Worksheets (docs/02-data-model.md, 11-service-items-and-parts.md): one per
// (service order x technician) — WSVc.EMCode is single-technician, so a crew
// is N worksheets sharing crewGroupId. No scalar erpRef column: a worksheet
// maps to BOTH a WSVc record and a worksheetShadow ActVc, so its ERP refs
// live in erpRefs (below), keyed by purpose. changeSeq is bumped by the same
// trigger as serviceOrders (0011_worksheets.sql).
export const worksheets = pgTable(
  'worksheets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
    erpCompanyId: uuid('erp_company_id').references(() => erpCompanies.id),
    orderId: uuid('order_id').notNull().references(() => serviceOrders.id),
    technicianUserId: uuid('technician_user_id').references(() => users.id),
    crewGroupId: uuid('crew_group_id'),
    status: text('status').notNull().default('Draft'), // WorksheetStatus
    workDescription: text('work_description'),
    fault: text('fault'),
    cause: text('cause'),
    remedy: text('remedy'),
    signedOnSite: boolean('signed_on_site').notNull().default(false),
    signatureLockedAt: timestamp('signature_locked_at', { withTimezone: true }),
    revision: integer('revision').notNull().default(0),
    rejectedReason: text('rejected_reason'),
    changeSeq: bigint('change_seq', { mode: 'bigint' }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    index('worksheets_tenant_idx').on(t.tenantId),
    index('worksheets_order_idx').on(t.orderId),
    index('worksheets_status_idx').on(t.status),
    index('worksheets_change_seq_idx').on(t.changeSeq),
    // One worksheet per (order x technician) — enforced as a partial unique
    // index (0011_worksheets.sql) so it can't be expressed as a plain
    // drizzle `unique()` (those don't support a WHERE predicate); the index
    // is created by the migration and this definition is documentation-only
    // for drizzle-kit's diffing.
  ],
)

// Child rows of a worksheet: no independent changeSeq/tombstone of their
// own, same as serviceOrderRows above.
export const worksheetRows = pgTable(
  'worksheet_rows',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    worksheetId: uuid('worksheet_id').notNull().references(() => worksheets.id),
    serviceItemId: uuid('service_item_id').references(() => serviceItems.id),
    description: text('description'),
    quantity: numeric('quantity'),
    unit: text('unit'),
    serial: text('serial'),
    chargeType: text('charge_type').notNull().default('invoiceable'), // ChargeType
    stockLocation: text('stock_location'),
    price: numeric('price'),
    sum: numeric('sum'),
  },
  (t) => [index('worksheet_rows_worksheet_idx').on(t.worksheetId)],
)

export const timeEntries = pgTable(
  'time_entries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    worksheetId: uuid('worksheet_id').notNull().references(() => worksheets.id),
    kind: text('kind').notNull(), // 'work' | 'travel'
    direction: text('direction'), // 'to' | 'from' | null
    startedAt: timestamp('started_at', { withTimezone: true }),
    endedAt: timestamp('ended_at', { withTimezone: true }),
    minutes: integer('minutes'),
    pauseReason: text('pause_reason'),
  },
  (t) => [index('time_entries_worksheet_idx').on(t.worksheetId)],
)

export const distanceEntries = pgTable(
  'distance_entries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    worksheetId: uuid('worksheet_id').notNull().references(() => worksheets.id),
    km: numeric('km'),
    billable: boolean('billable'),
  },
  (t) => [index('distance_entries_worksheet_idx').on(t.worksheetId)],
)

// The erpRef set (docs/02-data-model.md 154-158): erpRef is a SET keyed by
// purpose, not a scalar column — e.g. a worksheet maps to both a primary
// WSVc record and a worksheetShadow ActVc. entityType/entityId is a loose
// polymorphic reference (no FK) so this one table serves
// service_order/worksheet/service_item alike (0012_erp_refs.sql).
export const erpRefs = pgTable(
  'erp_refs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
    erpCompanyId: uuid('erp_company_id').references(() => erpCompanies.id),
    entityType: text('entity_type').notNull(), // 'service_order' | 'worksheet' | 'service_item'
    entityId: uuid('entity_id').notNull(),
    purpose: text('purpose').notNull(), // ErpRefPurpose
    register: text('register'), // 'SVOVc' | 'WSVc' | 'SVOSerVc' | 'ActVc'
    recordRef: text('record_ref').notNull(),
    lastSequence: bigint('last_sequence', { mode: 'bigint' }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique().on(t.entityType, t.entityId, t.purpose),
    index('erp_refs_entity_idx').on(t.entityType, t.entityId),
  ],
)

export type ServiceOrderRow = InferSelectModel<typeof serviceOrders>
export type ServiceOrderLineRow = InferSelectModel<typeof serviceOrderRows>
export type WorksheetRow = InferSelectModel<typeof worksheets>
export type WorksheetLineRow = InferSelectModel<typeof worksheetRows>
export type TimeEntryRow = InferSelectModel<typeof timeEntries>
export type DistanceEntryRow = InferSelectModel<typeof distanceEntries>
export type ErpRefRow = InferSelectModel<typeof erpRefs>

// Denormalized, append-only HistoryEvent projection (docs/02-data-model.md
// "HistoryEvent (service history)", lib/domain/history-projector.ts). No
// changeSeq/bump_change_seq trigger and no deletedAt here — history is
// delta-fed by insert only, never updated or tombstoned, unlike
// serviceItems/serviceOrders/worksheets above. `key` is the projector's
// deterministic idempotency key; unique(tenantId, key) is what makes the
// store's upsertHistoryEvents onConflictDoNothing idempotent
// (0013_history_events.sql).
export const historyEvents = pgTable(
  'history_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
    serviceItemId: uuid('service_item_id').notNull().references(() => serviceItems.id),
    key: text('key').notNull(),
    at: timestamp('at', { withTimezone: true }),
    kind: text('kind'), // HistoryEventKind
    summary: text('summary'),
    orderId: uuid('order_id').references(() => serviceOrders.id),
    worksheetId: uuid('worksheet_id').references(() => worksheets.id),
    coverageCovered: integer('coverage_covered'),
    coverageOf: integer('coverage_of'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique().on(t.tenantId, t.key),
    index('history_events_tenant_item_idx').on(t.tenantId, t.serviceItemId),
  ],
)

export type HistoryEventRow = InferSelectModel<typeof historyEvents>

// tokenHash is the SHA-256 hash of the raw token handed to the user — the raw
// token itself is never persisted (lib/auth/magic-link-provider.ts).
export const magicLinkTokens = pgTable('magic_link_tokens', {
  tokenHash: text('token_hash').primaryKey(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
  email: text('email').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  consumedAt: timestamp('consumed_at', { withTimezone: true }),
})

// Task 15: technician PIN-on-paired-device login (docs/05-users-auth.md). A
// device is paired once via a one-time admin-issued enrolment token (same
// single-use-token shape as magicLinkTokens above); daily field unlock then
// re-verifies the PIN locally against pairedDevices (app/api/auth/device/unlock)
// rather than forcing a fresh sign-in.
export const deviceEnrollments = pgTable('device_enrollments', {
  tokenHash: text('token_hash').primaryKey(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
  userId: uuid('user_id').notNull().references(() => users.id),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  consumedAt: timestamp('consumed_at', { withTimezone: true }),
})

// Task 22: scoped-replication membership table (03-architecture.md "Scoped
// replication"). Proven here against a synthetic entityType ('note') — Phase
// 0 has no assignment-scoped entities (orders/worksheets ship Phase 1); this
// table is reused unchanged once they exist, per ADR 0005. membershipSeq is
// bumped by the bump_membership_seq() trigger (0007 migration) from the SAME
// domain_change_seq sequence Task 11's bump_change_seq() uses — one shared
// monotonic space, not a second sequence.
export const scopeMembership = pgTable(
  'scope_membership',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').notNull().references(() => users.id),
    entityType: text('entity_type').notNull(),
    entityId: text('entity_id').notNull(),
    membershipSeq: bigint('membership_seq', { mode: 'bigint' }).notNull(),
    inScopeSince: timestamp('in_scope_since', { withTimezone: true }).notNull().defaultNow(),
    outScopeSeq: bigint('out_scope_seq', { mode: 'bigint' }),
  },
  (t) => [unique().on(t.userId, t.entityType, t.entityId), index('idx_scope_membership_seq').on(t.membershipSeq)],
)

// pinHash is argon2 — never plaintext. failedAttempts/lockedUntil implement
// the rate-limit + lockout described in docs/05-users-auth.md ("PIN attempts
// are rate-limited with wipe-on-N-failures"): Phase 0 implements this as a
// time-boxed lockedUntil window (app/api/auth/device/unlock), not a
// destructive wipe of the pairing itself.
export const pairedDevices = pgTable('paired_devices', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
  userId: uuid('user_id').notNull().references(() => users.id),
  deviceLabel: text('device_label').notNull(),
  pinHash: text('pin_hash').notNull(),
  failedAttempts: bigint('failed_attempts', { mode: 'number' }).notNull().default(0),
  lockedUntil: timestamp('locked_until', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  lastUnlockAt: timestamp('last_unlock_at', { withTimezone: true }),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
})

// Task 1 of the /api/ext/v1 read-API slice (docs/superpowers/sdd/task-1-brief.md):
// scoped bearer tokens the ext API authenticates against. tokenHash is the
// SHA-256 hash of the raw token (same never-persist-the-raw-value idiom as
// magicLinkTokens above). customerCodes scopes a token to a subset of
// customers; empty array means no customer restriction is encoded here (the
// route layer decides what an empty scope means). No changeSeq/deletedAt —
// append-only-ish like historyEvents: tokens aren't delta-synced, and
// revocation is a revokedAt timestamp, not a tombstone.
export const extTokens = pgTable(
  'ext_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
    erpCompanyId: uuid('erp_company_id').notNull().references(() => erpCompanies.id),
    name: text('name').notNull(),
    tokenHash: text('token_hash').notNull(),
    customerCodes: text('customer_codes').array().notNull().default([]),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (t) => [
    unique().on(t.tokenHash),
    index('ext_tokens_company_idx').on(t.erpCompanyId),
  ],
)

export type ExtTokenRow = InferSelectModel<typeof extTokens>

// Task 6 of the /api/ext/v1 read-API slice (docs/superpowers/sdd/task-6-brief.md):
// fixed-window rate-limit counter keyed on (tokenId, endpoint, windowStart).
// No FK to extTokens — standalone, so a deleted token just orphans its
// counter rows instead of requiring cascade bookkeeping.
export const extRateLimit = pgTable(
  'ext_rate_limit',
  {
    tokenId: uuid('token_id').notNull(),
    endpoint: text('endpoint').notNull(),
    windowStart: timestamp('window_start', { withTimezone: true }).notNull(),
    count: integer('count').notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.tokenId, t.endpoint, t.windowStart] })],
)

// WS1 Task 9 (push infra, docs/superpowers/sdd/task-9-brief.md): one row per
// browser/device Push subscription (PushSubscriptionJSON from the client's
// `PushManager.subscribe()`). endpoint is globally unique per the Push API
// spec (it's the push service's per-subscription URL), so it doubles as the
// natural upsert key for subscribe. No tenantId — a subscription is scoped
// to the user only; lib/push/send.ts looks up by userId.
export const pushSubscriptions = pgTable(
  'push_subscriptions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').notNull().references(() => users.id),
    endpoint: text('endpoint').notNull(),
    p256dh: text('p256dh').notNull(),
    auth: text('auth').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique().on(t.endpoint), index('push_subscriptions_user_idx').on(t.userId)],
)

export type PushSubscriptionRow = InferSelectModel<typeof pushSubscriptions>

// WS4 ERP outbound slice (docs/superpowers/plans/2026-07-16-service-phase1-erp-outbound.md
// decision 1, 0020_erp_push_queue.sql, renumbered from 0017 — WS2's
// 0017/0018/0019 landed and deployed first): the app->ERP write path's own FIFO
// saga queue. outboxOps (above) stays a client-op journal; this is its own
// pair. lane is the FIFO ordering key (e.g. "order:<orderId>") so a
// worksheet push never races ahead of its order's create. No changeSeq
// trigger — the saga engine (Task 5) drives status transitions directly.
export const erpPushGroups = pgTable(
  'erp_push_groups',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
    erpCompanyId: uuid('erp_company_id').notNull().references(() => erpCompanies.id, { onDelete: 'cascade' }),
    lane: text('lane').notNull(),
    kind: text('kind').notNull(), // 'order_create' | 'worksheet_push'
    status: text('status').notNull().default('pending'), // PushStatus
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('erp_push_groups_company_status_idx').on(t.erpCompanyId, t.status),
    index('erp_push_groups_lane_created_idx').on(t.lane, t.createdAt),
  ],
)

// Seq-ordered work items within a group. groupId cascades (0020 migration)
// so a group delete takes its steps with it.
export const erpPushSteps = pgTable(
  'erp_push_steps',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    groupId: uuid('group_id')
      .notNull()
      .references(() => erpPushGroups.id, { onDelete: 'cascade' }),
    seq: integer('seq').notNull(),
    entityType: text('entity_type').notNull(), // 'serviceOrder' | 'worksheet'
    entityId: uuid('entity_id').notNull(),
    register: text('register').notNull(), // 'SVOVc' | 'WSVc'
    op: text('op').notNull(), // 'create' | 'update'
    status: text('status').notNull().default('pending'), // PushStatus
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }),
    erpRef: text('erp_ref'),
    errorMessage: text('error_message'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique().on(t.groupId, t.seq),
    index('erp_push_steps_group_idx').on(t.groupId),
  ],
)

export type PushGroupRow = InferSelectModel<typeof erpPushGroups>
export type PushStepRow = InferSelectModel<typeof erpPushSteps>
