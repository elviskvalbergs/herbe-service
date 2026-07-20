// app/(field)/inbox/page.test.tsx
//
// Same convention as app/(field)/more/page.test.tsx (Task 7): DB-backed,
// auth mocked at the module seam, next/navigation's redirect mocked to throw
// so the redirect() call is observable. Item-shape/status-filtering
// correctness itself is covered exhaustively in
// lib/inbox/get-inbox-items.test.ts — this file only proves the page wires
// the signed-in session's tenantId into that loader and passes the result
// through to <ConflictInbox> untouched.
//
// components/conflict-inbox.tsx is referenced here only as an element
// *type* (the page builds `<ConflictInbox items={items} />` but never
// invokes it), so its useState()/useRouter() hooks never run — but
// importing the page still transitively imports the real 'next/navigation'
// barrel (via conflict-inbox.tsx's useRouter import), which crashes under
// this project's forced 'react-server' resolve condition (see
// components/locale-switcher.test.ts) — stubbed here purely to make the
// module graph loadable, same as app/(field)/more/page.test.tsx's stub.
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import * as schema from '@/drizzle/schema'
import { runMigrations } from '@/scripts/migrate'
import { createTestDatabase, type TestDatabase } from '@/lib/test-support/db'
import { ConflictInbox } from '@/components/conflict-inbox'

const authMock = vi.fn()
vi.mock('@/lib/auth', () => ({ auth: () => authMock() }))

const redirectMock = vi.fn((url: string) => {
  throw new Error(`REDIRECT:${url}`)
})
vi.mock('next/navigation', () => ({ redirect: (url: string) => redirectMock(url) }))

let testDb: TestDatabase
let sql: ReturnType<typeof postgres>
let db: ReturnType<typeof drizzle<typeof schema>>

beforeAll(async () => {
  testDb = await createTestDatabase()
  await runMigrations(testDb.url)
  process.env.DATABASE_URL = testDb.url

  sql = postgres(testDb.url)
  db = drizzle(sql, { schema })
}, 60_000)

afterAll(async () => {
  await sql?.end({ timeout: 5 })
  await testDb?.cleanup()
})

async function makeUser(tenantSlug: string, email: string) {
  const [tenant] = await db.insert(schema.tenants).values({ slug: tenantSlug, name: tenantSlug }).returning()
  const [user] = await db.insert(schema.users).values({ tenantId: tenant.id, email, role: 'technician' }).returning()
  return user
}

function sessionFor(user: { id: string; tenantId: string; role: string; sessionVersion: number }) {
  return {
    user: { id: user.id, tenantId: user.tenantId, role: user.role, sessionVersion: user.sessionVersion },
    expires: '2099-01-01T00:00:00.000Z',
  }
}

async function insertOutboxOp(tenantId: string, status: 'pending' | 'applied' | 'failed') {
  const [row] = await db
    .insert(schema.outboxOps)
    .values({ id: crypto.randomUUID(), tenantId, entity: 'serviceOrder', op: 'create', payloadJson: {}, status })
    .returning()
  return row
}

describe('InboxPage', () => {
  beforeEach(() => {
    authMock.mockReset()
    redirectMock.mockClear()
  })

  it('redirects to /login when there is no session', async () => {
    authMock.mockResolvedValue(null)
    const { default: Page } = await import('./page')

    await expect(Page()).rejects.toThrow('REDIRECT:/login')
    expect(redirectMock).toHaveBeenCalledWith('/login')
  })

  it('renders ConflictInbox fed by the signed-in tenant\'s real failed outbox_ops', async () => {
    const user = await makeUser('inbox-page-real', 'inbox-page@herbe-service.test')
    const failed = await insertOutboxOp(user.tenantId, 'failed')
    await insertOutboxOp(user.tenantId, 'pending') // must not appear
    await insertOutboxOp(user.tenantId, 'applied') // must not appear
    authMock.mockResolvedValue(sessionFor(user))

    const { default: Page } = await import('./page')
    const element = (await Page()) as {
      type: string
      props: { children: [{ props: { children: string } }, { type: unknown; props: { items: unknown[] } }] }
    }

    expect(element.type).toBe('main')
    const [heading, inbox] = element.props.children
    expect(heading.props.children).toBe('Inbox')
    expect(inbox.type).toBe(ConflictInbox)
    expect(inbox.props.items).toEqual([
      {
        id: failed.id,
        entity: failed.entity,
        op: failed.op,
        errorMessage: failed.errorMessage,
        createdAt: failed.createdAt,
      },
    ])
  })

  it('renders ConflictInbox with an empty items array when there are no failed ops', async () => {
    const user = await makeUser('inbox-page-empty', 'inbox-page-empty@herbe-service.test')
    authMock.mockResolvedValue(sessionFor(user))

    const { default: Page } = await import('./page')
    const element = (await Page()) as { props: { children: [unknown, { props: { items: unknown[] } }] } }

    const [, inbox] = element.props.children
    expect(inbox.props.items).toEqual([])
  })
})
