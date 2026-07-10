import { describe, expect, it } from 'vitest'
import { ErpAdapterError, ErpPermanentError, ErpScheduledMaintenanceError, ErpTransientError } from './errors'

describe('erp error hierarchy', () => {
  it('ErpTransientError carries message, name, and optional cause', () => {
    const cause = new Error('network blip')
    const err = new ErpTransientError('timed out', cause)

    expect(err).toBeInstanceOf(ErpAdapterError)
    expect(err).toBeInstanceOf(Error)
    expect(err.name).toBe('ErpTransientError')
    expect(err.message).toBe('timed out')
    expect(err.cause).toBe(cause)
  })

  it('ErpPermanentError carries message, name, and defaults cause to undefined', () => {
    const err = new ErpPermanentError('rejected by ERP')

    expect(err).toBeInstanceOf(ErpAdapterError)
    expect(err.name).toBe('ErpPermanentError')
    expect(err.message).toBe('rejected by ERP')
    expect(err.cause).toBeUndefined()
  })

  it('ErpScheduledMaintenanceError defaults its message', () => {
    const err = new ErpScheduledMaintenanceError()

    expect(err).toBeInstanceOf(ErpAdapterError)
    expect(err.name).toBe('ErpScheduledMaintenanceError')
    expect(err.message).toBe('ERP is in a scheduled maintenance window')
  })

  it('ErpScheduledMaintenanceError accepts a custom message', () => {
    const err = new ErpScheduledMaintenanceError('maintenance until 02:00 UTC')

    expect(err.message).toBe('maintenance until 02:00 UTC')
  })
})
