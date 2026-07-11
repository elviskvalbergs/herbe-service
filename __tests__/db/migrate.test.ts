// __tests__/db/migrate.test.ts
//
// Regression suite for the Task 4 review finding: a single sql.unsafe(wholeFile)
// call wraps an entire migration file in ONE implicit transaction, so a
// tolerated "already exists" error on one statement silently rolled back
// sibling DDL that ran before/after it — while the runner still marked the
// file as applied. The integration tests below reproduce that exact scenario
// against a real Postgres and assert the sibling tables survive.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runMigrations, splitSqlStatements } from '@/scripts/migrate'
import { createTestDatabase, type TestDatabase } from '@/lib/test-support/db'

function writeMigrationFile(dir: string, filename: string, sql: string) {
  fs.writeFileSync(path.join(dir, filename), sql, 'utf8')
}

describe('splitSqlStatements', () => {
  it('keeps a $$-quoted plpgsql body with an embedded ; as one statement', () => {
    const input = `CREATE FUNCTION f() RETURNS trigger AS $$
BEGIN
  NEW.x := 1;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;`

    const statements = splitSqlStatements(input)

    expect(statements).toHaveLength(1)
    expect(statements[0]).toContain('NEW.x := 1;')
  })

  it('keeps a custom-tagged dollar-quoted body ($tag$...$tag$) with an embedded ; as one statement', () => {
    const input = `CREATE FUNCTION g() RETURNS void AS $tag$ SELECT 1; SELECT 2; $tag$ LANGUAGE sql;`

    const statements = splitSqlStatements(input)

    expect(statements).toHaveLength(1)
    expect(statements[0]).toContain('SELECT 1; SELECT 2;')
  })

  it('does not split on a ; inside a string literal', () => {
    const input = `INSERT INTO t (name) VALUES ('a;b'); INSERT INTO t (name) VALUES ('c');`

    const statements = splitSqlStatements(input)

    expect(statements).toHaveLength(2)
    expect(statements[0]).toBe(`INSERT INTO t (name) VALUES ('a;b')`)
    expect(statements[1]).toBe(`INSERT INTO t (name) VALUES ('c')`)
  })

  it('does not split on a ; inside a -- line comment', () => {
    const input = `CREATE TABLE t (id int); -- note: uses a semicolon; right here\nCREATE TABLE u (id int);`

    const statements = splitSqlStatements(input)

    expect(statements).toHaveLength(2)
    expect(statements[0]).toBe('CREATE TABLE t (id int)')
    expect(statements[1]).toContain('CREATE TABLE u (id int)')
  })
})

describe('runMigrations regression: sibling DDL survives a tolerated error', () => {
  let testDb: TestDatabase
  let sql: ReturnType<typeof postgres>
  let migrationsDir: string

  beforeAll(async () => {
    testDb = await createTestDatabase()
    sql = postgres(testDb.url, { max: 1 })
    migrationsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'herbe-migrate-test-'))
  })

  afterAll(async () => {
    await sql?.end({ timeout: 5 })
    await testDb?.cleanup()
    fs.rmSync(migrationsDir, { recursive: true, force: true })
  })

  it('keeps reg_a and reg_c even though reg_b already exists and raises a tolerated 42P07', async () => {
    // Pre-create reg_b so the migration file's own "CREATE TABLE reg_b" hits
    // duplicate_table (42P07), which the runner tolerates. Before the
    // per-statement fix, the whole file's implicit transaction (including
    // reg_a and reg_c) rolled back with it — this is the exact bug from review.
    await sql.unsafe('CREATE TABLE reg_b (id int)')

    writeMigrationFile(
      migrationsDir,
      '0001_reg_siblings.sql',
      'CREATE TABLE reg_a (id int);\nCREATE TABLE reg_b (id int);\nCREATE TABLE reg_c (id int);\n',
    )

    await runMigrations(testDb.url, migrationsDir)

    const rows = await sql`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name IN ('reg_a', 'reg_b', 'reg_c')
    `
    const names = rows.map((r) => r.table_name).sort()
    expect(names).toEqual(['reg_a', 'reg_b', 'reg_c'])

    const [applied] = await sql`
      SELECT filename FROM herbe_migrations.applied WHERE filename = '0001_reg_siblings.sql'
    `
    expect(applied?.filename).toBe('0001_reg_siblings.sql')
  })
})

