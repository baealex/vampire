import type { Provider } from './types.js';
import { claudeProvider } from './claude.js';

const providers = new Map<string, Provider>();

providers.set('claude', claudeProvider);

export function getProvider(name: string): Provider {
    const provider = providers.get(name);
    if (!provider) throw new Error(`Unknown provider: ${name}`);
    return provider;
}

interface ProviderListItem {
    name: string;
    displayName: string;
    comingSoon?: boolean;
}

const comingSoonProviders: ProviderListItem[] = [
    { name: 'gemini', displayName: 'Gemini CLI', comingSoon: true },
    { name: 'codex', displayName: 'Codex', comingSoon: true },
];

export function listProviders(): ProviderListItem[] {
    const active: ProviderListItem[] = Array.from(providers.values()).map(p => ({
        name: p.info.name,
        displayName: p.info.displayName,
    }));
    return [...active, ...comingSoonProviders];
}

export const DEFAULT_PROVIDER = 'claude';
