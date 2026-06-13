/**
 * Quota module entry point.
 *
 * Builds the singleton adapter registry + service. The rest of the server
 * imports `quotaService` from here; adapters are wired in registration order,
 * which becomes the dashboard display order.
 */
import { QuotaAdapterRegistry } from './adapter.js';
import { QuotaCache } from './cache.js';
import { QuotaService } from './quotaService.js';
import { codexAdapter } from './adapters/codex.js';
import { claudeAdapter } from './adapters/claude.js';
import { glmAdapter } from './adapters/glm.js';
import { minimaxAdapter } from './adapters/minimax.js';
import { kimiAdapter } from './adapters/kimi.js';

export type { QuotaSnapshot, QuotaWindow, QuotaProviderStatus, QuotaResponse, QuotaProviderId } from './types.js';

const registry = new QuotaAdapterRegistry();
registry.register(claudeAdapter);
registry.register(codexAdapter);
registry.register(glmAdapter);
registry.register(minimaxAdapter);
registry.register(kimiAdapter);

export const quotaCache = new QuotaCache();
export const quotaService = new QuotaService(registry, quotaCache);