describe('runMigrations: plpgsql migration applies fully in one file; rerun is a no-op', () => {
  let testDb: TestDatabase
  let sql: ReturnType<typeof postgres>
  let migrationsDir: string

  beforeAll(async () => {
    testDb = await createTestDatabase()
    sql = postgres(testDb.url, { max: 1 })
    migrationsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'herbe-migrate-test-'))
    writeMigrationFile(
      migrationsDir,
      '0001_reg_trigger.sql',
      `
CREATE SEQUENCE reg_trig_seq;

CREATE TABLE reg_trig_target (id int);

CREATE FUNCTION reg_trig_fn() RETURNS trigger AS $$
BEGIN
  NEW.id := nextval('reg_trig_seq');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER reg_trig_trigger BEFORE INSERT ON reg_trig_target
FOR EACH ROW EXECUTE FUNCTION reg_trig_fn();
`,
    )
  })

  afterAll(async () => {
    await sql?.end({ timeout: 5 })
    await testDb?.cleanup()
    fs.rmSync(migrationsDir, { recursive: true, force: true })
  })

  it('creates the sequence, function, and trigger in a single run', async () => {
    await runMigrations(testDb.url, migrationsDir)

    const [seq] = await sql`SELECT sequencename FROM pg_sequences WHERE sequencename = 'reg_trig_seq'`
    expect(seq?.sequencename).toBe('reg_trig_seq')

    const [fn] = await sql`SELECT proname FROM pg_proc WHERE proname = 'reg_trig_fn'`
    expect(fn?.proname).toBe('reg_trig_fn')

    const [trig] = await sql`
      SELECT trigger_name FROM information_schema.triggers WHERE trigger_name = 'reg_trig_trigger'
    `
    expect(trig?.trigger_name).toBe('reg_trig_trigger')
  })

  it('is a clean no-op on a second run against the same database', async () => {
    await expect(runMigrations(testDb.url, migrationsDir)).resolves.toBeUndefined()
  })
})

describe('runMigrations: real 0002 domain migration (sequence + plpgsql trigger) applies clean; re-run is a no-op', () => {
  // Task 11's proof that the splitter above handles a real, shipped migration
  // file — not just a synthetic fixture — containing a CREATE SEQUENCE, a
  // CREATE OR REPLACE FUNCTION ... $$ ... $$ LANGUAGE plpgsql body, and
  // CREATE TRIGGER statements (scripts/migrations/0002_domain_customers_items.sql).
  let testDb: TestDatabase
  let sql: ReturnType<typeof postgres>

  beforeAll(async () => {
    testDb = await createTestDatabase()
  })

  afterAll(async () => {
    await sql?.end({ timeout: 5 })
    await testDb?.cleanup()
  })

  it('creates domain_change_seq, the bump_change_seq() function, and both triggers', async () => {
    await runMigrations(testDb.url) // default migrationsDir: the real scripts/migrations
    sql = postgres(testDb.url, { max: 1 })

    const [seq] = await sql`SELECT sequencename FROM pg_sequences WHERE sequencename = 'domain_change_seq'`
    expect(seq?.sequencename).toBe('domain_change_seq')

    const [fn] = await sql`SELECT proname FROM pg_proc WHERE proname = 'bump_change_seq'`
    expect(fn?.proname).toBe('bump_change_seq')

    // DISTINCT: information_schema.triggers has one row per (trigger, firing
    // event) — a single BEFORE INSERT OR UPDATE trigger lists twice.
    const triggers = await sql`
      SELECT DISTINCT trigger_name FROM information_schema.triggers
      WHERE trigger_name IN ('trg_customers_change_seq', 'trg_items_change_seq')
    `
    expect(triggers.map((t) => t.trigger_name).sort()).toEqual([
      'trg_customers_change_seq',
      'trg_items_change_seq',
    ])
  })

  it('is a clean no-op on a second run against the same database', async () => {
    await expect(runMigrations(testDb.url)).resolves.toBeUndefined()
  })

  it('bump_change_seq() assigns a monotonically increasing change_seq on insert and update', async () => {
    const [tenant] = await sql`INSERT INTO tenants (slug, name) VALUES ('mig-t1', 'Migration T1') RETURNING id`
    const [company] = await sql`
      INSERT INTO erp_companies (tenant_id, display_name, adapter_type, adapter_config_json)
      VALUES (${tenant.id}, 'C1', 'standard_books', '{}') RETURNING id
    `

    const [inserted] = await sql`
      INSERT INTO customers (tenant_id, erp_company_id, erp_ref, name, change_seq)
      VALUES (${tenant.id}, ${company.id}, 'MIG001', 'Trigger Test', 0) RETURNING change_seq
    `
    expect(BigInt(inserted.change_seq)).toBeGreaterThan(BigInt(0))

    const [updated] = await sql`
      UPDATE customers SET name = 'Trigger Test Updated' WHERE erp_ref = 'MIG001' RETURNING change_seq
    `
    expect(BigInt(updated.change_seq)).toBeGreaterThan(BigInt(inserted.change_seq))
  })
})

