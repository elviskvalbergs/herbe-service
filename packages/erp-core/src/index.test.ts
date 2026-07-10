import { describe, expect, it } from 'vitest'
import * as erpCore from './index'

describe('erp-core barrel export', () => {
  it('re-exports the adapter registry functions', () => {
    expect(typeof erpCore.registerAdapter).toBe('function')
    expect(typeof erpCore.getAdapter).toBe('function')
  })

  it('re-exports the typed error hierarchy', () => {
    expect(erpCore.ErpAdapterError).toBeInstanceOf(Function)
    expect(erpCore.ErpTransientError).toBeInstanceOf(Function)
    expect(erpCore.ErpPermanentError).toBeInstanceOf(Function)
    expect(erpCore.ErpScheduledMaintenanceError).toBeInstanceOf(Function)
    expect(new erpCore.ErpTransientError('x')).toBeInstanceOf(erpCore.ErpAdapterError)
  })
})
