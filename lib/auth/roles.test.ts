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
    ['admin', 'worksheet:approve', false],
  ]

  it.each(cases)('role=%s capability=%s -> %s', (role, capability, expected) => {
    expect(hasCapability(role, capability)).toBe(expected)
  })

  it('every role has at least one capability', () => {
    for (const role of Object.keys(ROLE_CAPABILITIES) as Role[]) {
      expect(ROLE_CAPABILITIES[role].length).toBeGreaterThan(0)
    }
  })
})
