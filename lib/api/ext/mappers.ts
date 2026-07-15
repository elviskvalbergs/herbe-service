// lib/api/ext/mappers.ts
//
// Pure domain→portal mappers for the `/api/ext/v1` read API
// (docs/08-suite-integration.md §4: the read API the portal's service module
// will eventually consume). Every function here takes herbe.service's own
// Drizzle row shapes (`drizzle/schema.ts`) and returns exactly what
// `lib/api/ext/dto.ts` — herbe.service's mirror of the portal's
// `lib/service/dto.ts` — parses. No I/O: callers (the route handlers) do the
// joins/lookups and pass rows in.
//
// A handful of DTO fields the portal contract marks *required* have no
// domain source yet in this Phase 1 schema. Rather than inventing data, each
// is handled with a documented, non-fabricated fallback (reusing a real
// column already on the row) or an explicit empty placeholder — see the
// comment at each call site below and the task-7 report for the full list.
import type {
  ServiceItemRow,
  ItemModelRow,
  ServiceOrderRow,
  WorksheetRow,
  WorksheetLineRow,
  HistoryEventRow,
} from '@/drizzle/schema';
import type { ChargeType, NodeKind, HistoryEventKind } from '@/lib/domain/types';
import type { CustomerOrderStatus } from '@/lib/domain/customer-order-status';
import type {
  ServiceItemSummary,
  ServiceItemDetail,
  HistoryEvent,
  OrderSummary,
  OrderDetail,
  WorksheetSummary,
} from '@/lib/api/ext/dto';

function warrantyOf(item: ServiceItemRow): NonNullable<ServiceItemSummary['warranty']> {
  const until = item.warrantyUntil;
  return {
    ...(until ? { until: until.toISOString(), status: until.getTime() > Date.now() ? 'in_warranty' : 'expired' } : {}),
    laborCovered: item.warrantyLaborCovered,
    partsCovered: item.warrantyPartsCovered,
  };
}

function modelOf(model?: ItemModelRow | null): ServiceItemSummary['model'] {
  if (!model) return undefined;
  return {
    ...(model.make ? { make: model.make } : {}),
    ...(model.model ? { model: model.model } : {}),
    ...(model.category ? { category: model.category } : {}),
  };
}

export function mapServiceItemSummary(item: ServiceItemRow, model?: ItemModelRow | null): ServiceItemSummary {
  return {
    id: item.id,
    labelId: item.labelId,
    kind: item.kind as NodeKind,
    path: item.path,
    name: item.name,
    ...(item.serialNr ? { serial: item.serialNr } : {}),
    ...(item.secondarySerial ? { secondarySerial: item.secondarySerial } : {}),
    ...(model !== undefined && model !== null ? { model: modelOf(model) } : {}),
    // siteId/contract: no domain column in this Phase 1 schema — always omitted.
    ...(item.siteName ? { siteName: item.siteName } : {}),
    // No lifecycle-status column yet (docs/02-data-model.md's "active / inactive
    // / replaced" is design intent, not yet a field). deletedAt (soft-delete) is
    // the only real signal available, so it's the only distinction made here;
    // 'replaced' is never produced until a supersession field exists.
    status: item.deletedAt ? 'inactive' : 'active',
    warranty: warrantyOf(item),
    ...(item.quantity != null ? { quantity: item.quantity } : {}),
  };
}

export function mapServiceItemDetail(item: ServiceItemRow, model?: ItemModelRow | null): ServiceItemDetail {
  return {
    ...mapServiceItemSummary(item, model),
    // installedAt/meters: no domain source yet — always omitted.
    ...(item.parentId ? { parentId: item.parentId } : {}),
    documents: [],
  };
}

export function mapHistoryEvent(row: HistoryEventRow, orderNumber?: string): HistoryEvent {
  const covered = row.coverageCovered;
  const of = row.coverageOf;
  return {
    id: row.id,
    at: (row.at ?? row.createdAt).toISOString(),
    kind: (row.kind ?? 'erp_history') as HistoryEventKind,
    summary: row.summary ?? '',
    ...(row.orderId ? { orderId: row.orderId } : {}),
    ...(orderNumber ? { orderNumber } : {}),
    ...(row.worksheetId ? { worksheetId: row.worksheetId } : {}),
    ...(covered != null && of != null ? { coverage: { covered, of } } : {}),
  };
}

