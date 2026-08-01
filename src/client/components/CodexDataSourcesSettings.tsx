import { useEffect, useMemo, useState } from 'react';
import { fetchSettings, updateCodexDataPaths } from '../api/client.js';
import type { AppSettingsResponse, CodexDataPathStatus } from '../../shared/types.js';

interface CodexDataSourcesSettingsProps {
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
}

function splitPathDraft(value: string): string[] {
  return value
    .split(/[\n,]/)
    .map(part => part.trim())
    .filter(Boolean);
}

function sourceLabel(kind: CodexDataPathStatus['kind']): string {
  if (kind === 'official') return 'Official';
  if (kind === 'environment') return 'Environment';
  return 'Custom';
}

/** Modal for configuring extra Codex-compatible data sources. */
export function CodexDataSourcesSettings({ open, onClose, onSaved }: CodexDataSourcesSettingsProps) {
  const [settings, setSettings] = useState<AppSettingsResponse | null>(null);
  const [draft, setDraft] = useState('');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    setSaving(false);
    setError(null);
    setSaved(false);
    fetchSettings()
      .then(next => {
        setSettings(next);
        setDraft(next.codex.customDataPaths.join('\n'));
      })
      .catch(err => setError(err instanceof Error ? err.message : 'Failed to load settings'))
      .finally(() => setLoading(false));
  }, [open]);

  const draftPaths = useMemo(() => splitPathDraft(draft), [draft]);

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const next = await updateCodexDataPaths(draftPaths);
      setSettings(next);
      setDraft(next.codex.customDataPaths.join('\n'));
      setSaved(true);
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save settings');
    } finally {
      setSaving(false);
    }
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-stone-950/30 px-4 backdrop-blur-sm" role="dialog" aria-modal="true" aria-label="Codex data source settings">
      <div className="w-full max-w-2xl rounded-2xl bg-white shadow-[0_24px_80px_rgba(28,25,23,0.22)] border border-stone-200/70">
        <div className="flex items-start justify-between gap-4 border-b border-stone-100 px-6 py-5">
          <div>
            <h2 className="text-lg font-extrabold tracking-tight text-stone-900">Codex data sources</h2>
            <p className="mt-1 text-[13px] font-medium leading-relaxed text-stone-500">
              TokenDash scans official Codex data by default. Add compatible custom homes or transcript folders for non-official clients.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1.5 text-stone-400 transition-colors hover:bg-stone-100 hover:text-stone-700"
            aria-label="Close settings"
          >
            <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18 18 6M6 6l12 12" /></svg>
          </button>
        </div>

        <div className="px-6 py-5">
          {loading ? (
            <div className="flex h-48 items-center justify-center text-[13px] font-medium text-stone-400">Loading settings…</div>
          ) : (
            <div className="space-y-5">
              <div>
                <label className="text-[12px] font-bold uppercase tracking-wider text-stone-400">Custom paths</label>
                <textarea
                  value={draft}
                  onChange={e => { setDraft(e.target.value); setSaved(false); }}
                  placeholder={'/Users/me/.some-codex-home\n/Users/me/.some-codex-home/sessions'}
                  spellCheck={false}
                  className="mt-2 h-32 w-full resize-none rounded-xl border border-stone-200 bg-stone-50/60 px-3 py-2.5 font-mono text-[12px] text-stone-800 outline-none transition focus:border-indigo-400 focus:bg-white focus:ring-4 focus:ring-indigo-500/10"
                />
                <p className="mt-2 text-[12px] leading-relaxed text-stone-500">
                  One path per line. A home directory should contain <span className="font-mono">sessions/</span> or <span className="font-mono">archived_sessions/</span>; direct transcript folders are also accepted.
                </p>
              </div>

              <div className="rounded-xl border border-stone-200/70 bg-stone-50/60 p-3">
                <div className="mb-2 flex items-center justify-between">
                  <span className="text-[12px] font-bold uppercase tracking-wider text-stone-500">Resolved sources</span>
                  <span className="text-[11px] font-semibold text-stone-400">{settings?.codex.resolvedDataPaths.length ?? 0} paths</span>
                </div>
                <div className="max-h-52 space-y-2 overflow-y-auto pr-1">
                  {(settings?.codex.resolvedDataPaths ?? []).map(source => (
                    <div key={`${source.kind}:${source.path}`} className="rounded-lg bg-white px-3 py-2 shadow-sm ring-1 ring-stone-200/60">
                      <div className="flex items-center gap-2">
                        <span className={`rounded-md px-1.5 py-0.5 text-[10px] font-bold ${source.readable ? 'bg-emerald-50 text-emerald-600' : 'bg-stone-100 text-stone-500'}`}>
                          {source.readable ? 'Readable' : 'Missing'}
                        </span>
                        <span className="rounded-md bg-indigo-50 px-1.5 py-0.5 text-[10px] font-bold text-indigo-600">{sourceLabel(source.kind)}</span>
                      </div>
                      <div className="mt-1 truncate font-mono text-[11px] text-stone-700" title={source.path}>{source.path}</div>
                    </div>
                  ))}
                </div>
              </div>

              {error && <div className="rounded-lg bg-red-50 px-3 py-2 text-[12px] font-medium text-red-600">{error}</div>}
              {saved && <div className="rounded-lg bg-emerald-50 px-3 py-2 text-[12px] font-medium text-emerald-700">Saved. Dashboard data is refreshing from the configured sources.</div>}
            </div>
          )}
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-stone-100 px-6 py-4">
          <div className="text-[11px] font-medium text-stone-400">
            {draftPaths.length === 0 ? 'No custom paths configured.' : `${draftPaths.length} custom path${draftPaths.length === 1 ? '' : 's'} in draft.`}
          </div>
          <div className="flex items-center gap-2">
            <button type="button" onClick={onClose} className="rounded-lg px-3 py-2 text-[12px] font-bold text-stone-500 hover:bg-stone-100">Cancel</button>
            <button
              type="button"
              onClick={() => { void handleSave(); }}
              disabled={loading || saving}
              className="rounded-lg bg-stone-900 px-4 py-2 text-[12px] font-bold text-white shadow-sm transition hover:bg-stone-800 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {saving ? 'Saving…' : 'Save paths'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
