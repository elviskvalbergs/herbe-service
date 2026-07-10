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
