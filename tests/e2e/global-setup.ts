// tests/e2e/global-setup.ts
//
// Provisions the fixed e2e database (playwright.config.ts's E2E_DATABASE_URL)
// that the webServer's app instance already connects to by the time this
// file runs — see that config file's top comment for why this is a fixed,
// pre-known URL rather than one created here and handed to webServer.
//
// This runs AFTER the webServer is already up and responding to
// /api/health (see playwright.config.ts), but BEFORE any test navigates —
// Playwright fully awaits globalSetup before starting test workers. The
// app's `postgres()` client (lib/db.ts) doesn't open a real connection
// until the first query executes, which only happens once an actual
// request is handled — always after this file resolves. So it's safe for
// the target database to not exist yet at the moment the server process
// itself starts.
import postgres from 'postgres'
import { execFileSync } from 'node:child_process'
import { PERSONAS } from '../../lib/seed/personas'
import { E2E_DATABASE_URL } from '../../playwright.config'

const ADMIN_DB_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/postgres'
// Pulled back out of E2E_DATABASE_URL (rather than a second literal) so the
// database name only exists once, in playwright.config.ts.
const DB_NAME = new URL(E2E_DATABASE_URL).pathname.replace(/^\//, '')

export const E2E_TENANT_ID = '99999999-0000-0000-0000-000000000001'
export const E2E_COMPANY_ID = '99999999-0000-0000-0000-000000000002'

function isDuplicateDatabaseError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '42P04'
}

async function ensureDatabaseExists() {
  const admin = postgres(ADMIN_DB_URL, { max: 1 })
  try {
    await admin.unsafe(`CREATE DATABASE "${DB_NAME}"`)
  } catch (err) {
    if (!isDuplicateDatabaseError(err)) throw err // 42P04 = duplicate_database: already provisioned by a previous run
  } finally {
    await admin.end({ timeout: 5 })
  }
}

// Shelled out to (rather than `import { runMigrations } from
// '../../scripts/migrate.mjs'`) because Playwright transforms .ts config/
// support files through its own CJS-oriented loader — requiring a real ESM
// .mjs file (migrate.mjs uses top-level `import.meta.url`) from inside that
// loader throws "Cannot use 'import.meta' outside a module". Running it as
// the same `node scripts/migrate.mjs` child process its own CLI entrypoint
// is designed for sidesteps the module-system mismatch entirely.
function runMigrationsInSubprocess(databaseUrl: string) {
  execFileSync('node', ['scripts/migrate.mjs'], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: 'inherit',
  })
}

export default async function globalSetup() {
  await ensureDatabaseExists()
  runMigrationsInSubprocess(E2E_DATABASE_URL)

  // onnotice silences Postgres's routine "truncate cascades to table ..."
  // NOTICE spam (one per FK-dependent table) that the CASCADE below produces
  // on every run — postgres.js otherwise prints each straight to the console.
  const sql = postgres(E2E_DATABASE_URL, { prepare: false, onnotice: () => {} })
  try {
    // This database is dedicated to this spec — a full truncate + reseed on
    // every run is simpler and more deterministic than diffing leftover
    // state from a previous run.
    await sql`TRUNCATE TABLE tenants, erp_companies, users, magic_link_tokens CASCADE`

    await sql`INSERT INTO tenants (id, slug, name) VALUES (${E2E_TENANT_ID}, 'e2e-app-shell', 'E2E App Shell Tenant')`
    await sql`
      INSERT INTO erp_companies (id, tenant_id, display_name, adapter_type, active)
      VALUES (${E2E_COMPANY_ID}, ${E2E_TENANT_ID}, 'E2E Company', 'standard_books', true)
    `
    // Explicit role per persona — authorizeMagicLink's insert-or-return only
    // assigns the schema default role ('technician') on first insert, so
    // dispatch must already exist with role='dispatcher' or its redirect
    // assertion would silently test the wrong role.
    await sql`
      INSERT INTO users (id, tenant_id, email, role)
      VALUES (${PERSONAS.tech.id}, ${E2E_TENANT_ID}, ${PERSONAS.tech.email}, ${PERSONAS.tech.role})
    `
    await sql`
      INSERT INTO users (id, tenant_id, email, role)
      VALUES (${PERSONAS.dispatch.id}, ${E2E_TENANT_ID}, ${PERSONAS.dispatch.email}, ${PERSONAS.dispatch.role})
    `
  } finally {
    await sql.end({ timeout: 5 })
  }
}
