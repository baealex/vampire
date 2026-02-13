import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '..', '..', '..');

// DB 마이그레이션 (스키마 → SQLite 자동 동기화)
execFileSync('npx', ['prisma', 'db', 'push', '--skip-generate'], {
  cwd: rootDir,
  stdio: 'inherit',
});

const PORT = Number(process.env.PORT) || 3333;

const { app } = await createApp();

app.listen({ port: PORT }, (err) => {
  if (err) {
    app.log.error(err);
    process.exit(1);
  }
  console.log(`\n  Vampire (dev): http://localhost:${PORT}\n`);
});
