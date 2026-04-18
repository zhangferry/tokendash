import { describe, it, expect } from 'vitest';
import { validateBlocks, validateDaily, validateAnalytics } from '../../shared/schemas.js';

describe('BlocksResponseSchema', () => {
  it('validates a complete blocks response', () => {
    const data = {
      blocks: [{
        id: 'test-1',
        startTime: '2026-04-15T10:00:00',
        endTime: '2026-04-15T10:59:59',
        actualEndTime: null,
        isActive: false,
        isGap: false,
        entries: 1,
        tokenCounts: {
          inputTokens: 1000,
          outputTokens: 500,
          cacheCreationInputTokens: 100,
          cacheReadInputTokens: 2000,
        },
        totalTokens: 3500,
        costUSD: 0.05,
        models: ['claude-sonnet-4-6'],
      }],
    };
    const result = validateBlocks(data);
    expect(result.blocks).toHaveLength(1);
    expect(result.blocks[0].totalTokens).toBe(3500);
    expect(result.blocks[0].costUSD).toBe(0.05);
  });

  it('applies defaults for missing optional fields', () => {
    const data = {
      blocks: [{
        id: 'test-2',
        startTime: '2026-04-15T10:00:00',
        endTime: '2026-04-15T10:59:59',
        tokenCounts: {
          inputTokens: 100,
          outputTokens: 50,
        },
        totalTokens: 150,
      }],
    };
    const result = validateBlocks(data);
    expect(result.blocks[0].costUSD).toBe(0);
    expect(result.blocks[0].isGap).toBe(false);
    expect(result.blocks[0].models).toEqual([]);
  });

  it('returns empty blocks array when omitted', () => {
    const result = validateBlocks({});
    expect(result.blocks).toEqual([]);
  });
});

describe('DailyResponseSchema', () => {
  it('validates daily response with model breakdowns', () => {
    const data = {
      daily: [{
        date: '2026-04-15',
        inputTokens: 1000,
        outputTokens: 500,
        cacheCreationTokens: 100,
        cacheReadTokens: 2000,
        totalTokens: 3500,
        totalCost: 0.05,
        modelsUsed: ['claude-sonnet-4-6'],
        modelBreakdowns: [{
          modelName: 'claude-sonnet-4-6',
          inputTokens: 1000,
          outputTokens: 500,
          cost: 0.05,
        }],
      }],
      totals: {
        inputTokens: 1000,
        outputTokens: 500,
        cacheCreationTokens: 100,
        cacheReadTokens: 2000,
        totalTokens: 3500,
        totalCost: 0.05,
      },
    };
    const result = validateDaily(data);
    expect(result.daily).toHaveLength(1);
    expect(result.daily[0].modelBreakdowns[0].cacheReadTokens).toBe(0); // default
  });
});

describe('AnalyticsResponseSchema', () => {
  it('validates analytics with dynamic tool keys in toolCallTrend', () => {
    const data = {
      codeChangeTrend: [
        { date: '2026-04-15', linesAdded: 10, linesDeleted: 5, netChange: 5, filesModified: 2 },
      ],
      toolUsageDistribution: [
        { name: 'Edit', count: 5 },
      ],
      productivityKPIs: {
        avgLinesPerEdit: 10,
        filesModifiedPerDay: 3,
        addDeleteRatio: 2.5,
        totalEdits: 50,
        totalFilesModified: 10,
        activeDaysWithEdits: 7,
      },
      toolCallTrend: [
        { date: '2026-04-15', Edit: 5, Bash: 3, Read: 2 },
      ],
    };
    const result = validateAnalytics(data);
    expect(result.toolCallTrend[0].Edit).toBe(5);
    expect(result.codeChangeTrend[0].filesModified).toBe(2);
  });
});
