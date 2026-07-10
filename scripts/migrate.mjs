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

export async function runMigrations(connectionString) {
  const url = connectionString ?? process.env.DATABASE_URL
  if (!url) throw new Error('DATABASE_URL must be set')

  const sql = postgres(url, { prepare: false })
  await sql`CREATE SCHEMA IF NOT EXISTS herbe_migrations`
  await sql`CREATE TABLE IF NOT EXISTS herbe_migrations.applied (
    id SERIAL PRIMARY KEY,
    filename TEXT NOT NULL UNIQUE,
    hash TEXT NOT NULL,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`

  const dir = path.resolve('./scripts/migrations')
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()

  for (const filename of files) {
    const content = fs.readFileSync(path.join(dir, filename), 'utf8')
    const hash = crypto.createHash('sha256').update(content).digest('hex')

    const [existing] = await sql`SELECT hash FROM herbe_migrations.applied WHERE filename = ${filename}`
    if (existing) continue

    try {
      await sql.unsafe(content)
    } catch (err) {
      if (!TOLERATED.has(err.code)) throw err
      console.warn(`[migrate] tolerated ${err.code} in ${filename}: ${err.message}`)
    }

    await sql`INSERT INTO herbe_migrations.applied (filename, hash) VALUES (${filename}, ${hash})`
    console.log(`[migrate] applied ${filename}`)
  }

  await sql.end()
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await runMigrations()
}
