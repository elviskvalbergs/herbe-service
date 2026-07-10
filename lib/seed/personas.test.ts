// lib/seed/personas.test.ts
import { describe, expect, it } from 'vitest'
import { PERSONAS } from './personas'

describe('fixed test personas', () => {
  it('has a stable UUID and email per role', () => {
    expect(PERSONAS.tech.email).toBe('tech.anna@herbe-service.test')
    expect(PERSONAS.lead.email).toBe('lead.bruno@herbe-service.test')
    expect(PERSONAS.dispatch.email).toBe('dispatch.dace@herbe-service.test')
    expect(PERSONAS.office.email).toBe('office.eva@herbe-service.test')
    expect(PERSONAS.admin.email).toBe('admin.karlis@herbe-service.test')
  })

  it('every persona id is a stable, hardcoded UUID (not generated at runtime)', () => {
    const ids = Object.values(PERSONAS).map((p) => p.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const id of ids) {
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
    }
  })
})
