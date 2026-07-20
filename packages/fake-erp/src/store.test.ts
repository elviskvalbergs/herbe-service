import { describe, expect, it } from 'vitest'
import { createRecord, createRecordStore, mergedRows, updateRecord } from './store'

const fixtureRows = [
  { SerNr: 100, CustCode: 'A', ServerSequence: 10 },
  { SerNr: 101, CustCode: 'B', ServerSequence: 11 },
]

describe('fake-ERP record store', () => {
  it('createRecord assigns SerNr = max(fixtures) + 1 on the first create', () => {
    const store = createRecordStore()
    const record = createRecord(store, 'SVOVc', fixtureRows, { CustCode: 'NEW' })

    expect(record.SerNr).toBe(102)
    expect(record.CustCode).toBe('NEW')
  })

  it('createRecord keeps incrementing from previously created records, not just fixtures', () => {
    const store = createRecordStore()
    createRecord(store, 'SVOVc', fixtureRows, { CustCode: 'FIRST' })
    const second = createRecord(store, 'SVOVc', fixtureRows, { CustCode: 'SECOND' })

    expect(second.SerNr).toBe(103)
  })

  it('createRecord scopes the SerNr counter per register', () => {
    const store = createRecordStore()
    createRecord(store, 'SVOVc', fixtureRows, { CustCode: 'A' }) // SerNr 102
    const wsRecord = createRecord(store, 'WSVc', [], { EMCode: 'TECH1' })

    expect(wsRecord.SerNr).toBe(1)
  })

  it('createRecord assigns a ServerSequence high-water mark alongside SerNr', () => {
    const store = createRecordStore()
    const record = createRecord(store, 'SVOVc', fixtureRows, { CustCode: 'NEW' })

    expect(record.ServerSequence).toBe(12)
  })

  it('updateRecord merges the payload into an existing fixture row by SerNr', () => {
    const store = createRecordStore()
    const { record, stored } = updateRecord(store, 'SVOVc', fixtureRows, { SerNr: 100, CustCode: 'UPDATED' })

    expect(stored).toBe(true)
    expect(record).toEqual({ SerNr: 100, CustCode: 'UPDATED', ServerSequence: 10 })
  })

  it('updateRecord merges into a previously created record', () => {
    const store = createRecordStore()
    const created = createRecord(store, 'SVOVc', fixtureRows, { CustCode: 'NEW' })
    const { record, stored } = updateRecord(store, 'SVOVc', fixtureRows, {
      SerNr: created.SerNr,
      CustCode: 'NEW2',
    })

    expect(stored).toBe(true)
    expect(record.CustCode).toBe('NEW2')
  })

  it('updateRecord with an unknown SerNr echoes the payload back and stores nothing', () => {
    const store = createRecordStore()
    const { record, stored } = updateRecord(store, 'SVOVc', fixtureRows, { SerNr: 9999, CustCode: 'GHOST' })

    expect(stored).toBe(false)
    expect(record).toEqual({ SerNr: 9999, CustCode: 'GHOST' })
    expect(mergedRows(store, 'SVOVc', fixtureRows)).toEqual(fixtureRows)
  })

  it('mergedRows returns fixtures unchanged when nothing has been written', () => {
    const store = createRecordStore()
    expect(mergedRows(store, 'SVOVc', fixtureRows)).toEqual(fixtureRows)
  })

  it('mergedRows replaces an updated fixture row and appends created rows', () => {
    const store = createRecordStore()
    updateRecord(store, 'SVOVc', fixtureRows, { SerNr: 100, CustCode: 'UPDATED' })
    const created = createRecord(store, 'SVOVc', fixtureRows, { CustCode: 'NEW' })

    const rows = mergedRows(store, 'SVOVc', fixtureRows)

    expect(rows).toHaveLength(3)
    expect(rows.find((r) => r.SerNr === 100)?.CustCode).toBe('UPDATED')
    expect(rows.find((r) => r.SerNr === 101)).toEqual(fixtureRows[1])
    expect(rows.find((r) => r.SerNr === created.SerNr)).toEqual(created)
  })
})
