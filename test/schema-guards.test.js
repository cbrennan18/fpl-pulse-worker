import { describe, it, expect } from 'vitest';
import { isSeasonElements, isEntrySeason, isLeagueMembers, isLeagueStandings } from '../src/lib/kv.js';

describe('isSeasonElements', () => {
  it('returns true for a valid season elements blob', () => {
    expect(isSeasonElements({
      last_gw_processed: 5,
      gws: { 1: {}, 2: {}, 3: {}, 4: {}, 5: {} },
    })).toBe(true);
  });

  it('returns false when last_gw_processed is missing', () => {
    expect(isSeasonElements({ gws: {} })).toBe(false);
  });

  it('returns false when gws is missing', () => {
    expect(isSeasonElements({ last_gw_processed: 5 })).toBeFalsy();
  });

  it('returns false when gws is not an object', () => {
    expect(isSeasonElements({ last_gw_processed: 5, gws: "invalid" })).toBe(false);
  });

  it('returns false for null', () => {
    expect(isSeasonElements(null)).toBeFalsy();
  });

  it('returns false for undefined', () => {
    expect(isSeasonElements(undefined)).toBeFalsy();
  });

  it('returns false for a string', () => {
    expect(isSeasonElements("not an object")).toBe(false);
  });
});

describe('isEntrySeason', () => {
  const valid = {
    entry_id: 12345,
    season: 2025,
    last_gw_processed: 3,
    gw_summaries: { 1: {}, 2: {}, 3: {} },
    picks_by_gw: { 1: {}, 2: {}, 3: {} },
    transfers: [],
  };

  it('returns true for a valid entry season blob', () => {
    expect(isEntrySeason(valid)).toBe(true);
  });

  it('returns true with extra fields', () => {
    expect(isEntrySeason({ ...valid, summary: { name: "Test" } })).toBe(true);
  });

  it('returns false when entry_id is missing', () => {
    const { entry_id, ...rest } = valid;
    expect(isEntrySeason(rest)).toBe(false);
  });

  it('returns false when season is missing', () => {
    const { season, ...rest } = valid;
    expect(isEntrySeason(rest)).toBe(false);
  });

  it('returns false when last_gw_processed is missing', () => {
    const { last_gw_processed, ...rest } = valid;
    expect(isEntrySeason(rest)).toBe(false);
  });

  it('returns false when gw_summaries is missing', () => {
    const { gw_summaries, ...rest } = valid;
    expect(isEntrySeason(rest)).toBeFalsy();
  });

  it('returns false when picks_by_gw is missing', () => {
    const { picks_by_gw, ...rest } = valid;
    expect(isEntrySeason(rest)).toBeFalsy();
  });

  it('returns false when transfers is not an array', () => {
    expect(isEntrySeason({ ...valid, transfers: "not array" })).toBe(false);
  });

  it('returns false for null', () => {
    expect(isEntrySeason(null)).toBeFalsy();
  });

  it('returns false for undefined', () => {
    expect(isEntrySeason(undefined)).toBeFalsy();
  });
});

describe('isLeagueMembers', () => {
  it('returns true for a valid integer array', () => {
    expect(isLeagueMembers([1, 2, 3, 100])).toBe(true);
  });

  it('returns true for an empty array', () => {
    expect(isLeagueMembers([])).toBe(true);
  });

  it('returns false when array contains non-integers', () => {
    expect(isLeagueMembers([1, 2.5, 3])).toBe(false);
  });

  it('returns false when array contains strings', () => {
    expect(isLeagueMembers([1, "two", 3])).toBe(false);
  });

  it('returns false for non-array', () => {
    expect(isLeagueMembers("not an array")).toBe(false);
  });

  it('returns false for null', () => {
    expect(isLeagueMembers(null)).toBe(false);
  });

  it('returns false for an object', () => {
    expect(isLeagueMembers({ 0: 1, 1: 2 })).toBe(false);
  });
});

describe('isLeagueStandings', () => {
  const valid = {
    season: 2025,
    harvested_at: '2026-05-25T18:00:00.000Z',
    member_count: 3,
    final: true,
    results: [{ entry: 11, rank: 1, total: 2343 }],
  };

  it('returns true for a valid archived standings blob', () => {
    expect(isLeagueStandings(valid)).toBe(true);
  });

  // LOAD-BEARING, and the reason the public route carries its own `final` check.
  // The guard asks whether `final` is a boolean, not whether it is true — so a
  // provisional mid-season capture validates exactly like a completed one. Anything
  // relying on this guard alone to mean "safe to present as a result" is wrong.
  it('accepts a provisional blob where final is false', () => {
    expect(isLeagueStandings({ ...valid, final: false })).toBe(true);
  });

  it('returns false when final is missing or not a boolean', () => {
    const { final, ...rest } = valid;
    expect(isLeagueStandings(rest)).toBe(false);
    expect(isLeagueStandings({ ...valid, final: 'true' })).toBe(false);
  });

  it('returns false when results is not an array', () => {
    expect(isLeagueStandings({ ...valid, results: null })).toBe(false);
  });

  it('returns false when season is not a number', () => {
    expect(isLeagueStandings({ ...valid, season: '2025' })).toBe(false);
  });

  it('returns false when member_count or harvested_at are missing', () => {
    const { member_count, ...noCount } = valid;
    expect(isLeagueStandings(noCount)).toBe(false);
    const { harvested_at, ...noStamp } = valid;
    expect(isLeagueStandings(noStamp)).toBe(false);
  });

  it('returns true for an empty results array — an empty league is not invalid', () => {
    expect(isLeagueStandings({ ...valid, results: [], member_count: 0 })).toBe(true);
  });

  it('returns false for null and undefined', () => {
    expect(isLeagueStandings(null)).toBeFalsy();
    expect(isLeagueStandings(undefined)).toBeFalsy();
  });
});
