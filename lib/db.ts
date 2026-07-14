// lib/db.ts
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import * as schema from '@/drizzle/schema'

const connectionString = process.env.DATABASE_URL
if (!connectionString) {
  throw new Error('DATABASE_URL must be set')
}

export const sql = postgres(connectionString, { prepare: false })
export const db = drizzle(sql, { schema })
