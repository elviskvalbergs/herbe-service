// lib/seed/personas.ts
import type { Role } from '@/lib/auth/roles'

export interface Persona {
  id: string
  email: string
  role: Role
}

export const PERSONAS = {
  tech: { id: '00000000-0000-0000-0000-000000000001', email: 'tech.anna@herbe-service.test', role: 'technician' },
  lead: { id: '00000000-0000-0000-0000-000000000002', email: 'lead.bruno@herbe-service.test', role: 'team_lead' },
  dispatch: { id: '00000000-0000-0000-0000-000000000003', email: 'dispatch.dace@herbe-service.test', role: 'dispatcher' },
  office: { id: '00000000-0000-0000-0000-000000000004', email: 'office.eva@herbe-service.test', role: 'back_office' },
  admin: { id: '00000000-0000-0000-0000-000000000005', email: 'admin.karlis@herbe-service.test', role: 'admin' },
  // second-tenant + no-company-access personas for negative access tests:
  otherTenantAdmin: { id: '00000000-0000-0000-0000-000000000006', email: 'admin.otherTenant@herbe-service.test', role: 'admin' },
  noCompanyAccess: { id: '00000000-0000-0000-0000-000000000007', email: 'noaccess@herbe-service.test', role: 'back_office' },
} as const satisfies Record<string, Persona>
