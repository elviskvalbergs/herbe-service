// app/(office)/c/[companyId]/orders/page.tsx
//
// Task 4 (WS5-minimal booking, docs/superpowers/sdd/task-4-brief.md): the
// stub's own former comment named this exactly — the layout only gates
// dispatcher/back_office/admin, not the 'order:view_all' capability
// specifically, so this page adds that check itself before rendering any
// content worth restricting.
//
// erpCompanyId is re-derived and re-validated the same way
// app/(office)/c/[companyId]/layout.tsx:69-76 does, even though the layout
// already performed this exact check for this same request — the binding
// contract for this task treats route AND page as each re-validating tenant
// ownership independently (see the sibling /api/service-orders route's own
// header comment for why: a check performed once upstream is still worth
// repeating at the point that actually uses erpCompanyId for a query).
import { notFound, redirect } from 'next/navigation'
import { and, eq } from 'drizzle-orm'
import { getTranslations } from 'next-intl/server'
import { db } from '@/lib/db'
import * as schema from '@/drizzle/schema'
import { getVerifiedSession } from '@/lib/auth/session-guard'
import { hasCapability, type Role } from '@/lib/auth/roles'
import { scanCustomersForCompany } from '@/lib/domain/stores/customers'
import { listLinkedTechnicians } from '@/lib/domain/stores/identity-links'
import { NewBookingForm } from '@/components/new-booking-form'

export default async function OrdersPage({ params }: { params: Promise<{ companyId: string }> }) {
  const session = await getVerifiedSession(db)
  if (!session) {
    redirect('/login')
  }

  const role = session.user.role as Role
  if (!hasCapability(role, 'order:view_all')) {
    notFound()
  }

  const { companyId } = await params
  const tenantId = session.user.tenantId

  // Foreign/deactivated companyId reads as a flat 404 — never confirm
  // existence to a tenant that doesn't own it (same rule as the layout).
  const [company] = await db
    .select({ id: schema.erpCompanies.id, tenantId: schema.erpCompanies.tenantId })
    .from(schema.erpCompanies)
    .where(and(eq(schema.erpCompanies.id, companyId), eq(schema.erpCompanies.active, true)))

  if (!company || company.tenantId !== tenantId) {
    notFound()
  }

  const [customers, technicians, t] = await Promise.all([
    scanCustomersForCompany(db, tenantId, companyId),
    listLinkedTechnicians(db, tenantId, companyId),
    getTranslations('booking'),
  ])

  return (
    <main className="flex flex-1 flex-col gap-4">
      <h1 className="text-lg font-semibold">{t('title')}</h1>
      <NewBookingForm
        companyId={companyId}
        customers={customers.map((customer) => ({ id: customer.id, name: customer.name }))}
        technicians={technicians}
        labels={{
          customerLabel: t('customer_label'),
          customerPlaceholder: t('customer_placeholder'),
          technicianLabel: t('technician_label'),
          technicianPlaceholder: t('technician_placeholder'),
          descriptionLabel: t('description_label'),
          submitLabel: t('submit_label'),
          errorGeneric: t('error_generic'),
        }}
      />
    </main>
  )
}
