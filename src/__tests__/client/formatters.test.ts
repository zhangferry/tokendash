import { describe, it, expect } from 'vitest';
import { formatTokens, formatUSD, formatPercent, formatProjectName } from '../../client/utils/formatters.js';

describe('formatTokens', () => {
  it('formats millions with M suffix', () => {
    expect(formatTokens(1_500_000)).toBe('1.5M');
    expect(formatTokens(2_000_000)).toBe('2.0M');
  });

  it('formats thousands with K suffix', () => {
    expect(formatTokens(1_500)).toBe('2K');   // toFixed(0) rounds 1.5 to 2
    expect(formatTokens(999)).toBe('999');
    expect(formatTokens(42_000)).toBe('42K');
  });

  it('formats small numbers as-is', () => {
    expect(formatTokens(0)).toBe('0');
    expect(formatTokens(42)).toBe('42');
    expect(formatTokens(999)).toBe('999');
  });
});

describe('formatUSD', () => {
  it('formats as USD currency', () => {
    expect(formatUSD(0)).toBe('$0.00');
    expect(formatUSD(1.5)).toBe('$1.50');
    expect(formatUSD(123.456)).toBe('$123.46');
  });
});

describe('formatPercent', () => {
  it('formats with one decimal', () => {
    expect(formatPercent(50)).toBe('50.0%');
    expect(formatPercent(94.87)).toBe('94.9%');
  });
});

describe('formatProjectName', () => {
  it('returns last segment for simple names', () => {
    // split by '-' → last segment
    expect(formatProjectName('my-project')).toBe('project');
    expect(formatProjectName('foo-bar-baz')).toBe('baz');
    expect(formatProjectName('single')).toBe('single');
  });

  it('uses parent prefix when duplicates exist', () => {
    const all = ['dir1/dashboard', 'dir2/dashboard'];
    expect(formatProjectName('dir1/dashboard', all)).toBe('dir1/dashboard');
    expect(formatProjectName('dir2/dashboard', all)).toBe('dir2/dashboard');
  });

  it('returns last segment when no duplicates', () => {
    const all = ['dir1/dashboard', 'dir2/other'];
    expect(formatProjectName('dir1/dashboard', all)).toBe('dashboard');
  });
});
