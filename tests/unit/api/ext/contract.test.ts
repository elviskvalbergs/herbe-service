// tests/unit/api/ext/contract.test.ts
//
// Task 10 (docs/superpowers/sdd/task-10-brief.md): guards lib/api/ext/dto.ts
// against silent drift from the portal's frozen contract (herbe-portal
// `lib/service/dto.ts`). Since dto.ts is a *transcription*, not an import —
// the two repos don't share code — nothing at compile time catches one side
// changing without the other. This test transcribes an independent
// reference copy of the portal's schemas (as they stand at herbe-portal
// `lib/service/dto.ts`, copied field-for-field below) and:
//
//  1. Structurally diffs field names, required/optional-ness, enum value
//     sets, and nesting shape between the reference and herbe.service's own
//     schemas, recursively, for every DTO the portal parses.
//  2. Round-trips representative fixtures through herbe.service's own
//     schemas: a fully-populated object parses; a required field missing
//     throws; an unknown enum value throws — proving *behavior*, not just
//     shape, matches what the portal client expects.
//
// If this test starts failing, the fix is almost never "update this file" —
// it's "the two dto.ts files have drifted, go reconcile them." Only edit the
// reference block below when the portal's lib/service/dto.ts itself changes.
import { describe, expect, it } from 'vitest';
import { z, type ZodTypeAny } from 'zod';
import * as ext from '@/lib/api/ext/dto';

// ---------------------------------------------------------------------------
// Reference: literal transcription of herbe-portal's lib/service/dto.ts
// (frozen contract). Kept separate from lib/api/ext/dto.ts on purpose — the
// two files must be written independently for this test to mean anything.
// ---------------------------------------------------------------------------
const refCustomerOrderStatus = z.enum([
  'received', 'scheduled', 'in_progress', 'work_done', 'completed', 'cancelled',
]);

const refChargeType = z.enum(['invoiceable', 'warranty', 'contract', 'goodwill']);

