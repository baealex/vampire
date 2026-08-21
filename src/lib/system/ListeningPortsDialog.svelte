<script lang="ts">
import { onDestroy, onMount } from 'svelte';
import RefreshCw from '@lucide/svelte/icons/refresh-cw';
import Search from '@lucide/svelte/icons/search';
import ConfirmDialog from '$lib/ConfirmDialog.svelte';
import type { QuerySnapshot } from '$lib/client/query-cache';
import { requestJson } from '$lib/client/request';
import DialogShell from '$lib/ui/DialogShell.svelte';
import {
  getCachedListeningPorts,
  refreshListeningPorts,
  refreshListeningPortsAfterMutation,
  subscribeListeningPorts,
} from './listening-ports-client';
import type { ListeningPort, ListeningPortsResponse, TerminateListeningProcessRequest } from './listening-ports';

let { close }: { close: () => void } = $props();

const initialPorts = getCachedListeningPorts();
let ports = $state<ListeningPort[]>(initialPorts ?? []);
let hasData = $state(initialPorts !== undefined);
let loading = $state(initialPorts === undefined);
let fetching = $state(false);
let stopping = $state(false);
let errorMessage = $state('');
let statusMessage = $state('');
let filter = $state('');
let confirming = $state<ListeningPort | undefined>(undefined);
const filteredPorts = $derived.by(() => {
  const query = filter.trim().toLocaleLowerCase();
  if (!query) return ports;
  return ports.filter((listener) =>
    [
      String(listener.port),
      listener.processName ?? '',
      listener.pid === null ? '' : String(listener.pid),
      listener.cwd ?? '',
      ...listener.addresses,
    ].some((value) => value.toLocaleLowerCase().includes(query))
  );
});

function processLabel(listener: ListeningPort): string {
  return listener.processName || (listener.pid === null ? 'Unknown process' : `Process ${listener.pid}`);
}

function addressLabel(addresses: string[]): string {
  const wildcard = new Set(['*', '0.0.0.0', '::']);
  const loopback = new Set(['127.0.0.1', '::1']);
  if (addresses.every((address) => wildcard.has(address))) return 'All interfaces';
  if (addresses.every((address) => loopback.has(address))) return 'Localhost';
  return addresses.join(', ');
}

function terminationLabel(listener: ListeningPort): string {
  if (listener.termination === 'protected') return 'Protected';
  if (listener.termination === 'permission-denied') return 'No access';
  return 'Unavailable';
}

function terminationTitle(listener: ListeningPort): string {
  if (listener.termination === 'protected')
    return 'Vampire does not stop protected system processes or its own server.';
  if (listener.termination === 'permission-denied') return 'The Vampire server user cannot stop this process.';
  return 'Process details are unavailable, so Vampire cannot stop it safely.';
}

function confirmationDescription(listener: ListeningPort): string {
  return `Send SIGTERM to ${processLabel(listener)} (PID ${listener.pid}). This closes port ${listener.port} and any other work owned by that process.`;
}

function applyQuerySnapshot(snapshot: QuerySnapshot<ListeningPortsResponse>) {
  hasData = snapshot.data !== undefined;
  fetching = snapshot.isFetching;
  loading = !hasData && snapshot.isFetching;
  if (snapshot.data) ports = snapshot.data.ports;
  if (snapshot.error && !hasData) {
    errorMessage = snapshot.error instanceof Error ? snapshot.error.message : 'Unable to inspect listening ports.';
  } else if (!snapshot.error) {
    errorMessage = '';
  }
}

async function loadPorts(preserveStatus = false, afterMutation = false) {
  errorMessage = '';
  if (!preserveStatus) statusMessage = '';
  try {
    const response = await (afterMutation ? refreshListeningPortsAfterMutation() : refreshListeningPorts());
    ports = response.ports;
  } catch (error) {
    if (!hasData) errorMessage = error instanceof Error ? error.message : 'Unable to inspect listening ports.';
  }
}

