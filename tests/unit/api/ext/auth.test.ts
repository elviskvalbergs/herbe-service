// tests/unit/api/ext/auth.test.ts
//
// Task 5 (docs/superpowers/plans/2026-07-14-service-phase1-ext-read-api.md):
// unit tests for lib/api/ext/auth.ts. The store (findExtTokenByHash /
// touchExtToken) is mocked — this exercises only the header parsing, hash
// lookup, revocation check, and narrow-never-widen scope resolution, no DB.
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { findExtTokenByHash, touchExtToken } = vi.hoisted(() => ({
  findExtTokenByHash: vi.fn(),
  touchExtToken: vi.fn(),
}))

vi.mock('@/lib/api/ext/tokens-store', () => ({
  findExtTokenByHash,
  touchExtToken,
}))

import { verifyExtRequest } from '@/lib/api/ext/auth'

const db = {} as never

function reqWithAuth(header?: string): Request {
  return new Request('http://x', header ? { headers: { Authorization: header } } : {})
}

describe('verifyExtRequest', () => {
  beforeEach(() => {
    findExtTokenByHash.mockReset()
    touchExtToken.mockReset()
    touchExtToken.mockResolvedValue(undefined)
  })

  it('rejects a request with no Authorization header', async () => {
    const result = await verifyExtRequest(db, reqWithAuth())
    expect(result).toEqual({ ok: false, status: 401, code: 'no_token' })
    expect(findExtTokenByHash).not.toHaveBeenCalled()
  })

  it('rejects a non-Bearer Authorization header', async () => {
    const result = await verifyExtRequest(db, reqWithAuth('Basic abc123'))
    expect(result).toEqual({ ok: false, status: 401, code: 'no_token' })
  })

  it('rejects an unknown token hash', async () => {
    findExtTokenByHash.mockResolvedValue(null)
    const result = await verifyExtRequest(db, reqWithAuth('Bearer some-raw-token'))
    expect(result).toEqual({ ok: false, status: 401, code: 'invalid_token' })
  })

  it('rejects a revoked token', async () => {
    findExtTokenByHash.mockResolvedValue({
      id: 'tok-1',
      tenantId: 'tenant-1',
      erpCompanyId: 'company-1',
      customerCodes: [],
      revokedAt: new Date(),
    })
    const result = await verifyExtRequest(db, reqWithAuth('Bearer some-raw-token'))
    expect(result).toEqual({ ok: false, status: 401, code: 'revoked' })
  })

  it('accepts a valid token and touches it without blocking the response', async () => {
    findExtTokenByHash.mockResolvedValue({
      id: 'tok-1',
      tenantId: 'tenant-1',
      erpCompanyId: 'company-1',
      customerCodes: ['CUST-A', 'CUST-B'],
      revokedAt: null,
    })

    const result = await verifyExtRequest(db, reqWithAuth('Bearer some-raw-token'))

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected ok result')
    expect(result.tenantId).toBe('tenant-1')
    expect(result.erpCompanyId).toBe('company-1')
    expect(result.tokenId).toBe('tok-1')
    expect(result.tokenCustomerCodes).toEqual(['CUST-A', 'CUST-B'])
    expect(typeof result.resolveScopeCodes).toBe('function')
    // touchExtToken is fire-and-forget: it's called, but verifyExtRequest
    // does not need to await its resolution for the result to be available.
    expect(touchExtToken).toHaveBeenCalledWith(db, 'tok-1')
  })

  it('does not reject when touchExtToken fails', async () => {
    findExtTokenByHash.mockResolvedValue({
      id: 'tok-1',
      tenantId: 'tenant-1',
      erpCompanyId: 'company-1',
      customerCodes: [],
      revokedAt: null,
    })
    touchExtToken.mockRejectedValue(new Error('db unavailable'))

    const result = await verifyExtRequest(db, reqWithAuth('Bearer some-raw-token'))
    expect(result.ok).toBe(true)
  })

  describe('resolveScopeCodes', () => {
    it('empty token scope + requested codes -> returns requested as-is', async () => {
      findExtTokenByHash.mockResolvedValue({
        id: 'tok-1',
        tenantId: 't1',
        erpCompanyId: 'c1',
        customerCodes: [],
        revokedAt: null,
      })
      const result = await verifyExtRequest(db, reqWithAuth('Bearer t'))
      if (!result.ok) throw new Error('expected ok result')
      expect(result.resolveScopeCodes(['A'])).toEqual(['A'])
    })

    it('empty token scope + no requested -> returns []', async () => {
      findExtTokenByHash.mockResolvedValue({
        id: 'tok-1',
        tenantId: 't1',
        erpCompanyId: 'c1',
        customerCodes: [],
        revokedAt: null,
      })
      const result = await verifyExtRequest(db, reqWithAuth('Bearer t'))
      if (!result.ok) throw new Error('expected ok result')
      expect(result.resolveScopeCodes()).toEqual([])
    })

    it('restricted token scope + requested codes -> intersects (widen dropped)', async () => {
      findExtTokenByHash.mockResolvedValue({
        id: 'tok-1',
        tenantId: 't1',
        erpCompanyId: 'c1',
        customerCodes: ['A', 'B'],
        revokedAt: null,
      })
      const result = await verifyExtRequest(db, reqWithAuth('Bearer t'))
      if (!result.ok) throw new Error('expected ok result')
      expect(result.resolveScopeCodes(['A', 'C'])).toEqual(['A'])
    })

    it('restricted token scope + no requested -> returns the token full scope', async () => {
      findExtTokenByHash.mockResolvedValue({
        id: 'tok-1',
        tenantId: 't1',
        erpCompanyId: 'c1',
        customerCodes: ['A', 'B'],
        revokedAt: null,
      })
      const result = await verifyExtRequest(db, reqWithAuth('Bearer t'))
      if (!result.ok) throw new Error('expected ok result')
      expect(result.resolveScopeCodes()).toEqual(['A', 'B'])
    })
  })
})
