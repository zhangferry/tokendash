import { expect, it } from 'vitest';
import { claudeUsageLines } from '../../server/claudeUsageLines.js';

it('selects growing snapshots, preserves distinct requests and anonymous rows', () => {
  const rows = [
    ['s', 'a', 3], ['s', 'a', 2055], ['s', 'a', 3],
    ['s', 'b', 2055], ['other', 'a', 2055], ['s', '', 1], ['s', '', 1],
  ].map(([sessionId, id, output_tokens]) => JSON.stringify({
    type: 'assistant', sessionId, message: { id, usage: { output_tokens } },
  }));
  expect([...claudeUsageLines(rows)]).toEqual([1, 3, 4, 5, 6]);
});

it('identical snapshots count once, different request IDs remain distinct', () => {
  const row = (requestId: string) => JSON.stringify({type: 'assistant', requestId,
    message: {id: 'm', usage: {output_tokens: 20}}});
  expect([...claudeUsageLines([row('a'), row('a'), row('b')])]).toEqual([1, 2]);
});