const refServiceItemSummarySchema = z.object({
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

const refServiceItemDetailSchema = refServiceItemSummarySchema.extend({
  installedAt: z.string().optional(),
  parentId: z.string().optional(),
  meters: z.array(z.object({ name: z.string(), value: z.number(), unit: z.string().optional(), readAt: z.string() })).optional(),
  documents: z.array(z.object({
    id: z.string(), name: z.string(),
    kind: z.enum(['manual', 'image', 'exploded_view', 'other']),
    url: z.string(),
  })).default([]),
}).strip();

const refHistoryEventSchema = z.object({
  id: z.string(),
  at: z.string(),
  kind: z.enum(['work_done', 'part_replaced', 'measurement', 'status_change', 'covered_by_group_service', 'erp_history']),
  summary: z.string(),
  orderId: z.string().optional(),
  orderNumber: z.string().optional(),
  worksheetId: z.string().optional(),
  coverage: z.object({ covered: z.number(), of: z.number() }).optional(),
}).strip();

const refWorksheetSummarySchema = z.object({
  id: z.string(),
  workDate: z.string(),
  leadName: z.string().optional(),
  crewSize: z.number().optional(),
  workDescription: z.string(),
  rows: z.array(z.object({
    description: z.string(),
    quantity: z.number(),
    unit: z.string().optional(),
    serial: z.string().optional(),
    chargeType: refChargeType,
    price: z.number().optional(),
    sum: z.number().optional(),
    serviceItem: z.object({ id: z.string(), name: z.string() }).optional(),
  })),
  timeTotalMinutes: z.number().optional(),
  signedOnSite: z.boolean(),
  reportPdf: z.boolean(),
}).strip();

const refOrderSummarySchema = z.object({
  id: z.string(),
  orderNumber: z.string(),
  status: refCustomerOrderStatus,
  description: z.string(),
  customerReference: z.string().optional(),
  siteName: z.string().optional(),
  requestedAt: z.string(),
  promisedDate: z.string().optional(),
  serviceItems: z.array(z.object({ id: z.string(), name: z.string(), serial: z.string().optional() })),
}).strip();

const refOrderDetailSchema = refOrderSummarySchema.extend({
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
  worksheets: z.array(refWorksheetSummarySchema),
  feedback: z.object({ rating: z.number(), comment: z.string().optional(), givenAt: z.string(), byMe: z.boolean() }).optional(),
  confirmation: z.object({
    method: z.enum(['esign', 'portal_confirm', 'button', 'hand_signature']),
    at: z.string(), by: z.string(),
  }).optional(),
  invoices: z.array(z.object({ invoiceNumber: z.string(), erpCompanyId: z.string() })),
}).strip();

const refServiceItemListSchema = z.object({ data: z.array(refServiceItemSummarySchema), nextCursor: z.string().optional() }).strip();
const refOrderListSchema = z.object({ data: z.array(refOrderSummarySchema), nextCursor: z.string().optional() }).strip();

// ---------------------------------------------------------------------------
// Structural signature: recursively walks a zod schema, unwrapping
// Optional/Default wrappers (recording optionality on the field itself) and
// describing Object/Array/Enum/primitive shape. Two schemas with an
// identical signature accept and reject exactly the same JSON shapes.
// ---------------------------------------------------------------------------
type Signature =
  | { kind: 'object'; optional: boolean; fields: Record<string, Signature> }
  | { kind: 'array'; optional: boolean; element: Signature }
  | { kind: 'enum'; optional: boolean; values: string[] }
  | { kind: string; optional: boolean };

function signature(schemaIn: ZodTypeAny): Signature {
  let t = schemaIn;
  let optional = false;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let def = (t as any)._def;
  while (def.typeName === 'ZodOptional' || def.typeName === 'ZodDefault') {
    optional = true;
    t = def.innerType;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    def = (t as any)._def;
  }
  switch (def.typeName) {
    case 'ZodObject': {
      const shape = (t as z.AnyZodObject).shape;
      const fields: Record<string, Signature> = {};
      for (const key of Object.keys(shape)) {
        fields[key] = signature(shape[key]);
      }
      return { kind: 'object', optional, fields };
    }
    case 'ZodArray':
      return { kind: 'array', optional, element: signature(def.type) };
    case 'ZodEnum':
      return { kind: 'enum', optional, values: [...def.values].sort() };
    default:
      return { kind: def.typeName, optional };
  }
}

describe('contract: lib/api/ext/dto.ts structurally matches the portal reference', () => {
  it.each([
    ['serviceItemSummarySchema', ext.serviceItemSummarySchema, refServiceItemSummarySchema],
    ['serviceItemDetailSchema', ext.serviceItemDetailSchema, refServiceItemDetailSchema],
    ['historyEventSchema', ext.historyEventSchema, refHistoryEventSchema],
    ['worksheetSummarySchema', ext.worksheetSummarySchema, refWorksheetSummarySchema],
    ['orderSummarySchema', ext.orderSummarySchema, refOrderSummarySchema],
    ['orderDetailSchema', ext.orderDetailSchema, refOrderDetailSchema],
    ['serviceItemListSchema', ext.serviceItemListSchema, refServiceItemListSchema],
    ['orderListSchema', ext.orderListSchema, refOrderListSchema],
  ] as const)('%s matches the portal reference field-for-field', (_name, own, ref) => {
    expect(signature(own)).toEqual(signature(ref));
  });

  it('customerOrderStatus enum values match', () => {
    expect([...ext.customerOrderStatus.options].sort()).toEqual([...refCustomerOrderStatus.options].sort());
  });

  it('chargeType enum values match', () => {
    expect([...ext.chargeType.options].sort()).toEqual([...refChargeType.options].sort());
  });
});

// ---------------------------------------------------------------------------
// Behavioral round-trip: representative fixtures parsed through
// herbe.service's own schemas (the module under test) — a full object
// parses, a missing required field throws, an unknown enum value throws.
// ---------------------------------------------------------------------------
const serviceItemSummaryFixture = {
  id: 'item-1',
  labelId: 'lbl-1',
  kind: 'unit',
  path: '/root/unit-1',
  name: 'Compressor Unit',
  serial: 'SN-100',
  secondarySerial: 'SN-200',
  model: { make: 'Acme', model: 'X1', category: 'compressor' },
  siteId: 'site-1',
  siteName: 'Warehouse A',
  status: 'active',
  warranty: { until: '2027-01-01T00:00:00.000Z', status: 'active', laborCovered: true, partsCovered: false },
  contract: { id: 'contract-1', type: 'full', coverageStart: '2026-01-01T00:00:00.000Z', coverageEnd: '2027-01-01T00:00:00.000Z' },
  quantity: 3,
};

const orderSummaryFixture = {
  id: 'order-1',
  orderNumber: 'ORD-1',
  status: 'scheduled',
  description: 'Annual maintenance',
  customerReference: 'PO-123',
  siteName: 'Warehouse A',
  requestedAt: '2026-01-01T00:00:00.000Z',
  promisedDate: '2026-01-10',
  serviceItems: [{ id: 'item-1', name: 'Compressor', serial: 'SN-1' }],
};

const worksheetSummaryFixture = {
  id: 'ws-1',
  workDate: '2026-01-02',
  leadName: 'Jane',
  crewSize: 2,
  workDescription: 'Replaced filter',
  rows: [{
    description: 'Filter', quantity: 1, unit: 'pcs', serial: 'SN-1',
    chargeType: 'invoiceable', price: 10, sum: 10,
    serviceItem: { id: 'item-1', name: 'Compressor' },
  }],
  timeTotalMinutes: 60,
  signedOnSite: true,
  reportPdf: false,
};

const orderDetailFixture = {
  ...orderSummaryFixture,
  timeline: [{ at: '2026-01-01T00:00:00.000Z', event: 'received', detail: 'Request logged' }],
  booking: { slotStart: '2026-01-05T08:00:00.000Z', slotEnd: '2026-01-05T10:00:00.000Z', enRoute: false, etaMinutes: 15 },
  worksheets: [worksheetSummaryFixture],
  feedback: { rating: 5, comment: 'Great', givenAt: '2026-01-06T00:00:00.000Z', byMe: true },
  confirmation: { method: 'esign', at: '2026-01-05T10:30:00.000Z', by: 'John Doe' },
  invoices: [{ invoiceNumber: 'INV-1', erpCompanyId: 'erp-1' }],
};

describe('contract: representative fixtures round-trip through lib/api/ext/dto.ts', () => {
  it('a fully-populated serviceItemSummary parses', () => {
    expect(() => ext.serviceItemSummarySchema.parse(serviceItemSummaryFixture)).not.toThrow();
  });

  it('serviceItemSummary throws when a required field is missing', () => {
    const { id: _id, ...missingId } = serviceItemSummaryFixture;
    expect(() => ext.serviceItemSummarySchema.parse(missingId)).toThrow();
    const { status: _status, ...missingStatus } = serviceItemSummaryFixture;
    expect(() => ext.serviceItemSummarySchema.parse(missingStatus)).toThrow();
  });

  it('serviceItemSummary throws on an unknown status enum value', () => {
    expect(() => ext.serviceItemSummarySchema.parse({ ...serviceItemSummaryFixture, status: 'bogus' })).toThrow();
  });

  it('a fully-populated orderSummary parses', () => {
    expect(() => ext.orderSummarySchema.parse(orderSummaryFixture)).not.toThrow();
  });

  it('orderSummary throws when a required field is missing', () => {
    const { orderNumber: _orderNumber, ...missing } = orderSummaryFixture;
    expect(() => ext.orderSummarySchema.parse(missing)).toThrow();
  });

  it('orderSummary throws on an unknown status enum value', () => {
    expect(() => ext.orderSummarySchema.parse({ ...orderSummaryFixture, status: 'bogus' })).toThrow();
  });

  it('a fully-populated orderDetail (with timeline/worksheets/invoices) parses', () => {
    expect(() => ext.orderDetailSchema.parse(orderDetailFixture)).not.toThrow();
  });

  it('orderDetail throws on an unknown timeline event enum value', () => {
    expect(() =>
      ext.orderDetailSchema.parse({ ...orderDetailFixture, timeline: [{ at: '2026-01-01T00:00:00.000Z', event: 'bogus' }] }),
    ).toThrow();
  });

  it('orderDetail parses with empty timeline/worksheets/invoices arrays (no domain source yet)', () => {
    expect(() =>
      ext.orderDetailSchema.parse({ ...orderDetailFixture, timeline: [], worksheets: [], invoices: [] }),
    ).not.toThrow();
  });

  it('a serviceItemList envelope parses and strips unknown top-level keys', () => {
    const parsed = ext.serviceItemListSchema.parse({
      data: [serviceItemSummaryFixture],
      nextCursor: '123',
      unknownField: 'should be stripped',
    });
    expect(parsed).not.toHaveProperty('unknownField');
    expect(parsed.data).toHaveLength(1);
  });

  it('an orderList envelope parses without nextCursor', () => {
    expect(() => ext.orderListSchema.parse({ data: [orderSummaryFixture] })).not.toThrow();
  });
});
