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

// Standard Books REST write convention (docs/09-REST-API-REFERENCE.md,
// confirmed live in WS4 Task 7): writes are form-urlencoded, never JSON —
// header fields as `set_field.<Field>=<value>`, row fields as
// `set_row_field.<rowIndex>.<Field>=<value>`. This reconstructs the flat
// {..., rows: [...]} shape the rest of this module (createRecord/
// updateRecord, the fixtures) already expects.
const SET_FIELD_PREFIX = 'set_field.'
const SET_ROW_FIELD_PATTERN = /^set_row_field\.(\d+)\.(.+)$/

function parseWriteBody(form: Record<string, string | File>): FakeErpRecord {
  const record: FakeErpRecord = {}
  const rows: Record<number, FakeErpRecord> = {}

  for (const [key, value] of Object.entries(form)) {
    if (typeof value !== 'string') continue

    const rowMatch = key.match(SET_ROW_FIELD_PATTERN)
    if (rowMatch) {
      const index = Number(rowMatch[1])
      const field = rowMatch[2]
      rows[index] ??= {}
      rows[index][field] = value
      continue
    }

    if (key.startsWith(SET_FIELD_PREFIX)) {
      record[key.slice(SET_FIELD_PREFIX.length)] = value
    }
  }

  const rowIndices = Object.keys(rows)
    .map(Number)
    .sort((a, b) => a - b)
  if (rowIndices.length > 0) {
    record.rows = rowIndices.map((i) => rows[i])
  }

  return record
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
  const payload = parseWriteBody(await c.req.parseBody())

  if (mode === 'noop-create') {
    // The "number-series trap" (verified live, docs/04 + docs/19): HTTP 200,
    // payload echoed verbatim, no SerNr assigned, nothing persisted.
    return c.json(payload, 200)
  }

  const fixtureRows = FIXTURES[register] ?? []
  const record = createRecord(store, register, fixtureRows, payload)
  // Match the real Standard Books envelope for a successful create
  // (verified live, WS4 Task 7): the created record comes back nested under
  // data.<Register>, same shape as a GET — never a flat top-level object.
  return c.json({ data: { [register]: [record] } }, 200)
}

// PATCH /api/:company/:register/:sernr — update-by-key (docs/09-REST-API-
// REFERENCE.md "PATCH - Update Records"): the record id is the URL segment,
// never part of the body. An unknown SerNr is the real ERP's silent no-op —
// echo the payload back (with the requested SerNr) and store nothing.
export async function handleRegisterPatch(
  c: Context<Record<string, never>, '/api/:company/:register/:sernr'>,
  store: RecordStore,
  serverMode?: FakeErpMode,
) {
  const mode = (c.req.header('x-fake-erp-mode') as FakeErpMode | undefined) ?? serverMode

  if (mode === 'http-500') {
    return c.json({ error: 'internal server error' }, 500)
  }

  const register = c.req.param('register')
  const sernr = Number(c.req.param('sernr'))
  const payload = { ...parseWriteBody(await c.req.parseBody()), SerNr: sernr }

  const fixtureRows = FIXTURES[register] ?? []
  const { record } = updateRecord(store, register, fixtureRows, payload)
  // Same envelope as a successful create (see handleRegisterPost) — applied
  // uniformly here too, matched or not, so callers always extract via the
  // same data.<Register> shape.
  return c.json({ data: { [register]: [record] } }, 200)
}
