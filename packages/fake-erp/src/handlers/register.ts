import type { Context } from 'hono'
import cuvcFixture from '../fixtures/cuvc.json' with { type: 'json' }
import deladdrvcFixture from '../fixtures/deladdrvc.json' with { type: 'json' }
import svoservcFixture from '../fixtures/svoservc.json' with { type: 'json' }
import svovcFixture from '../fixtures/svovc.json' with { type: 'json' }
import wsvcFixture from '../fixtures/wsvc.json' with { type: 'json' }
import { createRecord, mergedRows, updateRecord, type FakeErpMode, type FakeErpRecord, type RecordStore } from '../store'

// SVOSerVc is a no-delta register (verified live): updates_after -> 404, same
// as SVOVc/WSVc. Its identity key is SerialNr, not SerNr. DelAddrVc is
// delta-capable (verified live, same as CUVc) — deliberately absent here.
const NO_UPDATES_AFTER = new Set(['SVOVc', 'WSVc', 'SVOSerVc'])
const FIXTURES: Record<string, Array<{ ServerSequence: number }>> = {
  CUVc: cuvcFixture,
  DelAddrVc: deladdrvcFixture,
  SVOSerVc: svoservcFixture,
  SVOVc: svovcFixture,
  WSVc: wsvcFixture,
}

const FILTER_PREFIX = 'filter.'

// Exact-match filter.<Field> query support (real-ERP REST convention,
// portal-proven): every filter.<Field>=<value> param must match via
// String(row[field]) === value; multiple params compose with AND.
function applyFilters(rows: FakeErpRecord[], query: Record<string, string>): FakeErpRecord[] {
  const filters = Object.entries(query).filter(([key]) => key.startsWith(FILTER_PREFIX))
  if (filters.length === 0) return rows

  return rows.filter((row) => filters.every(([key, value]) => String(row[key.slice(FILTER_PREFIX.length)]) === value))
}

export function handleRegisterGet(
  c: Context<Record<string, never>, '/api/:company/:register'>,
  store: RecordStore,
) {
  const register = c.req.param('register')
  const updatesAfter = c.req.query('updates_after')
  const deletesAfter = c.req.query('deletes_after')

  if (deletesAfter !== undefined) {
    return c.body(null, 204)
  }

  if (updatesAfter !== undefined && NO_UPDATES_AFTER.has(register)) {
    return c.json({ error: 'not supported for this register' }, 404)
  }

  const fixtureRows = FIXTURES[register] ?? []
  const rows = applyFilters(mergedRows(store, register, fixtureRows), c.req.query())
  const sequence = rows.length ? Math.max(...rows.map((r) => Number(r.ServerSequence) || 0)) : 0

  // Match the real Standard Books envelope (verified live): rows are nested
  // under data.<Register>, not a flat data array.
  return c.json({ data: { [register]: rows }, '@sequence': sequence })
}

export async function handleRegisterPost(
  c: Context<Record<string, never>, '/api/:company/:register'>,
  store: RecordStore,
  serverMode?: FakeErpMode,
) {
  const mode = (c.req.header('x-fake-erp-mode') as FakeErpMode | undefined) ?? serverMode

  if (mode === 'http-500') {
    return c.json({ error: 'internal server error' }, 500)
  }

  const register = c.req.param('register')
  const payload = await c.req.json<FakeErpRecord>()
  const hasSerNr = payload.SerNr !== undefined && payload.SerNr !== null && payload.SerNr !== ''

  if (mode === 'noop-create' && !hasSerNr) {
    // The "number-series trap" (verified live, docs/04 + docs/19): HTTP 200,
    // payload echoed verbatim, no SerNr assigned, nothing persisted.
    return c.json(payload, 200)
  }

  const fixtureRows = FIXTURES[register] ?? []

  if (hasSerNr) {
    const { record } = updateRecord(store, register, fixtureRows, payload)
    return c.json(record, 200)
  }

  const record = createRecord(store, register, fixtureRows, payload)
  return c.json(record, 200)
}
