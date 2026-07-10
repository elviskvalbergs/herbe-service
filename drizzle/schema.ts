// drizzle/schema.ts
import { jsonb, pgTable, text, timestamp, uuid, boolean, integer, primaryKey } from 'drizzle-orm/pg-core'

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
