import { describe, expect, it } from 'vitest';
import { buildSessionAnalyticsResponse, buildSessionDetail, parseCodexTranscriptMetadata, type SessionAnalyticsIndexedSession } from '../../server/sessionAnalyticsParser.js';

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

  it('keeps model reasoning and the model response as independently readable events', () => {
    const indexed: SessionAnalyticsIndexedSession = {
      summary: sessions[0].summary,
      events: [
        { id: 'reasoning-1', timestamp: '2026-07-28T10:01:00.000Z', type: 'llm_call', model: 'claude-sonnet', summary: 'Model reasoning', contentPreview: 'I should inspect the event sequence before choosing a response.', content: 'I should inspect the event sequence before choosing a response. The reasoning must remain visible in the detail view.', contentAvailable: true },
        { id: 'response-1', timestamp: '2026-07-28T10:01:01.000Z', type: 'assistant_message', model: 'claude-sonnet', summary: 'Assistant reply', contentPreview: 'The event sequence should show requests, reasoning, actions, and responses.', content: 'The event sequence should show requests, reasoning, actions, and responses without collapsing the model response.', contentAvailable: true },
      ],
    };

    const metadata = buildSessionDetail(indexed, capabilities, '2026-07-28T10:30:00.000Z');
    expect(metadata.events).toMatchObject([
      { type: 'llm_call', summary: 'Model reasoning', contentPreview: 'I should inspect the event sequence before choosing a response.', contentAvailable: true },
      { type: 'assistant_message', summary: 'Assistant reply', contentPreview: 'The event sequence should show requests, reasoning, actions, and responses.', contentAvailable: true },
    ]);
    expect(metadata.events.every(event => event.content === undefined)).toBe(true);

    const expanded = buildSessionDetail(indexed, capabilities, '2026-07-28T10:30:00.000Z', true);
    expect(expanded.events[0]?.content).toContain('reasoning must remain visible');
    expect(expanded.events[1]?.content).toContain('without collapsing the model response');
  });

  it('keeps Codex system and runtime input context separate from canonical user requests', () => {
    const parsed = parseCodexTranscriptMetadata([
      JSON.stringify({ timestamp: '2026-08-03T00:59:59.000Z', type: 'response_item', payload: { type: 'message', role: 'system', content: [{ type: 'input_text', text: 'You are an AI coding assistant.\nKeep answers grounded in the workspace.' }] } }),
      JSON.stringify({ timestamp: '2026-08-03T00:59:59.100Z', type: 'response_item', payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: '<permissions instructions>Filesystem access is unrestricted.</permissions instructions>' }, { type: 'input_text', text: '<skills_instructions>Use applicable skills.</skills_instructions>' }] } }),
      JSON.stringify({ timestamp: '2026-08-03T01:00:00.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>injected runtime context</environment_context>' }, { type: 'input_text', text: '# AGENTS.md instructions\nDo not treat this as the user request.' }] } }),
      JSON.stringify({ timestamp: '2026-08-03T01:00:00.010Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Investigate the Hermes integration.' }] } }),
      JSON.stringify({ timestamp: '2026-08-03T01:00:00.010Z', type: 'event_msg', payload: { type: 'user_message', message: 'Investigate the Hermes integration.' } }),
      JSON.stringify({ timestamp: '2026-08-03T01:00:04.000Z', type: 'event_msg', payload: { type: 'agent_message', phase: 'commentary', message: 'I will inspect the current configuration first.' } }),
      JSON.stringify({ timestamp: '2026-08-03T01:00:08.000Z', type: 'event_msg', payload: { type: 'agent_message', phase: 'final_answer', message: 'The Hermes integration is ready.' } }),
    ].join('\n'));

    expect(parsed.userTurns).toBe(1);
    expect(parsed.title).toBe('Investigate the Hermes integration.');
    expect(parsed.events).toMatchObject([
      { type: 'input_context', inputKind: 'system', contextLabel: 'System prompt', contentPreview: 'You are an AI coding assistant.\nKeep answers grounded in the workspace.', contentAvailable: true },
      { type: 'input_context', inputKind: 'developer', contextLabel: 'Permissions', contentPreview: '<permissions instructions>Filesystem access is unrestricted.</permissions instructions>', contentAvailable: true },
      { type: 'input_context', inputKind: 'developer', contextLabel: 'Skills', contentPreview: '<skills_instructions>Use applicable skills.</skills_instructions>', contentAvailable: true },
      { type: 'input_context', inputKind: 'runtime', contextLabel: 'Environment', contentPreview: '<environment_context>injected runtime context</environment_context>', contentAvailable: true },
      { type: 'input_context', inputKind: 'runtime', contextLabel: 'AGENTS.md instructions', contentPreview: '# AGENTS.md instructions\nDo not treat this as the user request.', contentAvailable: true },
      { type: 'user_message', summary: 'User request', contentPreview: 'Investigate the Hermes integration.', contentAvailable: true },
      { type: 'assistant_message', phase: 'commentary', summary: 'Agent update', contentPreview: 'I will inspect the current configuration first.' },
      { type: 'assistant_message', phase: 'final_answer', summary: 'Final response', contentPreview: 'The Hermes integration is ready.' },
    ]);
  });

  it('infers one Codex Skill use per task from execution that reads its SKILL.md', () => {
    const parsed = parseCodexTranscriptMetadata([
      JSON.stringify({ timestamp: '2026-08-03T01:00:00.000Z', type: 'event_msg', payload: { type: 'user_message', message: 'Implement the dashboard change.' } }),
      JSON.stringify({ timestamp: '2026-08-03T01:00:01.000Z', type: 'response_item', payload: { type: 'custom_tool_call', call_id: 'call-read-1', name: 'exec', input: 'const r = await tools.exec_command({ cmd: "sed -n \'1,160p\' /Users/alice/.agents/skills/implement/SKILL.md" });' } }),
      JSON.stringify({ timestamp: '2026-08-03T01:00:02.000Z', type: 'response_item', payload: { type: 'custom_tool_call', call_id: 'call-read-2', name: 'exec', input: 'const r = await tools.exec_command({ cmd: "sed -n \'161,320p\' /Users/alice/.agents/skills/implement/SKILL.md" });' } }),
      JSON.stringify({ timestamp: '2026-08-03T01:00:03.000Z', type: 'response_item', payload: { type: 'custom_tool_call', call_id: 'call-edit', name: 'exec', input: 'const patch = "*** Update File: /work/project/SKILL.md"; await tools.apply_patch(patch);' } }),
      JSON.stringify({ timestamp: '2026-08-03T01:00:04.000Z', type: 'response_item', payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: '<skills_instructions>Available skill: frontend-design at /Users/alice/.agents/skills/frontend-design/SKILL.md</skills_instructions>' }] } }),
      JSON.stringify({ timestamp: '2026-08-03T01:01:00.000Z', type: 'event_msg', payload: { type: 'user_message', message: 'Apply the same implementation workflow to the next task.' } }),
      JSON.stringify({ timestamp: '2026-08-03T01:01:01.000Z', type: 'response_item', payload: { type: 'function_call', call_id: 'call-read-3', name: 'Read', arguments: JSON.stringify({ file_path: '/Users/alice/.agents/skills/implement/SKILL.md' }) } }),
    ].join('\n'));

    expect(parsed.skillCalls).toBe(2);
    expect(parsed.toolCalls).toBe(4);
    expect(parsed.events.filter(event => event.type === 'skill_call')).toMatchObject([
      { skillName: 'implement', skillOrigin: 'inferred', summary: 'Skill implement inferred from process' },
      { skillName: 'implement', skillOrigin: 'inferred', summary: 'Skill implement inferred from process' },
    ]);
    expect(parsed.events.filter(event => event.type === 'skill_call')).toHaveLength(2);
  });

  it('lets an explicit Skill call replace the same inferred use within one task', () => {
    const parsed = parseCodexTranscriptMetadata([
      JSON.stringify({ timestamp: '2026-08-03T01:00:00.000Z', type: 'event_msg', payload: { type: 'user_message', message: 'Use the implementation workflow.' } }),
      JSON.stringify({ timestamp: '2026-08-03T01:00:01.000Z', type: 'response_item', payload: { type: 'custom_tool_call', call_id: 'call-read', name: 'exec', input: 'sed -n \'1,200p\' /Users/alice/.agents/skills/implement/SKILL.md' } }),
      JSON.stringify({ timestamp: '2026-08-03T01:00:02.000Z', type: 'response_item', payload: { type: 'function_call', call_id: 'call-skill', name: 'Skill', arguments: JSON.stringify({ skill: 'implement' }) } }),
    ].join('\n'));

    expect(parsed.skillCalls).toBe(1);
    expect(parsed.toolCalls).toBe(1);
    expect(parsed.events.filter(event => event.type === 'skill_call')).toMatchObject([
      { skillName: 'implement', skillOrigin: 'explicit', summary: 'Skill implement called' },
    ]);
  });

  it('retains large input context while redacting structured secrets and home-directory usernames', () => {
    const longBody = 'x'.repeat(13_000);
    const parsed = parseCodexTranscriptMetadata(JSON.stringify({
      timestamp: '2026-08-03T01:00:00.000Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'developer',
        content: [{ type: 'input_text', text: `<skills_instructions>\napiKey: "secret-value"\n<password>another-secret</password>\n"private_key": "json-private-key"\n<private_key>xml-private-key</private_key>\npath: /Users/alice/project\n${longBody}\n</skills_instructions>` }],
      },
    }));

    const context = parsed.events[0];
    expect(context).toMatchObject({ type: 'input_context', contextLabel: 'Skills', contentAvailable: true });
    expect(context?.content?.length).toBeGreaterThan(12_000);
    expect(context?.content).toContain('apiKey: [redacted]');
    expect(context?.content).toContain('<password>[redacted]</password>');
    expect(context?.content).toContain('"private_key": [redacted]');
    expect(context?.content).toContain('<private_key>[redacted]</private_key>');
    expect(context?.content).toContain('/Users/[user]/project');
    expect(context?.content).not.toContain('secret-value');
    expect(context?.content).not.toContain('another-secret');
    expect(context?.content).not.toContain('json-private-key');
    expect(context?.content).not.toContain('xml-private-key');
    expect(context?.content).not.toContain('/Users/alice');
  });
});