// Shared by both orders/route.ts (list) and orders/[id]/route.ts (detail):
// turns an order's service_order_rows + a batch-fetched itemById map into
// the DTO's serviceItems[]. Drops rows whose serviceItemId is null or whose
// item wasn't found (e.g. soft-deleted, filtered out of itemById upstream),
// and dedupes by item id (first occurrence wins) — a group-service order can
// have multiple rows referencing the same service item, and the DTO must
// not list that item twice.
export function resolveOrderServiceItems(
  rows: { serviceItemId: string | null }[],
  itemById: Map<string, { id: string; name: string; serialNr: string | null }>,
): { id: string; name: string; serial?: string }[] {
  const seen = new Set<string>();
  const result: { id: string; name: string; serial?: string }[] = [];
  for (const row of rows) {
    if (!row.serviceItemId) continue;
    const item = itemById.get(row.serviceItemId);
    if (!item || seen.has(item.id)) continue;
    seen.add(item.id);
    result.push({ id: item.id, name: item.name, ...(item.serialNr ? { serial: item.serialNr } : {}) });
  }
  return result;
}

export function mapOrderSummary(
  order: ServiceOrderRow,
  opts: { customerStatus: CustomerOrderStatus; serviceItems: { id: string; name: string; serial?: string }[] },
): OrderSummary {
  return {
    id: order.id,
    // orderNumber is nullable domain-side (not yet assigned an app-own number
    // in every path); falling back to the row's own id rather than
    // inventing a number string.
    orderNumber: order.orderNumber ?? order.id,
    status: opts.customerStatus,
    description: order.description ?? '',
    // customerReference has no herbe.service column (it's ERP SVOVc.CustOrdNr,
    // portal-side only) — always omitted.
    ...(order.siteName ? { siteName: order.siteName } : {}),
    // requestedAt is nullable domain-side; falling back to updatedAt (a real,
    // always-set timestamp on the row) rather than inventing a date.
    requestedAt: (order.requestedAt ?? order.updatedAt).toISOString(),
    ...(order.promisedDate ? { promisedDate: order.promisedDate.toISOString() } : {}),
    serviceItems: opts.serviceItems.map((si) => ({
      id: si.id,
      name: si.name,
      ...(si.serial ? { serial: si.serial } : {}),
    })),
  };
}

export function mapOrderDetail(
  order: ServiceOrderRow,
  opts: {
    customerStatus: CustomerOrderStatus;
    serviceItems: { id: string; name: string; serial?: string }[];
    worksheets: WorksheetSummary[];
  },
): OrderDetail {
  return {
    ...mapOrderSummary(order, opts),
    // timeline/invoices: required by the contract, no domain source yet.
    timeline: [],
    // booking/feedback/confirmation: no domain source yet — always omitted.
    worksheets: opts.worksheets,
    invoices: [],
  };
}

export function mapWorksheetSummary(ws: WorksheetRow, rows: WorksheetLineRow[]): WorksheetSummary {
  return {
    id: ws.id,
    // workDate has no domain column yet; falling back to updatedAt (a real,
    // always-set timestamp on the row) rather than inventing a date.
    workDate: ws.updatedAt.toISOString(),
    // leadName/crewSize/timeTotalMinutes: no domain source available to this
    // mapper (technicianUserId is an id, not a name; no crew-size column; no
    // time-entry rows passed in) — always omitted.
    workDescription: ws.workDescription ?? '',
    rows: rows.map((row) => ({
      description: row.description ?? '',
      // quantity is required by the contract; domain quantity is a nullable
      // numeric string — 0 stands in for "no quantity recorded".
      quantity: row.quantity != null ? Number(row.quantity) : 0,
      ...(row.unit ? { unit: row.unit } : {}),
      ...(row.serial ? { serial: row.serial } : {}),
      chargeType: row.chargeType as ChargeType,
      ...(row.price != null ? { price: Number(row.price) } : {}),
      ...(row.sum != null ? { sum: Number(row.sum) } : {}),
      // serviceItem {id,name}: this mapper only receives worksheet-line rows
      // (serviceItemId, no name join) — a name can't be produced here, so
      // serviceItem is never emitted. A route that needs it must resolve the
      // name separately and re-attach it after calling this mapper.
    })),
    signedOnSite: ws.signedOnSite,
    // No report-generation source yet — always false, same placeholder idiom
    // as timeline/invoices above.
    reportPdf: false,
  };
}
