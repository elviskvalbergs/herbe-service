import postgres from 'postgres'
import { randomUUID } from 'node:crypto'

export interface TestDatabase {
  url: string
  cleanup: () => Promise<void>
}

/**
 * Creates a uniquely-named, empty database on the server pointed at by
 * TEST_DATABASE_URL and returns its connection URL + a cleanup that drops it.
 * Caller runs migrations against `url` and must close its own connections
 * before calling cleanup(). No Docker: the server is a real local/CI Postgres.
 */
export async function createTestDatabase(): Promise<TestDatabase> {
  const base = process.env.TEST_DATABASE_URL
  if (!base) {
    throw new Error(
      'TEST_DATABASE_URL is not set. Start the local test Postgres and set it in .env.test, ' +
        'e.g. postgres://postgres@localhost:55432/postgres (see docs/testing/README.md).',
    )
  }
  const name = `herbe_test_${randomUUID().replace(/-/g, '')}`
  const admin = postgres(base, { max: 1 })
  try {
    await admin.unsafe(`CREATE DATABASE "${name}"`)
  } finally {
    await admin.end({ timeout: 5 })
  }

  const url = base.replace(/\/[^/]+(\?.*)?$/, `/${name}$1`)
  return {
    url,
    cleanup: async () => {
      const a = postgres(base, { max: 1 })
      try {
        await a.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`)
      } finally {
        await a.end({ timeout: 5 })
      }
    },
  }
}
