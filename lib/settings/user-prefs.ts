// lib/settings/user-prefs.ts
//
// WS1 Task 3: user-level settings model — locale + display-scheme
// preference, stored directly on `users` (0020_user_settings.sql), same
// convention as password_hash/mfa_* on that table. Validated here rather
// than coerced: an invalid locale or scheme is a caller bug, not a value to
// silently fall back from.
import { eq } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import * as schema from '@/drizzle/schema'
import { isLocale, type Locale } from '@/lib/i18n/config'

type Db = PostgresJsDatabase<typeof schema>

export const displaySchemes = ['standard', 'sunlight', 'dark'] as const
export type DisplayScheme = (typeof displaySchemes)[number]

export function isDisplayScheme(value: string): value is DisplayScheme {
  return (displaySchemes as readonly string[]).includes(value)
}

export interface UserPrefs {
  locale: Locale
  displayScheme: DisplayScheme
}

export interface SetUserPrefsInput {
  locale?: string
  displayScheme?: string
}

export async function getUserPrefs(db: Db, userId: string): Promise<UserPrefs> {
  const [row] = await db
    .select({ locale: schema.users.locale, displayScheme: schema.users.displayScheme })
    .from(schema.users)
    .where(eq(schema.users.id, userId))

  if (!row) throw new Error(`user not found: ${userId}`)
  return row as UserPrefs
}

export async function setUserPrefs(db: Db, userId: string, input: SetUserPrefsInput): Promise<UserPrefs> {
  const set: Partial<{ locale: Locale; displayScheme: DisplayScheme }> = {}

  if (input.locale !== undefined) {
    if (!isLocale(input.locale)) throw new Error(`invalid locale: ${input.locale}`)
    set.locale = input.locale
  }
  if (input.displayScheme !== undefined) {
    if (!isDisplayScheme(input.displayScheme)) throw new Error(`invalid display scheme: ${input.displayScheme}`)
    set.displayScheme = input.displayScheme
  }

  if (Object.keys(set).length === 0) return getUserPrefs(db, userId)

  const [row] = await db
    .update(schema.users)
    .set(set)
    .where(eq(schema.users.id, userId))
    .returning({ locale: schema.users.locale, displayScheme: schema.users.displayScheme })

  if (!row) throw new Error(`user not found: ${userId}`)
  return row as UserPrefs
}
