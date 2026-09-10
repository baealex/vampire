import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { gunzipSync } from 'node:zlib';
import { compressClientDirectory } from './compress-client.ts';

test('client compression preserves originals and compresses nested text assets only', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'vampire-compress-client-'));
  try {
    const assets = join(directory, 'assets');
    await mkdir(assets);
    const content = 'export const message = "hello";\n'.repeat(200);
    await writeFile(join(assets, 'app.js'), content);
    await writeFile(join(assets, 'tiny.css'), 'body{}');
    await writeFile(join(assets, 'image.png'), Buffer.alloc(2_048));
    await compressClientDirectory(directory);
    assert.equal(await readFile(join(assets, 'app.js'), 'utf8'), content);
    const compressed = await readFile(join(assets, 'app.js.gz'));
    assert.equal(gunzipSync(compressed).toString(), content);
    assert.ok(compressed.length < Buffer.byteLength(content));
    await compressClientDirectory(directory);
    assert.deepEqual((await readdir(assets)).sort(), ['app.js', 'app.js.gz', 'image.png', 'tiny.css']);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
