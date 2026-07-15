import type { Context } from 'hono'
import cuvcFixture from '../fixtures/cuvc.json' with { type: 'json' }

const NO_UPDATES_AFTER = new Set(['SVOVc', 'WSVc'])
const FIXTURES: Record<string, Array<{ ServerSequence: number }>> = {
  CUVc: cuvcFixture,
}

export function handleRegisterGet(c: Context<Record<string, never>, '/api/:company/:register'>) {
  const register = c.req.param('register')
  const updatesAfter = c.req.query('updates_after')
  const deletesAfter = c.req.query('deletes_after')

  if (deletesAfter !== undefined) {
    return c.body(null, 204)
  }

  if (updatesAfter !== undefined && NO_UPDATES_AFTER.has(register)) {
    return c.json({ error: 'not supported for this register' }, 404)
  }

  const rows = FIXTURES[register] ?? []
  const sequence = rows.length ? Math.max(...rows.map((r) => r.ServerSequence)) : 0

  // Match the real Standard Books envelope (verified live): rows are nested
  // under data.<Register>, not a flat data array.
  return c.json({ data: { [register]: rows }, '@sequence': sequence })
}
