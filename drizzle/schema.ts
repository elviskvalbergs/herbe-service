// drizzle/schema.ts
import { bigint, index, jsonb, pgTable, text, timestamp, uuid, boolean, integer, primaryKey, unique } from 'drizzle-orm/pg-core'
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
  },
  (t) => [index('item_models_tenant_idx').on(t.tenantId)],
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
  ],
)

export type ItemModelRow = InferSelectModel<typeof itemModels>
export type ServiceItemRow = InferSelectModel<typeof serviceItems>

// Task 14: the app's own identity table (docs/05-users-auth.md). External
// logins (Entra ID, Baltic eID, ...) attach as separate identity links in a
// later phase; this table is the identity itself, not a link.
export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
    email: text('email').notNull(),
    role: text('role').notNull().default('technician'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique().on(t.tenantId, t.email)],
)

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
