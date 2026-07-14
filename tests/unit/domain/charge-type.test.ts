import { describe, it, expect } from 'vitest';
import { chargeTypeToItemType, itemTypeToChargeType, suggestChargeType, chargesCustomer } from '@/lib/domain/charge-type';

describe('charge type ↔ ItemType (string set 31)', () => {
  it('maps app charge types to the ERP integer 1..4', () => {
    expect(chargeTypeToItemType('invoiceable')).toBe(1);
    expect(chargeTypeToItemType('warranty')).toBe(2);
    expect(chargeTypeToItemType('contract')).toBe(3);
    expect(chargeTypeToItemType('goodwill')).toBe(4);
  });
  it('maps ERP 0 (unset) to invoiceable AND flags it for manager review', () => {
    expect(itemTypeToChargeType(0)).toEqual({ charge: 'invoiceable', needsReview: true });
  });
  it('maps ERP 1..4 back without a review flag', () => {
    expect(itemTypeToChargeType(2)).toEqual({ charge: 'warranty', needsReview: false });
  });
});

describe('suggestChargeType', () => {
  it('contract-linked row → contract', () => {
    expect(suggestChargeType({ contractLinked: true, unitInWarranty: true })).toBe('contract');
  });
  it('warranty unit, no contract → warranty', () => {
    expect(suggestChargeType({ contractLinked: false, unitInWarranty: true })).toBe('warranty');
  });
  it('neither → invoiceable', () => {
    expect(suggestChargeType({ contractLinked: false, unitInWarranty: false })).toBe('invoiceable');
  });
});

describe('chargesCustomer', () => {
  it('only invoiceable charges the customer', () => {
    expect(chargesCustomer('invoiceable')).toBe(true);
    for (const c of ['warranty', 'contract', 'goodwill'] as const) expect(chargesCustomer(c)).toBe(false);
  });
});
