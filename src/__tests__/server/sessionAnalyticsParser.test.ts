import { describe, expect, it } from 'vitest';
import { buildSessionAnalyticsResponse, buildSessionDetail, type SessionAnalyticsIndexedSession } from '../../server/sessionAnalyticsParser.js';

const capabilities = {
  userTurns: true,
  skills: false,
  tools: true,
  toolResults: true,
  contentPreview: false,
};

const sessions: SessionAnalyticsIndexedSession[] = [
  {
    summary: {
      id: 'session-a', agent: 'claude', project: 'app', startedAt: '2026-07-28T10:00:00.000Z', endedAt: '2026-07-28T10:10:00.000Z', status: 'unknown', models: ['claude-sonnet'], llmCallCount: 2, toolCallCount: 1, userTurnCount: 3, durationMs: 600_000, totalTokens: 1_200, totalCost: 0.02,
    },
    events: [
      { id: 'llm-1', timestamp: '2026-07-28T10:01:00.000Z', type: 'llm_call', model: 'claude-sonnet', contentAvailable: false },
      { id: 'llm-2', timestamp: '2026-07-28T10:02:00.000Z', type: 'llm_call', model: 'claude-sonnet', contentAvailable: false },
      { id: 'tool-1', timestamp: '2026-07-28T10:03:00.000Z', type: 'tool_call', toolName: 'Bash', contentAvailable: false },
      { id: 'result-1', timestamp: '2026-07-28T10:03:01.000Z', type: 'tool_result', success: true, contentAvailable: false },
    ],
  },
  {
    summary: {
      id: 'session-b', agent: 'claude', project: 'app', startedAt: '2026-07-29T10:00:00.000Z', endedAt: '2026-07-29T10:30:00.000Z', status: 'unknown', models: ['claude-opus'], llmCallCount: 1, toolCallCount: 2, userTurnCount: 13, durationMs: 1_800_000, totalTokens: 2_400, totalCost: 0.06,
    },
    events: [
      { id: 'llm-3', timestamp: '2026-07-29T10:01:00.000Z', type: 'llm_call', model: 'claude-opus', contentAvailable: false },
      { id: 'tool-2', timestamp: '2026-07-29T10:02:00.000Z', type: 'tool_call', toolName: 'Read', contentAvailable: false },
      { id: 'tool-3', timestamp: '2026-07-29T10:03:00.000Z', type: 'tool_call', toolName: 'Read', contentAvailable: false },
      { id: 'result-2', timestamp: '2026-07-29T10:03:01.000Z', type: 'tool_result', success: false, contentAvailable: false },
    ],
  },
];

describe('buildSessionAnalyticsResponse', () => {
  it('aggregates metadata while preserving unavailable Skill semantics', () => {
    const result = buildSessionAnalyticsResponse(sessions, capabilities, { range: 'all', limit: 1 });

    expect(result.summary).toMatchObject({
      sessionCount: 2,
      llmCallCount: 3,
      toolCallCount: 3,
      avgUserTurnCount: 8,
      longSessionRate: 50,
      toolSuccessRate: 50,
    });
    expect(result.summary.skillCallCount).toBeUndefined();
    expect(result.toolDistribution).toEqual([{ name: 'Read', count: 2 }, { name: 'Bash', count: 1 }]);
    expect(result.skillDistribution).toBeUndefined();
    expect(result.llmCallTrend).toContainEqual(expect.objectContaining({ date: '2026-07-28', models: { 'claude-sonnet': 2 } }));
    expect(result.userTurnDistribution.find(entry => entry.bucket === '13+')).toMatchObject({ sessionCount: 1, percentage: 50 });
    expect(result.sessions).toHaveLength(1);
    expect(result.pagination).toMatchObject({ totalCount: 2, nextCursor: expect.any(String) });
  });

  it('keeps explicit Skills separate from general tools and preserves safe detail metadata', () => {
    const result = buildSessionAnalyticsResponse([
      {
        summary: {
          ...sessions[0].summary,
          id: 'session-with-skill',
          title: 'Add safe session analytics details',
          description: '3 user turns · 1 tool call · 1 Skill call',
          skillCallCount: 1,
          toolCallCount: 1,
        },
        events: [
          { id: 'skill-1', timestamp: '2026-07-28T10:02:00.000Z', type: 'skill_call', skillName: 'frontend-design', summary: 'Skill frontend-design called', parameterSummary: 'Parameters { scope: “dashboard” }', contentAvailable: false },
          { id: 'tool-1', timestamp: '2026-07-28T10:03:00.000Z', type: 'tool_call', toolName: 'Bash', summary: 'Tool Bash called', parameterSummary: 'Parameters { command: “npm test”, token: [redacted] }', contentAvailable: false },
          { id: 'result-1', timestamp: '2026-07-28T10:03:01.000Z', type: 'tool_result', toolName: 'Bash', summary: 'Tool result completed', resultSummary: 'Result { exitCode: 0, stdout: 120 chars (withheld) }', success: true, contentAvailable: false },
        ],
      },
    ], { ...capabilities, skills: true }, { range: 'all' });

    expect(result.skillDistribution).toEqual([{ name: 'frontend-design', count: 1 }]);
    expect(result.toolDistribution).toEqual([{ name: 'Bash', count: 1 }]);
    expect(result.sessions[0]).toMatchObject({ title: 'Add safe session analytics details', description: '3 user turns · 1 tool call · 1 Skill call' });
    expect(result.summary).toMatchObject({ skillCallCount: 1, toolCallCount: 1 });
  });

  it('does not invent unavailable metrics for metadata-only sources', () => {
    const result = buildSessionAnalyticsResponse([sessions[0]], { ...capabilities, userTurns: false, tools: false, toolResults: false }, { range: 'all' });

    expect(result.summary.avgUserTurnCount).toBeUndefined();
    expect(result.summary.toolSuccessRate).toBeUndefined();
    expect(result.userTurnDistribution).toEqual([]);
    expect(result.capabilities).toMatchObject({ userTurns: false, tools: false });
  });

  it('returns a safe preview by default and only includes event bodies on explicit request', () => {
    const indexed: SessionAnalyticsIndexedSession = {
      summary: sessions[0].summary,
      events: [{
        id: 'user-1', timestamp: '2026-07-28T10:00:00.000Z', type: 'user_message', summary: 'User request', contentPreview: 'Build a readable session detail.', content: 'Build a readable session detail with on-demand source text.', contentAvailable: true,
      }],
    };

    const metadata = buildSessionDetail(indexed, capabilities, '2026-07-28T10:30:00.000Z');
    expect(metadata.capabilities.contentPreview).toBe(true);
    expect(metadata.events[0]).toMatchObject({ contentPreview: 'Build a readable session detail.', contentAvailable: true });
    expect(metadata.events[0]?.content).toBeUndefined();

    const expanded = buildSessionDetail(indexed, capabilities, '2026-07-28T10:30:00.000Z', true);
    expect(expanded.events[0]?.content).toBe('Build a readable session detail with on-demand source text.');
  });
});
