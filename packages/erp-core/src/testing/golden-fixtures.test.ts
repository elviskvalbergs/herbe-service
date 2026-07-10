import { describe, expect, it } from 'vitest'
import { loadGoldenFixture } from './golden-fixtures'

interface CuvcRow {
  Code: string
  Name: string
  UUID: string
  ServerSequence: number
}

describe('loadGoldenFixture', () => {
  it('loads a fixture by register name from packages/erp-core/fixtures', () => {
    const rows = loadGoldenFixture<CuvcRow[]>('CUVc')
    expect(rows).toEqual([
      { Code: 'CUST001', Name: 'Test Client OÜ', UUID: 'a1b2c3d4-0001', ServerSequence: 1001 },
      { Code: 'CUST002', Name: 'Another Client SIA', UUID: 'a1b2c3d4-0002', ServerSequence: 1002 },
    ])
  })

  it('is case-insensitive on the register name', () => {
    const upper = loadGoldenFixture<CuvcRow[]>('CUVC')
    const lower = loadGoldenFixture<CuvcRow[]>('cuvc')
    expect(upper).toEqual(lower)
  })

  it('throws when no fixture file exists for the register', () => {
    expect(() => loadGoldenFixture('NoSuchRegister')).toThrow()
  })
})
