// lib/provisioning/types.ts
//
// Supabase Management API shapes used by the provisioning client (Task 18).
// Adapted from herbe-portal's lib/provisioning/neon-client.ts NeonProject
// shape, swapped for the fields the Supabase Management API returns/expects.

export interface SupabaseProject {
  id: string
  name: string
  region: string
}

export interface CreateProjectOptions {
  name: string
  organizationId: string
  region: string
  dbPass: string
}
