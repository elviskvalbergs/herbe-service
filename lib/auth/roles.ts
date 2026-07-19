export type Role = 'technician' | 'team_lead' | 'dispatcher' | 'back_office' | 'admin'

export type Capability =
  | 'worksheet:execute_own'
  | 'service_item:create_in_field'
  | 'van_stock:view_own'
  | 'history:view'
  | 'team:view_bookings'
  | 'team:reassign_bookings'
  | 'crew:edit_composition'
  | 'team:review_time_entries'
  | 'order:view_all'
  | 'worksheet:approve'
  | 'worksheet:reject'
  | 'dispatch:manage'
  | 'tree:bulk_edit'
  | 'checklist:manage_templates'
  | 'document:override_generation'
  | 'sync:view_health'
  | 'pricing:view_margins'
  | 'customer:edit'
  | 'item:edit'
  | 'report:view'
  | 'document:manage_delivery'
  | 'tenant:manage_settings'
  | 'users:manage'
  | 'device:manage_enrollment'
  | 'erp_connection:manage'
  | 'document_template:manage'
  | 'structure_template:manage'
  | 'api_token:manage'

// Transcribed from docs/05-users-auth.md §Roles — one row per role's bullet
// list. team_lead's "optionally (tenant flag) approve the team's worksheets"
// is a tunable edge on top of this default matrix, not part of it (no
// tenant-config mechanism exists yet to carry that override).
export const ROLE_CAPABILITIES: Record<Role, Capability[]> = {
  technician: ['worksheet:execute_own', 'service_item:create_in_field', 'van_stock:view_own', 'history:view'],
  team_lead: [
    'worksheet:execute_own',
    'service_item:create_in_field',
    'van_stock:view_own',
    'history:view',
    'team:view_bookings',
    'team:reassign_bookings',
    'crew:edit_composition',
    'team:review_time_entries',
  ],
  dispatcher: [
    'order:view_all',
    'worksheet:approve',
    'worksheet:reject',
    'dispatch:manage',
    'tree:bulk_edit',
    'checklist:manage_templates',
    'document:override_generation',
    'sync:view_health',
    'pricing:view_margins',
  ],
  back_office: ['customer:edit', 'item:edit', 'report:view', 'document:manage_delivery'],
  admin: [
    'tenant:manage_settings',
    'users:manage',
    'device:manage_enrollment',
    'erp_connection:manage',
    'document_template:manage',
    'structure_template:manage',
    'api_token:manage',
  ],
}

export function hasCapability(role: Role, capability: Capability): boolean {
  return ROLE_CAPABILITIES[role].includes(capability)
}
