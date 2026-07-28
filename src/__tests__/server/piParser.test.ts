import { describe, expect, it } from 'vitest';
import { normalizePiProjectPath } from '../../server/piParser.js';

describe('normalizePiProjectPath', () => {
  it('keeps distinct absolute paths distinct while removing only trailing separators', () => {
    expect(normalizePiProjectPath('D:\\work\\api\\')).toBe('D:\\work\\api');
    expect(normalizePiProjectPath('D:\\archive\\api')).toBe('D:\\archive\\api');
    expect(normalizePiProjectPath('/work/api/')).toBe('/work/api');
  });
});
