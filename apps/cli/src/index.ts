import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { mkdirSync, existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import { createApp } from '@vampire/server';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf-8'));

const program = new Command()
  .name('vampire')
  .description(pkg.description)
  .version(pkg.version)
  .option('-p, --port <number>', 'port to listen on (0 = auto assign)')
  .option('-H, --host <address>', 'host to bind to', 'localhost')
  .action(async (opts) => {
    const port = opts.port !== undefined ? Number(opts.port) : 0;
    const host = opts.host;

    // ~/.vampire/ 디렉토리 생성
    const vampireHome = join(process.env.HOME || process.env.USERPROFILE || '.', '.vampire');
    mkdirSync(vampireHome, { recursive: true });

    // DATABASE_URL 설정
    const dbPath = join(vampireHome, 'data.db');
    process.env.DATABASE_URL = `file:${dbPath}`;

    // Prisma schema 경로
    const schemaPath = join(__dirname, '..', 'prisma', 'schema.prisma');

    // DB 마이그레이션 (스키마 → SQLite 자동 동기화)
    console.log('Initializing database...');
    execFileSync('npx', ['prisma', 'db', 'push', '--skip-generate', '--schema', schemaPath], {
      stdio: 'inherit',
    });

    // 정적 파일 디렉토리
    const staticDir = resolve(__dirname, '..', 'dist-client');

    const { app } = await createApp({
      staticDir: existsSync(staticDir) ? staticDir : undefined,
    });

    app.listen({ port, host }, (err, address) => {
      if (err) {
        app.log.error(err);
        process.exit(1);
      }
      console.log(`\n  🧛 Vampire: ${address}\n`);
    });
  });

program.parse();
