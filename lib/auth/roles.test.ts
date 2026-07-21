import { describe, expect, it } from 'vitest'
import { hasCapability, ROLE_CAPABILITIES, type Capability, type Role } from './roles'

describe('hasCapability', () => {
  const cases: Array<[Role, Capability, boolean]> = [
    ['technician', 'worksheet:execute_own', true],
    ['technician', 'worksheet:approve', false],
    ['technician', 'users:manage', false],
    ['team_lead', 'crew:edit_composition', true],
    ['team_lead', 'worksheet:approve', false],
    ['team_lead', 'worksheet:execute_own', true],
    ['dispatcher', 'worksheet:approve', true],
    ['dispatcher', 'pricing:view_margins', true],
    ['dispatcher', 'tenant:manage_settings', false],
    ['back_office', 'customer:edit', true],
    ['back_office', 'worksheet:approve', false],
    ['admin', 'tenant:manage_settings', true],
    ['admin', 'users:manage', true],
    // FIX-14: admin is additive — it now inherits operational capabilities too.
    ['admin', 'worksheet:approve', true],
    ['admin', 'worksheet:execute_own', true],
    ['admin', 'customer:edit', true],
  ]

  it.each(cases)('role=%s capability=%s -> %s', (role, capability, expected) => {
    expect(hasCapability(role, capability)).toBe(expected)
  })

  // FIX-12: users.role is a bare text column cast to Role at call sites
  // (`session.user.role as Role`) — a value outside the union must return
  // false, not throw ("Cannot read properties of undefined (reading
  // 'includes')") and crash the page/route.
  it('returns false (never throws) for an unknown role string', () => {
    expect(hasCapability('nonexistent' as Role, 'history:view')).toBe(false)
    expect(hasCapability('' as Role, 'worksheet:approve')).toBe(false)
    expect(hasCapability(undefined as unknown as Role, 'users:manage')).toBe(false)
  })

  it('every role has at least one capability', () => {
    for (const role of Object.keys(ROLE_CAPABILITIES) as Role[]) {
      expect(ROLE_CAPABILITIES[role].length).toBeGreaterThan(0)
    }
  })

  // FIX-14: admin = additive capability, not a separate surface. It must hold
  // every capability granted to any other role (plus its admin-only ones).
  it('admin is a superset of every other role capability', () => {
    const everyOtherCapability = new Set(
      (Object.keys(ROLE_CAPABILITIES) as Role[])
        .filter((role) => role !== 'admin')
        .flatMap((role) => ROLE_CAPABILITIES[role]),
    )
    for (const capability of everyOtherCapability) {
      expect(hasCapability('admin', capability)).toBe(true)
    }
  })
})
