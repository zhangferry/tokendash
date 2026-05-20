import { describe, it, expect } from 'vitest';
import { normalizeToolName, computeAnalytics } from '../../server/analyticsParser.js';
import type { AnalyticsResponse } from '../../shared/types.js';

describe('normalizeToolName', () => {
  it('maps exec to Bash', () => {
    expect(normalizeToolName('exec')).toBe('Bash');
  });

  it('maps read to Read', () => {
    expect(normalizeToolName('read')).toBe('Read');
  });

  it('maps edit to Edit', () => {
    expect(normalizeToolName('edit')).toBe('Edit');
  });

  it('maps write to Write', () => {
    expect(normalizeToolName('write')).toBe('Write');
  });

  it('normalizes MCP tools by server name', () => {
    expect(normalizeToolName('mcp__plugin__oh-my')).toBe('MCP:oh-my');
  });

  it('handles MCP with fewer parts', () => {
    expect(normalizeToolName('mcp__server')).toBe('MCP:mcp');
  });

  it('preserves unknown tool names', () => {
    expect(normalizeToolName('Grep')).toBe('Grep');
    expect(normalizeToolName('TaskUpdate')).toBe('TaskUpdate');
  });
});

describe('computeAnalytics', () => {
  const toolCalls = [
    { toolName: 'Edit', timestamp: new Date('2026-04-15T08:00:00Z').getTime(), filePath: '/a.ts', linesAdded: 10, linesDeleted: 5 },
    { toolName: 'Edit', timestamp: new Date('2026-04-15T10:00:00Z').getTime(), filePath: '/b.ts', linesAdded: 3, linesDeleted: 1 },
    { toolName: 'Read', timestamp: new Date('2026-04-15T09:00:00Z').getTime(), filePath: '/a.ts', linesAdded: 0, linesDeleted: 0 },
    { toolName: 'Bash', timestamp: new Date('2026-04-15T11:00:00Z').getTime(), linesAdded: 0, linesDeleted: 0 },
    { toolName: 'Write', timestamp: new Date('2026-04-16T01:00:00Z').getTime(), filePath: '/c.ts', linesAdded: 20, linesDeleted: 0 },
    { toolName: 'Edit', timestamp: new Date('2026-04-16T02:00:00Z').getTime(), filePath: '/a.ts', linesAdded: 5, linesDeleted: 3 },
  ];

  let result: AnalyticsResponse;

  beforeAll(() => {
    result = computeAnalytics(toolCalls, 'UTC');
  });

  it('computes code change trend by date', () => {
    const trend = result.codeChangeTrend;
    // UTC timezone: Apr 15 and Apr 16
    const apr15 = trend.find(t => t.date === '2026-04-15')!;
    const apr16 = trend.find(t => t.date === '2026-04-16')!;

    expect(apr15.linesAdded).toBe(13);   // 10 + 3
    expect(apr15.linesDeleted).toBe(6);  // 5 + 1
    expect(apr15.netChange).toBe(7);     // 13 - 6
    expect(apr15.filesModified).toBe(2); // /a.ts, /b.ts

    expect(apr16.linesAdded).toBe(25);   // 20 + 5
    expect(apr16.linesDeleted).toBe(3);  // 0 + 3
    expect(apr16.netChange).toBe(22);
    expect(apr16.filesModified).toBe(2); // /c.ts, /a.ts
  });

  it('computes tool usage distribution sorted descending', () => {
    const dist = result.toolUsageDistribution;
    expect(dist[0].name).toBe('Edit');
    expect(dist[0].count).toBe(3);
    expect(dist.find(t => t.name === 'Bash')!.count).toBe(1);
    expect(dist.find(t => t.name === 'Read')!.count).toBe(1);
    expect(dist.find(t => t.name === 'Write')!.count).toBe(1);
  });

  it('computes productivity KPIs', () => {
    const kpis = result.productivityKPIs;
    // 4 edit/write calls total: 3 Edit + 1 Write
    expect(kpis.totalEdits).toBe(4);
    // total lines changed: (10+5) + (3+1) + (20+0) + (5+3) = 47
    // avg = 47 / 4 = 11.75 → 12 (rounded)
    expect(kpis.avgLinesPerEdit).toBe(12);
    // unique files: /a.ts, /b.ts, /c.ts = 3
    expect(kpis.totalFilesModified).toBe(3);
    // 2 active days
    expect(kpis.activeDaysWithEdits).toBe(2);
    // files per day: 3 / 2 = 1.5 → 2 (rounded)
    expect(kpis.filesModifiedPerDay).toBe(2);
  });

  it('computes tool call trend by date', () => {
    const trend = result.toolCallTrend;
    const apr15 = trend.find(t => t.date === '2026-04-15')!;
    const apr16 = trend.find(t => t.date === '2026-04-16')!;

    expect(apr15.Edit).toBe(2);
    expect(apr15.Read).toBe(1);
    expect(apr15.Bash).toBe(1);

    expect(apr16.Write).toBe(1);
    expect(apr16.Edit).toBe(1);
  });

  it('fills missing tool values with 0 in tool call trend', () => {
    // Create tool calls where different tools appear on different days
    const sparseToolCalls = [
      { toolName: 'Edit', timestamp: new Date('2026-05-01T08:00:00Z').getTime(), linesAdded: 5, linesDeleted: 2 },
      { toolName: 'Read', timestamp: new Date('2026-05-01T09:00:00Z').getTime(), linesAdded: 0, linesDeleted: 0 },
      // Day 2: only Edit, no Read
      { toolName: 'Edit', timestamp: new Date('2026-05-02T08:00:00Z').getTime(), linesAdded: 3, linesDeleted: 1 },
      // Day 3: only Read, no Edit
      { toolName: 'Read', timestamp: new Date('2026-05-03T09:00:00Z').getTime(), linesAdded: 0, linesDeleted: 0 },
    ];
    const res = computeAnalytics(sparseToolCalls, 'UTC');
    const trend = res.toolCallTrend;
    expect(trend).toHaveLength(3);

    // Every day should have both Edit and Read (not undefined)
    for (const entry of trend) {
      expect(entry.Edit).toBeDefined();
      expect(entry.Read).toBeDefined();
      expect(typeof entry.Edit).toBe('number');
      expect(typeof entry.Read).toBe('number');
    }

    const day1 = trend.find(t => t.date === '2026-05-01')!;
    const day2 = trend.find(t => t.date === '2026-05-02')!;
    const day3 = trend.find(t => t.date === '2026-05-03')!;

    expect(day1.Edit).toBe(1);
    expect(day1.Read).toBe(1);
    expect(day2.Edit).toBe(1);
    expect(day2.Read).toBe(0); // Read not used on day 2, should be 0
    expect(day3.Edit).toBe(0); // Edit not used on day 3, should be 0
    expect(day3.Read).toBe(1);
  });
});
