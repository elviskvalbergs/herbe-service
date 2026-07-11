// drizzle/schema.ts
import { bigint, index, jsonb, pgTable, text, timestamp, uuid, boolean, integer, primaryKey, unique } from 'drizzle-orm/pg-core'

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
