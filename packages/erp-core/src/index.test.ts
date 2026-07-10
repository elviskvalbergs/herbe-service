import { describe, expect, it } from 'vitest'
import * as erpCore from './index'
import { getAdapter, registerAdapter } from './registry'

describe('erp-core barrel export', () => {
  it('re-exports the same adapter registry functions as registry.ts', () => {
    expect(erpCore.registerAdapter).toBe(registerAdapter)
    expect(erpCore.getAdapter).toBe(getAdapter)
  })

  it('re-exports the typed error hierarchy', () => {
    expect(erpCore.ErpAdapterError).toBeInstanceOf(Function)
    expect(erpCore.ErpTransientError).toBeInstanceOf(Function)
    expect(erpCore.ErpPermanentError).toBeInstanceOf(Function)
    expect(erpCore.ErpScheduledMaintenanceError).toBeInstanceOf(Function)
    expect(new erpCore.ErpTransientError('x')).toBeInstanceOf(erpCore.ErpAdapterError)
  })
})
