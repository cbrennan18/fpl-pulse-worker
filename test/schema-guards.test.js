import { describe, it, expect } from 'vitest';
import { isSeasonElements, isEntrySeason, isLeagueMembers } from '../src/lib/kv.js';

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
