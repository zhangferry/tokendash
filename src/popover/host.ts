import type { DesktopSettings } from './types.js';

interface TauriGlobal {
  core: { invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown> };
  event: { listen: (event: string, handler: (event: { payload: unknown }) => void) => Promise<() => void> };
}

function host(): TauriGlobal | null {
  const value = (window as unknown as { __TAURI__?: TauriGlobal }).__TAURI__;
  return value ?? null;
}

/** True inside the Tauri shell. False when the panel page is previewed in a plain browser. */
export function isHosted(): boolean {
  return host() !== null;
}

export function invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const api = host();
  if (!api) {
    return Promise.reject(new Error(`The panel must run in the desktop app to call ${command}`));
  }
  return api.core.invoke(command, args) as Promise<T>;
}

export function onHostEvent(event: string, handler: (payload: unknown) => void): void {
  const api = host();
  if (!api) return;
  void api.event.listen(event, (message) => handler(message.payload));
}

export function loadSettings(): Promise<DesktopSettings> {
  return invoke<DesktopSettings>('get_desktop_settings');
}

export function saveSettings(settings: DesktopSettings): Promise<DesktopSettings> {
  return invoke<DesktopSettings>('save_desktop_settings', { settings });
}

export function configuredProviders(): Promise<string[]> {
  return invoke<string[]>('get_configured_providers');
}

export function saveCredential(provider: string, apiKey: string, baseUrl?: string): Promise<void> {
  return invoke<void>('save_credential', { provider, apiKey, baseUrl: baseUrl ?? null });
}

export function deleteCredential(provider: string): Promise<void> {
  return invoke<void>('delete_credential', { provider });
}

export function setPopoverHeight(height: number): Promise<void> {
  return invoke<void>('set_popover_height', { height });
}

export function hidePopover(): Promise<void> {
  return invoke<void>('hide_popover');
}

export function openDashboard(): Promise<void> {
  return invoke<void>('open_dashboard');
}

export function openExternal(url: string): Promise<void> {
  return invoke<void>('open_external', { url });
}

export function notify(title: string, body: string): Promise<void> {
  return invoke<void>('notify', { title, body });
}