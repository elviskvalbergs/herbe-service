// lib/provisioning/supabase-client.ts
//
// Supabase Management API client (Task 18). Adapted from herbe-portal's
// lib/provisioning/neon-client.ts: same constructor-injected/testable shape
// (findProjectByName/createProject) so the portal's executor.ts orchestration
// ports over with a client swap. Only the two calls the Phase 0 CLI needs are
// implemented here — no fleet-ops orchestration (that's Phase 1).
import type { CreateProjectOptions, SupabaseProject } from './types'

const API_BASE = 'https://api.supabase.com/v1'

export function createSupabaseProvisioningClient(opts: { accessToken: string }) {
  async function request<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(`${API_BASE}${path}`, {
      ...init,
      headers: {
        ...init?.headers,
        Authorization: `Bearer ${opts.accessToken}`,
        'Content-Type': 'application/json',
      },
    })
    if (!res.ok) {
      throw new Error(`Supabase API ${init?.method ?? 'GET'} ${path} failed: ${res.status}`)
    }
    return res.json() as Promise<T>
  }

  return {
    async listProjects(): Promise<SupabaseProject[]> {
      return request<SupabaseProject[]>('/projects', { method: 'GET' })
    },

    async findProjectByName(name: string): Promise<SupabaseProject | null> {
      const projects = await request<SupabaseProject[]>('/projects', { method: 'GET' })
      return projects.find((p) => p.name === name) ?? null
    },

    async createProject(config: CreateProjectOptions): Promise<SupabaseProject> {
      return request<SupabaseProject>('/projects', {
        method: 'POST',
        body: JSON.stringify({
          name: config.name,
          organization_id: config.organizationId,
          region: config.region,
          db_pass: config.dbPass,
        }),
      })
    },
  }
}
