import { describe, expect, it } from 'vitest'
import { getAdapter, registerAdapter } from './registry'
import type { ErpAdapter } from './types'

describe('erp adapter registry', () => {
  it('returns the adapter a factory was registered for', () => {
    const fakeAdapter = { capabilities: () => ({ supportsIncrementalSync: true }) } as unknown as ErpAdapter
    registerAdapter('fake_erp', () => fakeAdapter)

    expect(getAdapter('fake_erp', {})).toBe(fakeAdapter)
  })

  it('throws a clear error for an unregistered adapter type', () => {
    expect(() => getAdapter('nonexistent', {})).toThrow('No ERP adapter registered for type "nonexistent"')
  })
})