describe('0002 domain migration: raw SQL is independently re-runnable, not just the filename-tracked skip', () => {
  // The "no-op on a second run" tests above only prove that
  // herbe_migrations.applied's filename tracking skips a file it has already
  // recorded — they never re-execute 0002's own SQL, so a regression in its
  // IF NOT EXISTS / CREATE OR REPLACE / DROP TRIGGER IF EXISTS idempotency
  // patterns would go undetected. This test bypasses the filename-skip
  // entirely: it reads the real migration file and feeds its statements
  // (split the same way the runner does) straight to Postgres, twice in a
  // row, so the SQL text itself — not the runner's tracking table — is what's
  // proven idempotent.
  let testDb: TestDatabase
  let sql: ReturnType<typeof postgres>

  beforeAll(async () => {
    testDb = await createTestDatabase()
    // Apply 0001 + 0002 through the normal path first so 0002's FK targets
    // (tenants, erp_companies) exist.
    await runMigrations(testDb.url)
    sql = postgres(testDb.url, { max: 1 })
  })

  afterAll(async () => {
    await sql?.end({ timeout: 5 })
    await testDb?.cleanup()
  })

  it('re-executes 0002_domain_customers_items.sql twice more, bypassing herbe_migrations.applied, with no thrown error', async () => {
    const content = fs.readFileSync(
      path.resolve('scripts/migrations/0002_domain_customers_items.sql'),
      'utf8',
    )
    const statements = splitSqlStatements(content)

    // Two full re-execution passes of the file's own statements, going
    // straight to `sql.unsafe` — never through runMigrations, so the
    // filename-tracking table is never consulted.
    for (let pass = 0; pass < 2; pass++) {
      for (const stmt of statements) {
        await sql.unsafe(stmt)
      }
    }

    const [table] = await sql`
      SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'customers'
    `
    expect(table?.table_name).toBe('customers')

    // The trigger created by the third (re-)execution of the file must still
    // fire correctly, not just still exist.
    const [tenant] = await sql`INSERT INTO tenants (slug, name) VALUES ('mig-t2', 'Migration T2') RETURNING id`
    const [company] = await sql`
      INSERT INTO erp_companies (tenant_id, display_name, adapter_type, adapter_config_json)
      VALUES (${tenant.id}, 'C2', 'standard_books', '{}') RETURNING id
    `
    const [inserted] = await sql`
      INSERT INTO customers (tenant_id, erp_company_id, erp_ref, name, change_seq)
      VALUES (${tenant.id}, ${company.id}, 'MIG002', 'Re-exec Trigger Test', 0) RETURNING change_seq
    `
    expect(BigInt(inserted.change_seq)).toBeGreaterThan(BigInt(0))
  })
})

