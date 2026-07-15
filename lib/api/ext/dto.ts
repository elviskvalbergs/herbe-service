// lib/api/ext/dto.ts
//
// Mirror of herbe.portal's `/api/ext/v1` client-DTO contract
// (herbe-portal `lib/service/dto.ts`) — the response shapes the portal's
// service module already parses (docs/08-suite-integration.md §4: the wider
// read API is "future ... re-cut when the portal module settles", but these
// shapes are the verified input carried forward). Kept as a literal
// transcription — same field names, same required/optional split, same
// `.strip()` — so herbe.service's own routes can validate their output
// against exactly what the portal expects. Only extend this file when the
// portal schema gains the field too; it is not this repo's contract to
// redesign.
import { z } from 'zod';

export const customerOrderStatus = z.enum([
  'received', 'scheduled', 'in_progress', 'work_done', 'completed', 'cancelled',
]);
export type CustomerOrderStatus = z.infer<typeof customerOrderStatus>;

// Portal keeps this local (unexported); exported here so lib/api/ext/mappers.ts
// can reuse the enum's values/type when casting a domain ChargeType.
export const chargeType = z.enum(['invoiceable', 'warranty', 'contract', 'goodwill']);
export type ExtChargeType = z.infer<typeof chargeType>;

export const serviceItemSummarySchema = z.object({
  id: z.string(),
  labelId: z.string(),
  kind: z.enum(['system', 'unit', 'lot']),
  path: z.string(),
  name: z.string(),
  serial: z.string().optional(),
  secondarySerial: z.string().optional(),
  model: z.object({ make: z.string().optional(), model: z.string().optional(), category: z.string().optional() }).optional(),
  siteId: z.string().optional(),
  siteName: z.string().optional(),
  status: z.enum(['active', 'inactive', 'replaced']),
  warranty: z.object({
    until: z.string().optional(),
    status: z.string().optional(),
    laborCovered: z.boolean(),
    partsCovered: z.boolean(),
  }).optional(),
  contract: z.object({
    id: z.string(),
    type: z.string().optional(),
    coverageStart: z.string().optional(),
    coverageEnd: z.string().optional(),
  }).optional(),
  quantity: z.number().optional(),
}).strip();
export type ServiceItemSummary = z.infer<typeof serviceItemSummarySchema>;

export const serviceItemDetailSchema = serviceItemSummarySchema.extend({
  installedAt: z.string().optional(),
  parentId: z.string().optional(),
  meters: z.array(z.object({ name: z.string(), value: z.number(), unit: z.string().optional(), readAt: z.string() })).optional(),
  documents: z.array(z.object({
    id: z.string(), name: z.string(),
    kind: z.enum(['manual', 'image', 'exploded_view', 'other']),
    url: z.string(),
  })).default([]),
}).strip();
export type ServiceItemDetail = z.infer<typeof serviceItemDetailSchema>;

// Task 8 (herbe-portal `lib/service/dto.ts`'s `serviceItemListSchema`): the
// list route's envelope. Deferred out of Task 7's transcription on purpose
// (its brief scoped Task 7 to the per-entity schemas only) — added now that
// the list route needs to validate its own `{ data, nextCursor }` shape
// against exactly what `lib/service/client.ts`'s `listServiceItems` parses.
export const serviceItemListSchema = z.object({
  data: z.array(serviceItemSummarySchema),
  nextCursor: z.string().optional(),
}).strip();
export type ServiceItemList = z.infer<typeof serviceItemListSchema>;

export const historyEventSchema = z.object({
  id: z.string(),
  at: z.string(),
  kind: z.enum(['work_done', 'part_replaced', 'measurement', 'status_change', 'covered_by_group_service', 'erp_history']),
  summary: z.string(),
  orderId: z.string().optional(),
  orderNumber: z.string().optional(),
  worksheetId: z.string().optional(),
  coverage: z.object({ covered: z.number(), of: z.number() }).optional(),
}).strip();
export type HistoryEvent = z.infer<typeof historyEventSchema>;

export const worksheetSummarySchema = z.object({
  id: z.string(),
  workDate: z.string(),
  // Appendix A shows leadName/crewSize as required, but the spec (§Appendix A
  // provenance note) flags both as "confirm during implementation whether tracked
  // in raw WSVc" and possibly absent. Kept optional so a missing display-only field
  // never fails the whole enriched parse — enrichment must never block baseline.
  leadName: z.string().optional(),
  crewSize: z.number().optional(),
  workDescription: z.string(),
  rows: z.array(z.object({
    description: z.string(),
    quantity: z.number(),
    unit: z.string().optional(),
    serial: z.string().optional(),
    chargeType,
    price: z.number().optional(),
    sum: z.number().optional(),
    serviceItem: z.object({ id: z.string(), name: z.string() }).optional(),
  })),
  timeTotalMinutes: z.number().optional(),
  signedOnSite: z.boolean(),
  reportPdf: z.boolean(),
}).strip();
export type WorksheetSummary = z.infer<typeof worksheetSummarySchema>;

export const orderSummarySchema = z.object({
  id: z.string(),
  orderNumber: z.string(),
  status: customerOrderStatus,
  description: z.string(),
  customerReference: z.string().optional(),
  siteName: z.string().optional(),
  requestedAt: z.string(),
  promisedDate: z.string().optional(),
  serviceItems: z.array(z.object({ id: z.string(), name: z.string(), serial: z.string().optional() })),
}).strip();
export type OrderSummary = z.infer<typeof orderSummarySchema>;

export const orderDetailSchema = orderSummarySchema.extend({
  timeline: z.array(z.object({
    at: z.string(),
    event: z.enum([
      'received', 'scheduled', 'rescheduled', 'in_progress', 'paused', 'work_done',
      'confirmed', 'rejected', 'erpProcessed', 'invoiced', 'completed', 'cancelled',
      'quote_sent', 'quote_accepted', 'feedback_received',
    ]),
    detail: z.string().optional(),
  })),
  booking: z.object({
    slotStart: z.string(), slotEnd: z.string(),
    enRoute: z.boolean(), etaMinutes: z.number().optional(),
  }).optional(),
  worksheets: z.array(worksheetSummarySchema),
  feedback: z.object({ rating: z.number(), comment: z.string().optional(), givenAt: z.string(), byMe: z.boolean() }).optional(),
  confirmation: z.object({
    method: z.enum(['esign', 'portal_confirm', 'button', 'hand_signature']),
    at: z.string(), by: z.string(),
  }).optional(),
  invoices: z.array(z.object({ invoiceNumber: z.string(), erpCompanyId: z.string() })),
}).strip();
export type OrderDetail = z.infer<typeof orderDetailSchema>;

// Task 9 (mirrors serviceItemListSchema above): the orders list route's
// envelope, validated against exactly what the portal's `listOrders` client
// call parses.
export const orderListSchema = z.object({
  data: z.array(orderSummarySchema),
  nextCursor: z.string().optional(),
}).strip();
export type OrderList = z.infer<typeof orderListSchema>;
