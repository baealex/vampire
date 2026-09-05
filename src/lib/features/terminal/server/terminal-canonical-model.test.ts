import assert from 'node:assert/strict';
import test from 'node:test';

import { TerminalCanonicalModel } from './terminal-canonical-model.server.ts';

test('serializes concurrent writes in arrival order and fences snapshots by sequence', async () => {
  const model = new TerminalCanonicalModel({ columns: 20, rows: 5 });

  const first = model.write('alpha');
  const second = model.write(' beta');
  const snapshot = model.snapshot();
  const third = model.write(' gamma');

  assert.equal((await first)?.sequence, 1);
  assert.equal((await second)?.sequence, 2);
  const fenced = await snapshot;
  assert.equal(fenced.throughSequence, 2);
  assert.match(fenced.data, /alpha beta/);
  assert.doesNotMatch(fenced.data, /gamma/);
  assert.equal((await third)?.sequence, 3);

  const final = await model.snapshot();
  assert.equal(final.throughSequence, 3);
  assert.match(final.data, /alpha beta gamma/);
  await model.dispose();
});

test('preserves unicode and both normal and alternate screen state', async () => {
  const model = new TerminalCanonicalModel({ columns: 24, rows: 6 });
  await model.write('메인 화면');
  await model.write('\u001b[?1049h\u001b[2J\u001b[H대체 화면');

  const snapshot = await model.snapshot();
  assert.match(snapshot.data, /메인 화면/);
  assert.match(snapshot.data, /\u001b\[\?1049h/);
  assert.match(snapshot.data, /대체 화면/);

  const restored = new TerminalCanonicalModel({ columns: 24, rows: 6 });
  await restored.restore(snapshot.data, snapshot.geometry, snapshot.throughSequence);
  await restored.write('\u001b[?1049l');
  const normal = await restored.snapshot();
  assert.match(normal.data, /메인 화면/);

  await Promise.all([model.dispose(), restored.dispose()]);
});

test('preserves fragmented ANSI output and replay sequences across a burst and restore fence', async () => {
  const model = new TerminalCanonicalModel({ columns: 40, rows: 5 });
  try {
    const chunks = Array.from({ length: 1_024 }, (_, index) => `\r\u001b[2Krow-${index}`);
    const writes = chunks.map((chunk) => model.write(chunk));
    const beforeRestore = model.snapshot();
    const restore = model.restore('새 화면', { columns: 40, rows: 5 });
    const nextChunks = ['\u001b[', '31m', ' 완료', '\u001b[0m'];
    const nextWrites = nextChunks.map((chunk) => model.write(chunk));
    assert.deepEqual(
      await Promise.all(writes),
      chunks.map((data, index) => ({ data, sequence: index + 1 }))
    );
    assert.match((await beforeRestore).data, /row-1023/);
    assert.equal((await restore).throughSequence, chunks.length);
    await Promise.all(nextWrites);
    assert.deepEqual(
      (await model.deltasAfter(chunks.length)).entries,
      nextChunks.map((data, index) => ({ data, sequence: chunks.length + index + 1 }))
    );
    const snapshot = await model.snapshot();
    assert.match(snapshot.data, /새 화면/);
    assert.match(snapshot.data, /완료/);
    assert.doesNotMatch(snapshot.data, /row-/);
  } finally {
    await model.dispose();
  }
});

test('orders resize behind prior parser writes', async () => {
  const model = new TerminalCanonicalModel({ columns: 12, rows: 4 });
  const write = model.write('prior');
  const resized = model.resize({ columns: 8, rows: 4 });

  assert.equal((await write)?.sequence, 1);
  const snapshot = await resized;
  assert.deepEqual(snapshot.geometry, { columns: 8, rows: 4 });
  assert.equal(snapshot.throughSequence, 1);
  assert.match(snapshot.data, /prior/);
  await model.dispose();
});

test('reports a replay gap only after bounded output has been evicted', async () => {
  const model = new TerminalCanonicalModel(
    { columns: 20, rows: 5 },
    {
      outputRingBytes: 6,
    }
  );
  await model.write('abc');
  await model.write('def');
  await model.write('ghi');

  assert.deepEqual(await model.deltasAfter(1), {
    available: true,
    entries: [
      { sequence: 2, data: 'def' },
      { sequence: 3, data: 'ghi' },
    ],
    throughSequence: 3,
  });
  assert.deepEqual(await model.deltasAfter(0), {
    available: false,
    entries: [],
    throughSequence: 3,
  });
  await model.dispose();
});

test('restore establishes a new replay floor without inventing output', async () => {
  const model = new TerminalCanonicalModel({ columns: 20, rows: 5 });
  await model.write('old');
  const restored = await model.restore('restored', { columns: 20, rows: 5 }, 41);

  assert.equal(restored.throughSequence, 41);
  assert.match(restored.data, /restored/);
  assert.equal((await model.write(' next'))?.sequence, 42);
  assert.equal((await model.deltasAfter(40)).available, false);
  assert.deepEqual(await model.deltasAfter(41), {
    available: true,
    entries: [{ sequence: 42, data: ' next' }],
    throughSequence: 42,
  });
  await model.dispose();
});

test('grows canonical scrollback only when an authoritative history snapshot needs it', async () => {
  const model = new TerminalCanonicalModel({ columns: 8, rows: 2 }, { scrollback: 0 });
  await model.restore('one\r\ntwo\r\nthree\r\nfour', { columns: 8, rows: 2 }, undefined, 3);
  const snapshot = await model.snapshot(3);

  assert.equal(snapshot.availableHistory, 2);
  assert.match(snapshot.data, /one/);
  assert.match(snapshot.data, /four/);
  await model.dispose();
});
