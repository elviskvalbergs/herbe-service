import { describe, expect, it } from 'vitest'
import { pushServiceOrderCreate } from './push-service-order'
import { ErpTransientError } from '@herbe/erp-core'

describe('pushServiceOrderCreate', () => {
  it('returns the erpRef when the ERP echoes back a real assigned SerNr', async () => {
    const fakeAdapter = {
      pushCreate: async () => ({ erpRef: 'SVO-000123' }),
    }

    const result = await pushServiceOrderCreate(fakeAdapter as never, {
      custCode: 'CUST001',
      transDate: '2026-07-08',
      rows: [{ artCode: 'PART-1', quant: 1 }],
    })

    expect(result.erpRef).toBe('SVO-000123')
  })

  it('treats an empty erpRef as a transient failure — "200 and no error" is not proof of a write', async () => {
    const fakeAdapter = {
      pushCreate: async () => ({ erpRef: '' }), // the demo-probe-confirmed silent-no-op case
    }

    await expect(
      pushServiceOrderCreate(fakeAdapter as never, {
        custCode: 'CUST001',
        transDate: '2026-07-08',
        rows: [{ artCode: 'PART-1', quant: 1 }],
      }),
    ).rejects.toBeInstanceOf(ErpTransientError)
  })
})