async function stopProcess(listener: ListeningPort) {
  if (listener.pid === null || listener.termination !== 'available') return;
  stopping = true;
  const body: TerminateListeningProcessRequest = {
    port: listener.port,
    processName: listener.processName,
    cwd: listener.cwd,
  };
  try {
    await requestJson<{ ok: boolean }>(
      `/api/system/ports/${listener.pid}`,
      {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      },
      `Unable to stop ${processLabel(listener)}.`
    );
    confirming = undefined;
    statusMessage = `SIGTERM sent to ${processLabel(listener)} (PID ${listener.pid}).`;
    await new Promise((resolve) => window.setTimeout(resolve, 250));
    await loadPorts(true, true);
  } finally {
    stopping = false;
  }
}

async function confirmStop() {
  const listener = confirming;
  if (!listener) return;
  await stopProcess(listener);
}

let unsubscribe: (() => void) | undefined;

onMount(() => {
  unsubscribe = subscribeListeningPorts(applyQuerySnapshot);
  void loadPorts();
});

onDestroy(() => unsubscribe?.());
</script>

<DialogShell title="Listening ports" variant="inspect" {close}>
  {#snippet children()}
    <div class="listening-ports">
      <div class="listening-ports-toolbar">
        <label class="listening-ports-filter">
          <Search size={15} strokeWidth={1.8} aria-hidden="true" />
          <input
            type="search"
            bind:value={filter}
            aria-label="Filter listening ports"
            placeholder="Port, process, or path"
          >
        </label>
        <p aria-live="polite">
          {#if filter.trim()}
            <strong>{filteredPorts.length}</strong>
            / {ports.length}
          {:else}
            <strong>{ports.length}</strong>
            ports
          {/if}
        </p>
        <button
          type="button"
          onclick={() => void loadPorts()}
          disabled={fetching || stopping}
          aria-label="Refresh listening ports"
          title="Refresh"
        >
          <span class:spinning={loading} aria-hidden="true"><RefreshCw size={15} strokeWidth={1.9} /></span>
        </button>
      </div>

      {#if statusMessage}
        <p class="listening-ports-status" role="status">{statusMessage}</p>
      {/if}
      {#if errorMessage}
        <div class="listening-ports-error" role="alert">
          <p>{errorMessage}</p>
          <button type="button" onclick={() => void loadPorts()} disabled={fetching || stopping}>Try again</button>
        </div>
      {:else if loading && ports.length === 0}
        <p class="listening-ports-placeholder" role="status">Inspecting listening ports…</p>
      {:else if ports.length === 0}
        <p class="listening-ports-placeholder">No TCP ports are listening.</p>
      {:else if filteredPorts.length === 0}
        <p class="listening-ports-placeholder">No listening ports match “{filter.trim()}”.</p>
      {:else}
        <div class="listening-port-table">
          <div class="listening-port-columns" aria-hidden="true">
            <span>Port</span>
            <span>Process</span>
            <span>Binding</span>
            <span></span>
          </div>
          <ul class="listening-port-list" aria-label="TCP listening ports">
            {#each filteredPorts as listener (`${listener.pid ?? 'unknown'}-${listener.port}-${listener.addresses.join('-')}`)}
              <li class="listening-port-row">
                <div class="listening-port-endpoint">
                  <strong aria-label={`TCP port ${listener.port}`}>{listener.port}</strong>
                </div>
                <div class="listening-port-process">
                  <div>
                    <strong>{processLabel(listener)}</strong>
                    {#if listener.pid !== null}
                      <span>PID {listener.pid}</span>
                    {/if}
                  </div>
                  {#if listener.cwd && listener.cwd !== '/'}
                    <code title={listener.cwd}>{listener.cwd}</code>
                  {/if}
                </div>
                <span class="listening-port-binding" title={`TCP · ${listener.addresses.join(', ')}`}
                  >{addressLabel(listener.addresses)}</span
                >
                {#if listener.termination === 'available'}
                  <button
                    type="button"
                    class="listening-port-stop"
                    onclick={() => confirming = listener}
                    disabled={fetching || stopping}
                    aria-label={`Stop ${processLabel(listener)} on port ${listener.port}`}
                    title="Stop process"
                  >
                    Stop
                  </button>
                {:else}
                  <span class="listening-port-unavailable" title={terminationTitle(listener)}
                    >{terminationLabel(listener)}</span
                  >
                {/if}
              </li>
            {/each}
          </ul>
        </div>
      {/if}
    </div>
  {/snippet}
</DialogShell>

{#if confirming}
  <ConfirmDialog
    title={`Stop ${processLabel(confirming)}?`}
    description={confirmationDescription(confirming)}
    confirmLabel="Stop process"
    busyLabel="Stopping…"
    close={() => confirming = undefined}
    onConfirm={confirmStop}
  />
{/if}

<style>
.listening-ports {
  display: grid;
  min-width: 0;
  gap: 0.7rem;
}
.listening-ports-toolbar {
  display: grid;
  grid-template-columns: minmax(8rem, 1fr) auto auto;
  align-items: center;
  gap: 0.45rem;
  min-width: 0;
}
.listening-ports-toolbar p {
  min-width: 0;
  margin: 0 0.15rem;
  color: var(--color-text-tertiary);
  font-size: var(--text-caption);
  white-space: nowrap;
}
.listening-ports-toolbar p strong {
  color: var(--color-text-secondary);
  font-variant-numeric: tabular-nums;
  font-weight: var(--weight-medium);
}
.listening-ports-filter {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  align-items: center;
  gap: 0.42rem;
  min-width: 0;
  min-height: var(--control-height-sm);
  padding: 0 0.62rem;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-control-background);
  color: var(--color-text-tertiary);
}
.listening-ports-filter:focus-within {
  border-color: var(--color-accent);
  box-shadow: var(--shadow-accent-focus);
}
.listening-ports-filter input {
  min-width: 0;
  padding: 0;
  border: 0;
  outline: 0;
  background: transparent;
  color: var(--color-text);
  font: inherit;
  font-size: var(--text-label);
}
.listening-ports-filter input::placeholder {
  color: var(--color-text-disabled);
}
.listening-ports-toolbar button {
  display: grid;
  place-items: center;
  width: var(--control-height-sm);
  height: var(--control-height-sm);
  padding: 0;
  border: 0;
  border-radius: var(--radius-sm);
  background: var(--color-surface-raised);
  color: var(--color-text-secondary);
  cursor: pointer;
}
.listening-ports-error button {
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  justify-content: center;
  min-height: var(--control-height-sm);
  padding: 0 0.7rem;
  border: 0;
  border-radius: var(--radius-sm);
  background: var(--color-surface-raised);
  color: var(--color-text);
  font: inherit;
  font-size: var(--text-label);
  font-weight: var(--weight-medium);
  cursor: pointer;
}
@media (hover: hover) {
  .listening-ports-toolbar button:hover:not(:disabled),
  .listening-ports-error button:hover {
    background: var(--color-surface-hover);
  }
}
.listening-ports-toolbar button:disabled {
  cursor: wait;
  opacity: 0.6;
}
.listening-ports-toolbar .spinning {
  display: grid;
  animation: listening-ports-spin 800ms linear infinite;
}
.listening-ports-status {
  margin: 0;
  padding: 0.55rem 0.65rem;
  border-radius: var(--radius-sm);
  background: var(--color-success-surface);
  color: var(--color-success-text);
  font-size: var(--text-caption);
  line-height: var(--leading-ui);
}
.listening-ports-error {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  padding: 0.75rem;
  border: 1px solid var(--color-danger-border);
  border-radius: var(--radius-sm);
  background: var(--color-danger-surface);
}
.listening-ports-error p {
  margin: 0;
  color: var(--color-danger-text);
  font-size: var(--text-label);
  line-height: var(--leading-ui);
}
.listening-ports-placeholder {
  margin: 0;
  padding: 2.25rem 1rem;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-surface);
  color: var(--color-text-tertiary);
  font-size: var(--text-label);
  text-align: center;
}
.listening-port-table {
  min-width: 0;
  overflow: hidden;
  border: 1px solid var(--color-border-subtle);
  border-radius: var(--radius-sm);
  background: var(--color-surface);
}
.listening-port-columns,
.listening-port-row {
  display: grid;
  grid-template-columns: minmax(4rem, 0.45fr) minmax(10rem, 1.55fr) minmax(7.5rem, 0.8fr) auto;
  align-items: center;
  gap: 0.7rem;
  min-width: 0;
  padding-inline: 0.7rem;
}
.listening-port-columns {
  min-height: 2rem;
  border-bottom: 1px solid var(--color-border-subtle);
  background: var(--color-surface-raised);
  color: var(--color-text-tertiary);
  font-size: var(--text-nano);
  font-weight: var(--weight-medium);
}
.listening-port-list {
  display: grid;
  max-height: min(30rem, 58dvh);
  overflow-y: auto;
  margin: 0;
  padding: 0;
  list-style: none;
}
.listening-port-row {
  min-height: 3.25rem;
  padding-block: 0.48rem;
  border-bottom: 1px solid var(--color-border-subtle);
}
.listening-port-row:last-child {
  border-bottom: 0;
}
@media (hover: hover) {
  .listening-port-row:hover {
    background: var(--color-surface-hover);
  }
}
.listening-port-endpoint,
.listening-port-process {
  display: grid;
  min-width: 0;
  gap: 0.12rem;
}
.listening-port-endpoint strong {
  color: var(--color-text);
  font-family: var(--font-mono);
  font-size: var(--text-label);
  font-weight: var(--weight-strong);
  font-variant-numeric: tabular-nums;
}
.listening-port-process > code {
  overflow: hidden;
  color: var(--color-text-tertiary);
  font-family: var(--font-mono);
  font-size: var(--text-nano);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.listening-port-process > div {
  display: flex;
  align-items: baseline;
  gap: 0.45rem;
  min-width: 0;
}
.listening-port-process strong {
  min-width: 0;
  overflow: hidden;
  color: var(--color-text);
  font-size: var(--text-label);
  font-weight: var(--weight-medium);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.listening-port-process span {
  flex: 0 0 auto;
  color: var(--color-text-tertiary);
  font-size: var(--text-nano);
  font-variant-numeric: tabular-nums;
}
.listening-port-binding {
  min-width: 0;
  overflow: hidden;
  color: var(--color-text-secondary);
  font-size: var(--text-caption);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.listening-port-stop {
  min-height: 1.85rem;
  padding: 0 0.45rem;
  border: 0;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--color-text-tertiary);
  font: inherit;
  font-size: var(--text-nano);
  font-weight: var(--weight-medium);
  cursor: pointer;
}
@media (hover: hover) {
  .listening-port-stop:hover {
    background: var(--color-danger-surface-hover);
    color: var(--color-danger-text);
  }
}
.listening-port-unavailable {
  max-width: 5.5rem;
  overflow: hidden;
  justify-self: end;
  padding: 0.24rem 0.42rem;
  border: 1px solid var(--color-border-subtle);
  border-radius: var(--radius-pill);
  background: var(--color-surface-raised);
  color: var(--color-text-tertiary);
  font-size: var(--text-nano);
  text-align: center;
  text-overflow: ellipsis;
  white-space: nowrap;
}

@keyframes listening-ports-spin {
  to {
    transform: rotate(360deg);
  }
}

@media (max-width: 36rem) {
  .listening-port-columns {
    display: none;
  }
  .listening-port-row {
    grid-template-columns: 3.6rem minmax(0, 1fr) auto;
    grid-template-rows: auto auto;
    gap: 0.08rem 0.55rem;
    padding: 0.55rem 0.65rem;
  }
  .listening-port-endpoint {
    grid-column: 1;
    grid-row: 1 / span 2;
  }
  .listening-port-process {
    grid-column: 2;
    grid-row: 1;
  }
  .listening-port-binding {
    grid-column: 2;
    grid-row: 2;
    color: var(--color-text-tertiary);
    font-size: var(--text-nano);
  }
  .listening-port-stop,
  .listening-port-unavailable {
    grid-column: 3;
    grid-row: 1 / span 2;
  }
  .listening-port-unavailable {
    max-width: 4.5rem;
  }
}

@media (prefers-reduced-motion: reduce) {
  .listening-ports-toolbar .spinning {
    animation: none;
  }
}
</style>
