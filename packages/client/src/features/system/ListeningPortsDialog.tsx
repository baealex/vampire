import { CircleStop, RefreshCw, Search, Shield } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  ListeningPort,
  ListeningPortsResponse,
  TerminateListeningProcessRequest,
} from '@vampire/lib/shared/contracts/listening-ports.ts';
import { requestJson } from '~/shared/api/request.ts';
import { Button, Dialog, Input, Spinner } from '~/shared/ui/index.ts';
import './listening-ports-dialog.css';

function processLabel(port: ListeningPort) {
  return port.processName || 'Unknown process';
}
function addressLabel(addresses: string[]) {
  return addresses.some((address) => !['127.0.0.1', '::1', 'localhost'].includes(address)) ? 'Network' : 'Localhost';
}

let cachedPorts: ListeningPort[] = [];

export function ListeningPortsDialog({ onClose }: { onClose: () => void }) {
  const [ports, setPorts] = useState<ListeningPort[]>(cachedPorts);
  const [filter, setFilter] = useState('');
  const [loading, setLoading] = useState(cachedPorts.length === 0);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [confirming, setConfirming] = useState<ListeningPort>();
  const [stopping, setStopping] = useState(false);
  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const next = (
        await requestJson<ListeningPortsResponse>(
          '/api/system/ports',
          { cache: 'no-store' },
          'Unable to inspect listening ports'
        )
      ).ports;
      cachedPorts = next;
      setPorts(next);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to inspect listening ports.');
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  const visible = useMemo(() => {
    const query = filter.trim().toLocaleLowerCase();
    return query
      ? ports.filter((port) =>
          [port.port, port.processName, port.cwd, ...port.addresses].some((value) =>
            String(value ?? '')
              .toLocaleLowerCase()
              .includes(query)
          )
        )
      : ports;
  }, [filter, ports]);
  const stop = async () => {
    const port = confirming;
    if (!port?.pid || port.termination !== 'available') return;
    setStopping(true);
    setError('');
    const body: TerminateListeningProcessRequest = { port: port.port, processName: port.processName, cwd: port.cwd };
    try {
      await requestJson(
        `/api/system/ports/${port.pid}`,
        { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
        `Unable to stop ${processLabel(port)}.`
      );
      setStatus(`SIGTERM sent to ${processLabel(port)} (PID ${port.pid}).`);
      setConfirming(undefined);
      window.setTimeout(() => void load(), 250);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to stop this process.');
    } finally {
      setStopping(false);
    }
  };
  return (
    <>
      <Dialog open title="Listening ports" onClose={onClose}>
        <div className="ports-toolbar listening-ports-toolbar">
          <label>
            <Search size={15} aria-hidden="true" />
            <Input
              autoFocus
              type="search"
              value={filter}
              onChange={(event) => setFilter(event.currentTarget.value)}
              placeholder="Port, process, or path"
              aria-label="Filter listening ports"
            />
          </label>
          <span>
            <strong>{visible.length}</strong>
            {filter.trim() ? ` / ${ports.length}` : ' ports'}
          </span>
          <Button
            variant="icon"
            aria-label="Refresh listening ports"
            onClick={() => void load()}
            disabled={loading || stopping}
          >
            <RefreshCw size={15} aria-hidden="true" />
          </Button>
        </div>
        {status ? (
          <p role="status" className="ports-status">
            {status}
          </p>
        ) : null}
        {error ? (
          <div className="ports-error" role="alert">
            <p>{error}</p>
            <Button size="sm" onClick={() => void load()}>
              Try again
            </Button>
          </div>
        ) : loading && ports.length === 0 ? (
          <div className="ports-empty">
            <Spinner /> Checking for listening ports…
          </div>
        ) : visible.length === 0 ? (
          <p className="ports-empty">
            {ports.length ? `No listening ports match “${filter.trim()}”.` : 'No TCP ports are listening.'}
          </p>
        ) : (
          <ul className="ports-list listening-port-results listening-port-list" aria-label="TCP listening ports">
            {visible.map((port) => (
              <li className="listening-port-row" key={`${port.pid}-${port.port}-${port.addresses.join('-')}`}>
                <div className="port-endpoint">
                  <strong>:{port.port}</strong>
                  <span data-network={addressLabel(port.addresses) === 'Network'}>{addressLabel(port.addresses)}</span>
                </div>
                <div className="port-process">
                  <strong>{processLabel(port)}</strong>
                  {port.pid ? <span>PID {port.pid}</span> : null}
                  <code title={port.cwd ?? ''}>
                    {port.cwd && port.cwd !== '/' ? port.cwd : 'Working directory unavailable'}
                  </code>
                </div>
                {port.termination === 'available' ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={`Stop ${processLabel(port)} on port ${port.port}`}
                    onClick={() => setConfirming(port)}
                  >
                    <CircleStop size={13} aria-hidden="true" />
                    Stop
                  </Button>
                ) : (
                  <span className="port-protected">
                    <Shield size={13} aria-hidden="true" />
                    {port.termination === 'protected'
                      ? 'Protected'
                      : port.termination === 'permission-denied'
                        ? 'No access'
                        : 'Unavailable'}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </Dialog>
      {confirming ? (
        <Dialog
          open
          title={`Stop ${processLabel(confirming)}?`}
          onClose={() => setConfirming(undefined)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setConfirming(undefined)} disabled={stopping}>
                Cancel
              </Button>
              <Button variant="danger" onClick={() => void stop()} disabled={stopping}>
                {stopping ? 'Stopping…' : 'Send SIGTERM'}
              </Button>
            </>
          }
        >
          <p>
            Send SIGTERM to {processLabel(confirming)} (PID {confirming.pid}). This closes port {confirming.port} and
            any other work owned by that process.
          </p>
        </Dialog>
      ) : null}
    </>
  );
}
