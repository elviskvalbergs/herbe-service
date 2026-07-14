import { describe, it, expect } from 'vitest';
import { resolveCoveredIds, coverageFraction, type Coverage } from '@/lib/domain/coverage';

const members = ['a', 'b', 'c', 'd']; // 4 members

describe('resolveCoveredIds', () => {
  it("'all' covers every member", () => {
    expect(resolveCoveredIds({ mode: 'all' }, members).sort()).toEqual(members);
  });
  it("'n_of_m' covers the first n members deterministically", () => {
    expect(resolveCoveredIds({ mode: 'n_of_m', n: 2 }, members)).toEqual(['a', 'b']);
  });
  it("'list' covers exactly the listed members that are still present", () => {
    expect(resolveCoveredIds({ mode: 'list', ids: ['b', 'z'] }, members)).toEqual(['b']);
  });
  it("'all_except' covers everyone but the excepted", () => {
    expect(resolveCoveredIds({ mode: 'all_except', ids: ['c'] }, members).sort()).toEqual(['a', 'b', 'd']);
  });
  it("'n_of_m' clamps n above member count to the full list", () => {
    expect(resolveCoveredIds({ mode: 'n_of_m', n: 99 }, members)).toEqual(members);
  });
  it("'n_of_m' with n=0 covers nobody", () => {
    expect(resolveCoveredIds({ mode: 'n_of_m', n: 0 }, members)).toEqual([]);
  });
  it("'all_except' with an empty list covers everyone", () => {
    expect(resolveCoveredIds({ mode: 'all_except', ids: [] }, members).sort()).toEqual(members);
  });
  it("'n_of_m' with negative n clamps to 0, covering nobody", () => {
    expect(resolveCoveredIds({ mode: 'n_of_m', n: -1 }, members)).toEqual([]);
  });
  it("'list' with no matching ids covers nobody", () => {
    expect(resolveCoveredIds({ mode: 'list', ids: ['zzz'] }, members)).toEqual([]);
  });
});

describe('coverageFraction', () => {
  it('reports covered/of for n_of_m', () => {
    expect(coverageFraction({ mode: 'n_of_m', n: 3 }, members)).toEqual({ covered: 3, of: 4 });
  });
  it('reports 0/0 when the member list is empty regardless of mode', () => {
    expect(coverageFraction({ mode: 'all' }, [])).toEqual({ covered: 0, of: 0 });
  });
  it('reports 0/4 when a mode covers nothing against a non-empty member list', () => {
    expect(coverageFraction({ mode: 'n_of_m', n: 0 }, members)).toEqual({ covered: 0, of: 4 });
    expect(coverageFraction({ mode: 'list', ids: ['zzz'] }, members)).toEqual({ covered: 0, of: 4 });
  });
});
