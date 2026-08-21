import { requestJson } from '$lib/client/request';
import { queryCache, type QuerySubscriber } from '$lib/client/query-cache';
import type { ListeningPort, ListeningPortsResponse } from './listening-ports';

export const LISTENING_PORTS_QUERY = 'system/listening-ports';

export function getCachedListeningPorts(): ListeningPort[] | undefined {
  return queryCache.get<ListeningPortsResponse>(LISTENING_PORTS_QUERY)?.ports;
}

function loadListeningPorts(force = false): Promise<ListeningPortsResponse> {
  return queryCache.fetch(
    LISTENING_PORTS_QUERY,
    () =>
      requestJson<ListeningPortsResponse>(
        '/api/system/ports',
        { cache: 'no-store' },
        'Unable to inspect listening ports.'
      ),
    force
  );
}

export function refreshListeningPorts(): Promise<ListeningPortsResponse> {
  return loadListeningPorts(true);
}

export function refreshListeningPortsAfterMutation(): Promise<ListeningPortsResponse> {
  queryCache.invalidate(LISTENING_PORTS_QUERY);
  return loadListeningPorts(true);
}

export function subscribeListeningPorts(
  subscriber: QuerySubscriber<ListeningPortsResponse>
): () => void {
  return queryCache.subscribe<ListeningPortsResponse>(LISTENING_PORTS_QUERY, subscriber);
}

export { loadListeningPorts };
