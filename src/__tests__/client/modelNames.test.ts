import { describe, it, expect } from 'vitest';
import { shortModelName } from '../../client/utils/modelNames.js';

describe('shortModelName', () => {
  it('maps exact known model IDs', () => {
    expect(shortModelName('claude-opus-4')).toBe('Opus 4');
    expect(shortModelName('claude-sonnet-4')).toBe('Sonnet 4');
    expect(shortModelName('claude-haiku-4')).toBe('Haiku 4');
  });

  it('maps dated model IDs from lookup table', () => {
    expect(shortModelName('claude-opus-4-20250514')).toBe('Opus 4');
    expect(shortModelName('claude-sonnet-4-20250514')).toBe('Sonnet 4');
    expect(shortModelName('claude-haiku-3-5-20241022')).toBe('Haiku 3.5');
  });

  it('extracts version from unrecognized claude model IDs', () => {
    expect(shortModelName('claude-sonnet-4-5')).toBe('Sonnet 4');
    expect(shortModelName('claude-opus-4-5')).toBe('Opus 4');
  });

  it('returns type without version for versionless claude IDs', () => {
    expect(shortModelName('claude-opus')).toBe('Opus');
    expect(shortModelName('claude-sonnet')).toBe('Sonnet');
    expect(shortModelName('claude-haiku')).toBe('Haiku');
  });

  it('returns original ID for non-claude models', () => {
    expect(shortModelName('glm-4.7')).toBe('glm-4.7');
    expect(shortModelName('mimo-v2.5-pro')).toBe('mimo-v2.5-pro');
    expect(shortModelName('gpt-4.1')).toBe('gpt-4.1');
    expect(shortModelName('o3')).toBe('o3');
  });
});
