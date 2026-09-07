import { createServer, connect, type Socket } from 'node:net';

/** TCP stream shaping, including WebSocket traffic; bandwidth is per connection/direction. */
export async function terminalNetworkProxy(targetPort: number, bytesPerSecond: number, oneWayLatencyMs: number) {
  const sockets = new Set<Socket>();
  const stats = { bytes: 0, peakQueuedBytes: 0, connections: 0 };
  let available = true;
  function forward(source: Socket, target: Socket) {
    const queue: Array<{ data: Buffer; offset: number; readyAt: number }> = [];
    let pending = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let nextSendAt = 0;
    let waitingDrain = false;
    const pump = () => {
      if (timer || waitingDrain || source.destroyed || target.destroyed || !queue.length) return;
      const delay = Math.max(0, queue[0].readyAt - Date.now(), nextSendAt - Date.now());
      timer = setTimeout(() => {
        timer = undefined;
        if (target.destroyed || !queue.length) return;
        const item = queue[0];
        const count = Math.min(2_048, item.data.length - item.offset);
        const chunk = item.data.subarray(item.offset, item.offset + count);
        item.offset += count;
        pending -= count;
        if (item.offset === item.data.length) queue.shift();
        stats.bytes += count;
        nextSendAt = Date.now() + (count / bytesPerSecond) * 1_000;
        if (!target.write(chunk)) {
          waitingDrain = true;
          target.once('drain', () => {
            waitingDrain = false;
            pump();
          });
        }
        if (pending < 32_768) source.resume();
        pump();
      }, delay);
    };
    source.on('data', (data: Buffer) => {
      queue.push({ data, offset: 0, readyAt: Date.now() + oneWayLatencyMs });
      pending += data.length;
      stats.peakQueuedBytes = Math.max(stats.peakQueuedBytes, pending);
      if (pending >= 65_536) source.pause();
      pump();
    });
    source.once('close', () => {
      if (timer) clearTimeout(timer);
      queue.length = 0;
      target.destroy();
    });
    source.once('error', () => target.destroy());
  }
  const server = createServer((client) => {
    if (!available) {
      client.destroy();
      return;
    }
    const upstream = connect(targetPort, '127.0.0.1');
    stats.connections += 1;
    for (const socket of [client, upstream]) {
      sockets.add(socket);
      socket.once('close', () => sockets.delete(socket));
      socket.on('error', () => undefined);
    }
    forward(client, upstream);
    forward(upstream, client);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Network proxy did not bind.');
  return {
    origin: `http://127.0.0.1:${address.port}`,
    stats,
    setAvailable(value: boolean) {
      available = value;
      if (!value) for (const socket of sockets) socket.destroy();
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