describe('0003 cron_locks migration: raw SQL is independently re-runnable, not just the filename-tracked skip', () => {
  // Same convention as the 0002 test above (Task 11 review): re-execute the
  // migration file's own statements directly against a fresh harness DB,
  // twice in a row, bypassing herbe_migrations.applied entirely. cron_locks
  // has no FK dependencies, so this doesn't need 0001/0002 applied first.
  let testDb: TestDatabase
  let sql: ReturnType<typeof postgres>

  beforeAll(async () => {
    testDb = await createTestDatabase()
    sql = postgres(testDb.url, { max: 1 })
  })

  afterAll(async () => {
    await sql?.end({ timeout: 5 })
    await testDb?.cleanup()
  })

  it('re-executes 0003_cron_locks.sql twice more, bypassing herbe_migrations.applied, with no thrown error', async () => {
    const content = fs.readFileSync(path.resolve('scripts/migrations/0003_cron_locks.sql'), 'utf8')
    const statements = splitSqlStatements(content)

    for (let pass = 0; pass < 2; pass++) {
      for (const stmt of statements) {
        await sql.unsafe(stmt)
      }
    }

    const [table] = await sql`
      SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'cron_locks'
    `
    expect(table?.table_name).toBe('cron_locks')

    // The re-executed table must still function correctly, not just still exist.
    const [inserted] = await sql`
      INSERT INTO cron_locks (key, locked_at, expires_at) VALUES ('mig-check', now(), now() + interval '1 minute')
      RETURNING key
    `
    expect(inserted.key).toBe('mig-check')
  })
})

describe('0004 outbox migration: raw SQL is independently re-runnable, not just the filename-tracked skip', () => {
  // Same convention as the 0002/0003 tests above (Task 11 review). outbox_ops
  // has a FK to tenants, so 0001 must be applied first.
  let testDb: TestDatabase
  let sql: ReturnType<typeof postgres>

  beforeAll(async () => {
    testDb = await createTestDatabase()
    await runMigrations(testDb.url) // applies 0001-0004 through the normal path first
    sql = postgres(testDb.url, { max: 1 })
  })

  afterAll(async () => {
    await sql?.end({ timeout: 5 })
    await testDb?.cleanup()
  })

  it('re-executes 0004_outbox.sql twice more, bypassing herbe_migrations.applied, with no thrown error', async () => {
    const content = fs.readFileSync(path.resolve('scripts/migrations/0004_outbox.sql'), 'utf8')
    const statements = splitSqlStatements(content)

    for (let pass = 0; pass < 2; pass++) {
      for (const stmt of statements) {
        await sql.unsafe(stmt)
      }
    }

    const [table] = await sql`
      SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'outbox_ops'
    `
    expect(table?.table_name).toBe('outbox_ops')

    // The re-executed table must still function correctly, not just still exist.
    const [tenant] = await sql`INSERT INTO tenants (slug, name) VALUES ('mig-t3', 'Migration T3') RETURNING id`
    const [inserted] = await sql`
      INSERT INTO outbox_ops (id, tenant_id, entity, op, payload_json)
      VALUES ('33333333-0000-0000-0000-000000000001', ${tenant.id}, 'serviceOrder', 'create', '{}')
      RETURNING status
    `
    expect(inserted.status).toBe('pending')
  })
})

