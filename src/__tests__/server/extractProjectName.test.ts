import { describe, it, expect, vi, beforeEach } from 'vitest';
import { join } from 'node:path';

// Mock node:fs to control existsSync behavior
const existingPaths = new Set<string>();

vi.mock('node:fs', async (importOriginal) => {
  const mod = await importOriginal<typeof import('node:fs')>();
  return {
    ...mod,
    existsSync: (path: string) => existingPaths.has(path),
  };
});

// Mock node:os to return a consistent home directory
vi.mock('node:os', async (importOriginal) => {
  const mod = await importOriginal<typeof import('node:os')>();
  return {
    ...mod,
    homedir: () => '/Users/testuser',
  };
});

// Import after mocks are set up
import { extractProjectName } from '../../server/claudeJsonlParser.js';

function p(...segments: string[]): string {
  return join(...segments);
}

describe('extractProjectName', () => {
  beforeEach(() => {
    existingPaths.clear();
  });

  it('returns simple name as-is when it does not start with dash', () => {
    expect(extractProjectName('ccusage-dashboard')).toBe('ccusage-dashboard');
    expect(extractProjectName('my-project')).toBe('my-project');
    expect(extractProjectName('single')).toBe('single');
  });

  it('returns empty string for empty input', () => {
    expect(extractProjectName('')).toBe('');
  });

  it('extracts last segment for simple encoded path', () => {
    // -Users-testuser-Projects → /Users/testuser/Projects
    existingPaths.add(p('/Users'));
    existingPaths.add(p('/Users/testuser'));
    existingPaths.add(p('/Users/testuser/Projects'));

    const result = extractProjectName('-Users-testuser-Projects');
    expect(result).toBe('Projects');
  });

  it('preserves dashes in project names using filesystem resolution', () => {
    // -Users-testuser-AI-Ideas-ccusage-dashboard
    // Should resolve to ccusage-dashboard (not just dashboard)
    existingPaths.add(p('/Users'));
    existingPaths.add(p('/Users/testuser'));
    existingPaths.add(p('/Users/testuser/AI'));
    existingPaths.add(p('/Users/testuser/AI/Ideas'));
    existingPaths.add(p('/Users/testuser/AI/Ideas/ccusage-dashboard'));
    // Note: /Users/testuser/AI/Ideas/ccusage should NOT exist as a directory
    // so the function won't greedily split ccusage-dashboard

    const result = extractProjectName('-Users-testuser-AI-Ideas-ccusage-dashboard');
    expect(result).toBe('ccusage-dashboard');
  });

  it('resolves multi-segment dashed project name correctly', () => {
    // -Users-testuser-AI-Ideas-auto-switch
    existingPaths.add(p('/Users'));
    existingPaths.add(p('/Users/testuser'));
    existingPaths.add(p('/Users/testuser/AI'));
    existingPaths.add(p('/Users/testuser/AI/Ideas'));
    existingPaths.add(p('/Users/testuser/AI/Ideas/auto-switch'));

    const result = extractProjectName('-Users-testuser-AI-Ideas-auto-switch');
    expect(result).toBe('auto-switch');
  });

  it('handles hidden directories (dot prefix via double dash)', () => {
    // -Users-testuser--cline-workspaces-proj1-MyApp
    // The -- represents .cline (hidden directory)
    existingPaths.add(p('/Users'));
    existingPaths.add(p('/Users/testuser'));
    existingPaths.add(p('/Users/testuser/.cline'));
    existingPaths.add(p('/Users/testuser/.cline/workspaces'));
    existingPaths.add(p('/Users/testuser/.cline/workspaces/proj1'));
    existingPaths.add(p('/Users/testuser/.cline/workspaces/proj1/MyApp'));

    const result = extractProjectName('-Users-testuser--cline-workspaces-proj1-MyApp');
    expect(result).toBe('MyApp');
  });

  it('returns last segment as fallback when no filesystem matches', () => {
    // No paths exist in the mock
    const result = extractProjectName('-some-unknown-path');
    expect(result).toBe('path');
  });

  it('caches results for repeated calls', () => {
    existingPaths.add(p('/Users'));
    existingPaths.add(p('/Users/testuser'));
    existingPaths.add(p('/Users/testuser/my-project'));

    const result1 = extractProjectName('-Users-testuser-my-project');
    const result2 = extractProjectName('-Users-testuser-my-project');
    expect(result1).toBe('my-project');
    expect(result2).toBe('my-project');
  });
});
