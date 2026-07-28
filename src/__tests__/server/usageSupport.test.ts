import { describe, expect, it } from 'vitest';
import { hasUsageDataSource } from '../../server/index.js';

describe('hasUsageDataSource', () => {
  it.each(['claude', 'codex', 'openclaw', 'opencode', 'pi'])('accepts a %s-only installation', (availableAgent) => {
    expect(hasUsageDataSource({
      claude: availableAgent === 'claude',
      codex: availableAgent === 'codex',
      openclaw: availableAgent === 'openclaw',
      opencode: availableAgent === 'opencode',
      pi: availableAgent === 'pi',
    })).toBe(true);
  });

  it('rejects an installation with no supported usage source', () => {
    expect(hasUsageDataSource({ claude: false, codex: false, openclaw: false, opencode: false, pi: false })).toBe(false);
  });
});
