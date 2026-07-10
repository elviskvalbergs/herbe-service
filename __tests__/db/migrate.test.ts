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
