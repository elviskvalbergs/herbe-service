import postgres from 'postgres'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

const TOLERATED = new Set([
  '42710', // duplicate_object
  '42P07', // duplicate_table
  '42P06', // duplicate_schema
  '42701', // duplicate_column
  '42P16', // invalid_table_definition
  '42704', // undefined_object
])

// Split a .sql file into individual statements, splitting on top-level ';' only
// — never inside '...'/"..." strings, -- line or /* */ block comments, or
// $tag$...$tag$ dollar-quoted bodies (plpgsql function bodies contain ';').
// Exported for unit testing.
export function splitSqlStatements(input) {
  const statements = []
  let cur = ''
  let i = 0
  const n = input.length
  while (i < n) {
    const ch = input[i]
    if (ch === '-' && input[i + 1] === '-') {
      const nl = input.indexOf('\n', i)
      const end = nl === -1 ? n : nl
      cur += input.slice(i, end)
      i = end
      continue
    }
    if (ch === '/' && input[i + 1] === '*') {
      const close = input.indexOf('*/', i + 2)
      const end = close === -1 ? n : close + 2
      cur += input.slice(i, end)
      i = end
      continue
    }
    if (ch === "'" || ch === '"') {
      const q = ch
      cur += ch
      i++
      while (i < n) {
        cur += input[i]
        if (input[i] === q) {
          if (input[i + 1] === q) { cur += input[i + 1]; i += 2; continue } // escaped quote
          i++
          break
        }
        i++
      }
      continue
    }
    if (ch === '$') {
      const m = input.slice(i).match(/^\$([A-Za-z_][A-Za-z0-9_]*)?\$/)
      if (m) {
        const tag = m[0]
        const close = input.indexOf(tag, i + tag.length)
        const end = close === -1 ? n : close + tag.length
        cur += input.slice(i, end)
        i = end
        continue
      }
    }
    if (ch === ';') {
      if (cur.trim()) statements.push(cur.trim())
      cur = ''
      i++
      continue
    }
    cur += ch
    i++
  }
  if (cur.trim()) statements.push(cur.trim())
  return statements
}

// migrationsDir defaults to the real migrations dir; tests pass a crafted
// temp dir so regression fixtures never touch scripts/migrations.
export async function runMigrations(connectionString, migrationsDir = './scripts/migrations') {
  const url = connectionString ?? process.env.DATABASE_URL
  if (!url) throw new Error('DATABASE_URL must be set')

  const sql = postgres(url, { prepare: false })
  try {
    await sql`CREATE SCHEMA IF NOT EXISTS herbe_migrations`
    await sql`CREATE TABLE IF NOT EXISTS herbe_migrations.applied (
      id SERIAL PRIMARY KEY,
      filename TEXT NOT NULL UNIQUE,
      hash TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`

    const dir = path.resolve(migrationsDir)
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()

    for (const filename of files) {
      const content = fs.readFileSync(path.join(dir, filename), 'utf8')
      const hash = crypto.createHash('sha256').update(content).digest('hex')

      const [existing] = await sql`SELECT hash FROM herbe_migrations.applied WHERE filename = ${filename}`
      if (existing) continue

      // Execute each statement in its OWN implicit transaction. A single
      // sql.unsafe(wholeFile) call sends the file as one simple-query message,
      // which Postgres wraps in ONE implicit transaction — so a mid-file
      // tolerated "already exists" error would roll back the sibling DDL that
      // ran before AND after it, while we still marked the file applied
      // (silent DDL loss; found in Task 4 review 2026-07-09). Per-statement
      // execution keeps a tolerated error local to its own statement.
      for (const stmt of splitSqlStatements(content)) {
        try {
          await sql.unsafe(stmt)
        } catch (err) {
          if (!TOLERATED.has(err.code)) throw err
          console.warn(`[migrate] tolerated ${err.code} in ${filename}: ${err.message}`)
        }
      }

      await sql`INSERT INTO herbe_migrations.applied (filename, hash) VALUES (${filename}, ${hash})`
      console.log(`[migrate] applied ${filename}`)
    }
  } finally {
    await sql.end({ timeout: 5 })
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await runMigrations()
}
