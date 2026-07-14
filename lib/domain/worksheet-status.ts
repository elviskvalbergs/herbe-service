// lib/domain/worksheet-status.ts
//
// Worksheet status machine — pure, ERP-independent. Encodes the spec flow
// (docs/02-data-model.md:92): Draft → Assigned → Accepted → In progress →
// Paused → Done → Approved → Synced, with In progress ↔ Paused, Paused →
// Done, and Rejected reachable from In progress/Paused/Done, re-entering
// at In progress. Synced is terminal.

import type { WorksheetStatus } from './types';

const TRANSITIONS: Record<WorksheetStatus, WorksheetStatus[]> = {
  Draft: ['Assigned'],
  Assigned: ['Accepted'],
  Accepted: ['In progress'],
  'In progress': ['Paused', 'Done', 'Rejected'],
  Paused: ['In progress', 'Done', 'Rejected'],
  Done: ['Approved', 'Rejected'],
  Approved: ['Synced'],
  Synced: [],
  Rejected: ['In progress'],
};

export class DomainTransitionError extends Error {
  constructor(from: WorksheetStatus, to: WorksheetStatus) {
    super(`Illegal worksheet transition: ${from} → ${to}`);
    this.name = 'DomainTransitionError';
  }
}

export function canTransitionWorksheet(from: WorksheetStatus, to: WorksheetStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function assertWorksheetTransition(from: WorksheetStatus, to: WorksheetStatus): void {
  if (!canTransitionWorksheet(from, to)) throw new DomainTransitionError(from, to);
}

export function isTerminalWorksheet(s: WorksheetStatus): boolean {
  return TRANSITIONS[s].length === 0;
}
