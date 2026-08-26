import { chmod, lstat, rmdir, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createConnection, createServer, type Socket } from 'node:net';
import {
  ensureManagedKingControlSocketDirectory,
  managedKingControlSocketPath,
} from '~/lib/features/workspace/server/king-workspace.ts';
import type { KingControlRequest, KingControlResponse } from '~/lib/shared/contracts/king-workflow.ts';
import { errorHasCode } from '~/lib/shared/server/path-policy.ts';
import { handleKingControlRequest } from './king-control.ts';

const MAX_CONTROL_REQUEST_BYTES = 1024 * 1024;
const CONTROL_REQUEST_TIMEOUT_MS = 15_000;

function invalidRequest(id: string, error: string): KingControlResponse {
  return { id, ok: false, error };
}

function parseRequest(content: string): KingControlRequest {
  const value = JSON.parse(content) as unknown;
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Control request must be an object.');
  const request = value as Record<string, unknown>;
  if (typeof request.id !== 'string' || typeof request.command !== 'string') {
    throw new Error('Control request id and command are required.');
  }
  return value as KingControlRequest;
}

async function socketIsReachable(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection(path);
    const finish = (reachable: boolean) => {
      socket.destroy();
      resolve(reachable);
    };
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    setTimeout(() => finish(false), 250).unref();
  });
}

async function removeStaleSocket(path: string): Promise<void> {
  try {
    const details = await lstat(path);
    if (!details.isSocket() || details.isSymbolicLink()) {
      throw new Error(`Vampire King control path is not a socket: ${path}`);
    }
    if (await socketIsReachable(path)) throw new Error('Another Vampire King control server is already running.');
    await unlink(path);
  } catch (error) {
    if (errorHasCode(error, 'ENOENT')) return;
    throw error;
  }
}

function serveConnection(socket: Socket, handler: (request: KingControlRequest) => Promise<KingControlResponse>): void {
  socket.setEncoding('utf8');
  socket.setTimeout(CONTROL_REQUEST_TIMEOUT_MS, () => socket.destroy(new Error('Control request timed out.')));
  let content = '';
  let bytes = 0;
  let rejected = false;
  socket.on('data', (chunk: string) => {
    bytes += Buffer.byteLength(chunk);
    if (bytes > MAX_CONTROL_REQUEST_BYTES) {
      rejected = true;
      socket.end(`${JSON.stringify(invalidRequest('', 'Control request is too large.'))}\n`);
      return;
    }
    content += chunk;
  });
  socket.on('end', () => {
    if (rejected) return;
    void (async () => {
      let response: KingControlResponse;
      try {
        const lines = content
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean);
        if (lines.length !== 1) throw new Error('Send exactly one JSON request per connection.');
        response = await handler(parseRequest(lines[0] ?? ''));
      } catch (error) {
        response = invalidRequest('', error instanceof Error ? error.message : 'Control request is invalid.');
      }
      socket.end(`${JSON.stringify(response)}\n`);
    })();
  });
  socket.on('error', () => {
    // Individual CLI disconnects must not affect the control server.
  });
}

export async function installKingControlServer(
  handler: (request: KingControlRequest) => Promise<KingControlResponse> = handleKingControlRequest
): Promise<() => void> {
  const controlSocketPath = managedKingControlSocketPath();
  await ensureManagedKingControlSocketDirectory();
  await removeStaleSocket(controlSocketPath);
  const connections = new Set<Socket>();
  const server = createServer({ allowHalfOpen: true }, (socket) => {
    connections.add(socket);
    socket.once('close', () => connections.delete(socket));
    serveConnection(socket, handler);
  });
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once('error', onError);
    server.listen(controlSocketPath, () => {
      server.off('error', onError);
      resolve();
    });
  });
  if (process.platform !== 'win32') await chmod(controlSocketPath, 0o600);

  let closing = false;
  return () => {
    if (closing) return;
    closing = true;
    for (const socket of connections) socket.destroy();
    server.close();
    void (async () => {
      try {
        const details = await lstat(controlSocketPath);
        if (details.isSocket() && !details.isSymbolicLink()) await unlink(controlSocketPath);
        await rmdir(dirname(controlSocketPath));
      } catch (error) {
        if (!errorHasCode(error, 'ENOENT') && !errorHasCode(error, 'ENOTEMPTY')) console.error(error);
      }
    })();
  };
}
