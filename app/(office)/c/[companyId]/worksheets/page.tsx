// app/(office)/c/[companyId]/worksheets/page.tsx
//
// Task 6 (O4 approval UI, docs/superpowers/sdd/task-6-brief.md): replaces
// the Task 6 placeholder that this file's own former comment flagged — the
// layout only gates dispatcher/back_office/admin, not the
// 'worksheet:approve' capability specifically (same reasoning as
// orders/page.tsx's Task 4 comment), so this page adds that check itself
// before rendering any content worth restricting. FIX-13: this
// hasCapability check IS the fix — without it, any office role could see
// (and, via the route, approve) worksheets. notFound() rather than a 403
// page, matching orders/page.tsx: don't distinguish "you can't do this"
// from "this doesn't exist" at the page level.
//
// erpCompanyId is re-derived and re-validated the same way
// app/(office)/c/[companyId]/layout.tsx:69-76 / orders/page.tsx already do
// — see orders/page.tsx's header comment for why a check performed once
// upstream is still worth repeating at the point that uses erpCompanyId
// for a query.
//
// Display data (order/customer/technician) isn't on the worksheets row
// itself, so this batches one extra query per join table (orders,
// customers, technicians) by id rather than round-tripping per worksheet —
// same batch-by-ids idiom as getServiceOrderRowsForOrders /
// getWorksheetRowsForWorksheets.
import { notFound, redirect } from 'next/navigation'
import { and, eq, inArray } from 'drizzle-orm'
import { getTranslations } from 'next-intl/server'
import { db } from '@/lib/db'
import * as schema from '@/drizzle/schema'
import { getVerifiedSession } from '@/lib/auth/session-guard'
import { hasCapability, type Role } from '@/lib/auth/roles'
import { scanWorksheetsForCompanyByStatus } from '@/lib/domain/stores/worksheets'
import { WorksheetApprovalQueue, type WorksheetApprovalItem } from '@/components/worksheet-approval-queue'

export default async function WorksheetsPage({ params }: { params: Promise<{ companyId: string }> }) {
  const session = await getVerifiedSession(db)
  if (!session) {
    redirect('/login')
  }

  const role = session.user.role as Role
  if (!hasCapability(role, 'worksheet:approve')) {
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

  const [worksheets, t] = await Promise.all([
    scanWorksheetsForCompanyByStatus(db, tenantId, companyId, 'Done'),
    getTranslations('worksheet_approval'),
  ])

  const orderIds = [...new Set(worksheets.map((w) => w.orderId))]
  const technicianUserIds = [
    ...new Set(worksheets.map((w) => w.technicianUserId).filter((id): id is string => Boolean(id))),
  ]

  const [orders, technicians] = await Promise.all([
    orderIds.length > 0
      ? db
          .select({
            id: schema.serviceOrders.id,
            orderNumber: schema.serviceOrders.orderNumber,
            customerId: schema.serviceOrders.customerId,
          })
          .from(schema.serviceOrders)
          .where(inArray(schema.serviceOrders.id, orderIds))
      : Promise.resolve([]),
    technicianUserIds.length > 0
      ? db.select({ id: schema.users.id, email: schema.users.email }).from(schema.users).where(inArray(schema.users.id, technicianUserIds))
      : Promise.resolve([]),
  ])

  const customerIds = [...new Set(orders.map((o) => o.customerId))]
  const customers =
    customerIds.length > 0
      ? await db
          .select({ id: schema.customers.id, name: schema.customers.name })
          .from(schema.customers)
          .where(inArray(schema.customers.id, customerIds))
      : []

  const orderById = new Map(orders.map((o) => [o.id, o]))
  const customerById = new Map(customers.map((c) => [c.id, c]))
  const technicianById = new Map(technicians.map((u) => [u.id, u]))

  const items: WorksheetApprovalItem[] = worksheets.map((w) => {
    const order = orderById.get(w.orderId)
    const customer = order ? customerById.get(order.customerId) : undefined
    const technician = w.technicianUserId ? technicianById.get(w.technicianUserId) : undefined
    return {
      id: w.id,
      orderNumber: order?.orderNumber ?? null,
      customerName: customer?.name ?? '',
      technicianEmail: technician?.email ?? null,
      workDescription: w.workDescription,
    }
  })

  return (
    <main className="flex flex-1 flex-col gap-4">
      <h1 className="text-lg font-semibold">{t('title')}</h1>
      <WorksheetApprovalQueue
        items={items}
        labels={{
          columnOrder: t('column_order'),
          columnCustomer: t('column_customer'),
          columnTechnician: t('column_technician'),
          columnWorkDescription: t('column_work_description'),
          approveLabel: t('approve_label'),
          approvingLabel: t('approving_label'),
          errorGeneric: t('error_generic'),
          emptyState: t('empty_state'),
        }}
      />
    </main>
  )
}