describe('0005 auth migration: raw SQL is independently re-runnable, not just the filename-tracked skip', () => {
  // Same convention as the 0002/0003/0004 tests above (Task 11 review). users
  // and magic_link_tokens both have a FK to tenants, so 0001 must be applied
  // first.
  let testDb: TestDatabase
  let sql: ReturnType<typeof postgres>

  beforeAll(async () => {
    testDb = await createTestDatabase()
    await runMigrations(testDb.url) // applies 0001-0005 through the normal path first
    sql = postgres(testDb.url, { max: 1 })
  })

  afterAll(async () => {
    await sql?.end({ timeout: 5 })
    await testDb?.cleanup()
  })

  it('re-executes 0005_auth.sql twice more, bypassing herbe_migrations.applied, with no thrown error', async () => {
    const content = fs.readFileSync(path.resolve('scripts/migrations/0005_auth.sql'), 'utf8')
    const statements = splitSqlStatements(content)

    for (let pass = 0; pass < 2; pass++) {
      for (const stmt of statements) {
        await sql.unsafe(stmt)
      }
    }

    const [usersTable] = await sql`
      SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'users'
    `
    expect(usersTable?.table_name).toBe('users')

    const [tokensTable] = await sql`
      SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'magic_link_tokens'
    `
    expect(tokensTable?.table_name).toBe('magic_link_tokens')

    // The re-executed tables must still function correctly, not just still exist.
    const [tenant] = await sql`INSERT INTO tenants (slug, name) VALUES ('mig-t4', 'Migration T4') RETURNING id`
    const [insertedUser] = await sql`
      INSERT INTO users (tenant_id, email) VALUES (${tenant.id}, 'mig-user@herbe-service.test') RETURNING role
    `
    expect(insertedUser.role).toBe('technician')

    const [insertedToken] = await sql`
      INSERT INTO magic_link_tokens (token_hash, tenant_id, email, expires_at)
      VALUES ('mig-token-hash', ${tenant.id}, 'mig-user@herbe-service.test', now() + interval '15 minutes')
      RETURNING consumed_at
    `
    expect(insertedToken.consumed_at).toBeNull()
  })
})

describe('0006 device_pairing migration: raw SQL is independently re-runnable, not just the filename-tracked skip', () => {
  // Same convention as the 0002/0003/0004/0005 tests above (Task 11 review).
  // device_enrollments and paired_devices both FK to tenants + users, so
  // 0001 and 0005 must be applied first.
  let testDb: TestDatabase
  let sql: ReturnType<typeof postgres>

  beforeAll(async () => {
    testDb = await createTestDatabase()
    await runMigrations(testDb.url) // applies 0001-0006 through the normal path first
    sql = postgres(testDb.url, { max: 1 })
  })

  afterAll(async () => {
    await sql?.end({ timeout: 5 })
    await testDb?.cleanup()
  })

  it('re-executes 0006_device_pairing.sql twice more, bypassing herbe_migrations.applied, with no thrown error', async () => {
    const content = fs.readFileSync(path.resolve('scripts/migrations/0006_device_pairing.sql'), 'utf8')
    const statements = splitSqlStatements(content)

    for (let pass = 0; pass < 2; pass++) {
      for (const stmt of statements) {
        await sql.unsafe(stmt)
      }
    }

    const [enrollmentsTable] = await sql`
      SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'device_enrollments'
    `
    expect(enrollmentsTable?.table_name).toBe('device_enrollments')

    const [devicesTable] = await sql`
      SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'paired_devices'
    `
    expect(devicesTable?.table_name).toBe('paired_devices')

    // The re-executed tables must still function correctly, not just still exist.
    const [tenant] = await sql`INSERT INTO tenants (slug, name) VALUES ('mig-t5', 'Migration T5') RETURNING id`
    const [user] = await sql`
      INSERT INTO users (tenant_id, email) VALUES (${tenant.id}, 'mig-tech@herbe-service.test') RETURNING id
    `
    const [insertedDevice] = await sql`
      INSERT INTO paired_devices (tenant_id, user_id, device_label, pin_hash)
      VALUES (${tenant.id}, ${user.id}, 'Migration Test Phone', 'not-a-real-hash')
      RETURNING failed_attempts
    `
    expect(Number(insertedDevice.failed_attempts)).toBe(0)

    const [insertedEnrollment] = await sql`
      INSERT INTO device_enrollments (token_hash, tenant_id, user_id, expires_at)
      VALUES ('mig-enrollment-token-hash', ${tenant.id}, ${user.id}, now() + interval '7 days')
      RETURNING consumed_at
    `
    expect(insertedEnrollment.consumed_at).toBeNull()
  })
})
