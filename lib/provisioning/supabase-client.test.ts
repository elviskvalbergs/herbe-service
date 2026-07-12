// lib/provisioning/supabase-client.test.ts
//
// Unit tests against a mocked global.fetch — no real Supabase Management API
// calls (Task 18 brief; the client is constructor-injected/testable the same
// way herbe-portal's lib/provisioning/neon-client.ts is).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createSupabaseProvisioningClient } from './supabase-client'

describe('Supabase provisioning client', () => {
  const originalFetch = global.fetch

  beforeEach(() => {
    global.fetch = vi.fn()
  })

  afterEach(() => {
    global.fetch = originalFetch
  })

  it('findProjectByName returns null when no project matches', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [{ id: 'p1', name: 'other-project', region: 'eu-central-1' }],
    }) as never

    const client = createSupabaseProvisioningClient({ accessToken: 'token' })
    const result = await client.findProjectByName('customer-acme')

    expect(result).toBeNull()
    expect(global.fetch).toHaveBeenCalledWith(
      'https://api.supabase.com/v1/projects',
      expect.objectContaining({ method: 'GET' }),
    )
  })

  it('findProjectByName returns the matching project when found', async () => {
    const match = { id: 'p1', name: 'customer-acme', region: 'eu-central-1' }
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [{ id: 'p0', name: 'other-project', region: 'eu-central-1' }, match],
    }) as never

    const client = createSupabaseProvisioningClient({ accessToken: 'token' })
    const result = await client.findProjectByName('customer-acme')

    expect(result).toEqual(match)
  })

  it('listProjects returns all projects from the API', async () => {
    const projects = [
      { id: 'p1', name: 'customer-acme', region: 'eu-central-1' },
      { id: 'p2', name: 'customer-beta', region: 'eu-central-1' },
    ]
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => projects,
    }) as never

    const client = createSupabaseProvisioningClient({ accessToken: 'token' })
    const result = await client.listProjects()

    expect(result).toEqual(projects)
    expect(global.fetch).toHaveBeenCalledWith(
      'https://api.supabase.com/v1/projects',
      expect.objectContaining({ method: 'GET' }),
    )
  })

  it('createProject POSTs to /v1/projects and returns the created project', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ id: 'p2', name: 'customer-acme', region: 'eu-central-1' }),
    }) as never

    const client = createSupabaseProvisioningClient({ accessToken: 'token' })
    const result = await client.createProject({
      name: 'customer-acme',
      organizationId: 'org-1',
      region: 'eu-central-1',
      dbPass: 'x'.repeat(20),
    })

    expect(result.id).toBe('p2')
    expect(global.fetch).toHaveBeenCalledWith(
      'https://api.supabase.com/v1/projects',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer token' }),
        body: JSON.stringify({
          name: 'customer-acme',
          organization_id: 'org-1',
          region: 'eu-central-1',
          db_pass: 'x'.repeat(20),
        }),
      }),
    )
  })

  it('throws when the Supabase API responds with a non-OK status', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
    }) as never

    const client = createSupabaseProvisioningClient({ accessToken: 'bad-token' })

    await expect(client.findProjectByName('customer-acme')).rejects.toThrow(/401/)
  })
})
