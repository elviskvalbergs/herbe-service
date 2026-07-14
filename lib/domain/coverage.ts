// lib/domain/coverage.ts
//
// Group-service coverage resolution: a lot/system-level service row targets
// its members via one of four modes instead of one row per member
// ("Inspected 79 of 84, 5 failed → replaced" is one group row + 5 exception
// entries, not 84 rows — 11:35). Coverage rows never sync to the ERP; this
// is pure app-side rollup math (11:97).

export type Coverage =
  | { mode: 'all' }
  | { mode: 'n_of_m'; n: number }
  | { mode: 'list'; ids: string[] }
  | { mode: 'all_except'; ids: string[] };

/** Resolves a Coverage record against the current member set. `n_of_m` covers the
 * first n members deterministically (by array order); `list`/`all_except` intersect
 * against members actually present, so stale ids (removed members) are dropped silently. */
export function resolveCoveredIds(coverage: Coverage, memberIds: string[]): string[] {
  switch (coverage.mode) {
    case 'all':
      return [...memberIds];
    case 'n_of_m':
      return memberIds.slice(0, Math.max(0, Math.min(coverage.n, memberIds.length)));
    case 'list': {
      const ids = new Set(coverage.ids);
      return memberIds.filter((id) => ids.has(id));
    }
    case 'all_except': {
      const ids = new Set(coverage.ids);
      return memberIds.filter((id) => !ids.has(id));
    }
  }
}

/** Coverage-% math for rollups (11:55, "42/46 inspected in the last 12 months"). */
export function coverageFraction(coverage: Coverage, memberIds: string[]): { covered: number; of: number } {
  return { covered: resolveCoveredIds(coverage, memberIds).length, of: memberIds.length };
}
