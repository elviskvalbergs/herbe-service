import { describe, it, expect } from 'vitest';
import {
  chargeTypeToItemType,
  itemTypeToChargeType,
  parseItemTypeLabel,
  suggestChargeType,
  chargesCustomer,
} from '@/lib/domain/charge-type';

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
  it('maps an out-of-range ItemType (unmapped integer) to invoiceable AND flags it for manager review', () => {
    expect(itemTypeToChargeType(5)).toEqual({ charge: 'invoiceable', needsReview: true });
  });
});

describe('parseItemTypeLabel (SVOVc line ItemType — English label string on this tenant)', () => {
  it('maps each known English label, case-insensitively', () => {
    expect(parseItemTypeLabel('Invoiceable')).toEqual({ charge: 'invoiceable', needsReview: false });
    expect(parseItemTypeLabel('Warranty')).toEqual({ charge: 'warranty', needsReview: false });
    expect(parseItemTypeLabel('Contract')).toEqual({ charge: 'contract', needsReview: false });
    expect(parseItemTypeLabel('Goodwill')).toEqual({ charge: 'goodwill', needsReview: false });
    expect(parseItemTypeLabel('WARRANTY')).toEqual({ charge: 'warranty', needsReview: false });
    expect(parseItemTypeLabel('goodwill')).toEqual({ charge: 'goodwill', needsReview: false });
  });
  it('trims surrounding whitespace on a known label', () => {
    expect(parseItemTypeLabel('  Warranty  ')).toEqual({ charge: 'warranty', needsReview: false });
  });
  it('a numeric string 1..4 delegates to itemTypeToChargeType', () => {
    expect(parseItemTypeLabel('1')).toEqual({ charge: 'invoiceable', needsReview: false });
    expect(parseItemTypeLabel('2')).toEqual({ charge: 'warranty', needsReview: false });
    expect(parseItemTypeLabel('3')).toEqual({ charge: 'contract', needsReview: false });
    expect(parseItemTypeLabel('4')).toEqual({ charge: 'goodwill', needsReview: false });
  });
  it('a bare number delegates to itemTypeToChargeType', () => {
    expect(parseItemTypeLabel(2)).toEqual({ charge: 'warranty', needsReview: false });
  });
  it('"-", empty string, "0", null, and undefined all map to invoiceable + needsReview (string-set-31 unset rule)', () => {
    expect(parseItemTypeLabel('-')).toEqual({ charge: 'invoiceable', needsReview: true });
    expect(parseItemTypeLabel('')).toEqual({ charge: 'invoiceable', needsReview: true });
    expect(parseItemTypeLabel('   ')).toEqual({ charge: 'invoiceable', needsReview: true });
    expect(parseItemTypeLabel('0')).toEqual({ charge: 'invoiceable', needsReview: true });
    expect(parseItemTypeLabel(null)).toEqual({ charge: 'invoiceable', needsReview: true });
    expect(parseItemTypeLabel(undefined)).toEqual({ charge: 'invoiceable', needsReview: true });
  });
  it('an unmapped label (e.g. an unverified other-locale string) falls back to invoiceable + needsReview', () => {
    expect(parseItemTypeLabel('Jāizr.rēķ.')).toEqual({ charge: 'invoiceable', needsReview: true });
    expect(parseItemTypeLabel('some other label')).toEqual({ charge: 'invoiceable', needsReview: true });
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
