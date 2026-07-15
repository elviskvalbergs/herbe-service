// lib/domain/charge-type.ts
//
// App ChargeType ↔ ERP ItemType (string set 31) mapping, plus the
// default-suggestion rule and the invoiceable/charges-customer predicate.
//
// ERP ItemType is an unrelated integer field on INVc — never conflate it
// with our app-level ChargeType (see docs/02-data-model.md).

import type { ChargeType } from './types';

const TO_INT: Record<ChargeType, 1 | 2 | 3 | 4> = { invoiceable: 1, warranty: 2, contract: 3, goodwill: 4 };
const FROM_INT: Partial<Record<number, ChargeType>> = { 1: 'invoiceable', 2: 'warranty', 3: 'contract', 4: 'goodwill' };

export function chargeTypeToItemType(c: ChargeType): 1 | 2 | 3 | 4 {
  return TO_INT[c];
}

/** Inbound `0` ("-"/unset) is not silently assumed invoiceable — it is flagged for manager review (02:88). */
export function itemTypeToChargeType(n: number): { charge: ChargeType; needsReview: boolean } {
  if (n === 0) return { charge: 'invoiceable', needsReview: true };
  const charge = FROM_INT[n];
  if (!charge) return { charge: 'invoiceable', needsReview: true };
  return { charge, needsReview: false };
}

const KNOWN_ITEM_TYPE_LABELS: Record<string, ChargeType> = {
  invoiceable: 'invoiceable',
  warranty: 'warranty',
  contract: 'contract',
  goodwill: 'goodwill',
};

/**
 * Parses SVOVc line `ItemType`. Confirmed live on this tenant: it arrives as
 * an English label string ("Invoiceable", "Warranty", "Goodwill" observed;
 * string-set 31 also defines "Contract" and "-"/empty for unset/0) — NOT the
 * raw integer `itemTypeToChargeType` expects. Only English labels are mapped
 * so far; no Latvian/other-locale label has been verified live, so an
 * unmapped label (including any other-locale string) falls through to the
 * safe default with needsReview flagged, rather than guessing a mapping.
 * A numeric value/string is tolerated for robustness (some tenants may
 * return the raw integer) and delegates to itemTypeToChargeType.
 */
export function parseItemTypeLabel(value: unknown): { charge: ChargeType; needsReview: boolean } {
  if (typeof value === 'number') return itemTypeToChargeType(value);
  if (value === null || value === undefined) return { charge: 'invoiceable', needsReview: true };

  const raw = String(value).trim();
  if (!raw || raw === '-' || raw === '0') return { charge: 'invoiceable', needsReview: true };

  const known = KNOWN_ITEM_TYPE_LABELS[raw.toLowerCase()];
  if (known) return { charge: known, needsReview: false };

  if (/^\d+$/.test(raw)) return itemTypeToChargeType(Number(raw));

  return { charge: 'invoiceable', needsReview: true };
}

export function suggestChargeType(input: { contractLinked: boolean; unitInWarranty: boolean }): ChargeType {
  if (input.contractLinked) return 'contract';
  if (input.unitInWarranty) return 'warranty';
  return 'invoiceable';
}

export function chargesCustomer(c: ChargeType): boolean {
  return c === 'invoiceable';
}
