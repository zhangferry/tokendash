import { useState } from 'react';

import { formatPercent, formatTokens } from '../format.js';
import type { ModelRow, TodaySummary } from '../types.js';

type Mode = 'model' | 'type';

interface UsageSectionProps {
  summary: TodaySummary | null;
  models: ModelRow[];
}

/** Model colour mapping mirrors the macOS build: Opus blue, Haiku amber, everything else green. */
function modelColor(name: string): string {
  const lower = name.toLowerCase();
  if (lower.includes('opus')) return 'var(--output-color)';
  if (lower.includes('haiku')) return 'var(--cached-color)';
  return 'var(--accent)';
}

interface BarProps {
  color: string;
  label: string;
  value: string;
  pct: number;
}

function Bar({ color, label, value, pct }: BarProps) {
  return (
    <div className="bar-row">
      <span className="bar-dot" style={{ background: color }} />
      <span className="bar-label" title={label}>
        {label}
      </span>
      <span className="bar-track">
        <span className="bar-fill" style={{ background: color, width: `${Math.max(2, pct * 100)}%` }} />
      </span>
      <span className="bar-value mono-num">{value}</span>
      <span className="bar-pct mono-num">{formatPercent(pct * 100)}</span>
    </div>
  );
}

export function UsageSection({ summary, models }: UsageSectionProps) {
  const [mode, setMode] = useState<Mode>('model');

  const modelTotal = Math.max(
    models.reduce((total, row) => total + row.tokens, 0),
    1,
  );
  const typeTotal = summary
    ? Math.max(summary.inputTokens + summary.outputTokens + summary.cacheReadTokens + (summary.cacheWriteTokens ?? 0), 1)
    : 1;

  return (
    <div className="section">
      <div className="section-head">
        <span className="section-title">Usage</span>
        <div className="segmented">
          <button type="button" className={mode === 'model' ? 'active' : ''} onClick={() => setMode('model')}>
            Model
          </button>
          <button type="button" className={mode === 'type' ? 'active' : ''} onClick={() => setMode('type')}>
            Type
          </button>
        </div>
      </div>

      {mode === 'model' ? (
        models.length === 0 ? (
          <div className="empty">No model usage today.</div>
        ) : (
          <div className="bar-rows">
            {models.map((row) => (
              <Bar
                key={row.name}
                color={modelColor(row.name)}
                label={row.name}
                value={formatTokens(row.tokens)}
                pct={row.tokens / modelTotal}
              />
            ))}
          </div>
        )
      ) : summary ? (
        <div className="bar-rows">
          <Bar
            color="var(--input-color)"
            label="Input"
            value={formatTokens(summary.inputTokens)}
            pct={summary.inputTokens / typeTotal}
          />
          <Bar
            color="var(--output-color)"
            label="Output"
            value={formatTokens(summary.outputTokens)}
            pct={summary.outputTokens / typeTotal}
          />
          <Bar
            color="var(--cached-color)"
            label="Cached"
            value={formatTokens(summary.cacheReadTokens)}
            pct={summary.cacheReadTokens / typeTotal}
          />
          {(summary.cacheWriteTokens ?? 0) > 0 && <Bar color="var(--cached-color)" label="Cache write" value={formatTokens(summary.cacheWriteTokens ?? 0)} pct={(summary.cacheWriteTokens ?? 0) / typeTotal} />}
        </div>
      ) : (
        <div className="empty">No usage yet.</div>
      )}
    </div>
  );
}