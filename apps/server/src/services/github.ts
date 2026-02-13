import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFileCb);

async function exec(cmd: string, args: string[], opts: Record<string, unknown> = {}): Promise<string> {
  const { stdout } = await execFileAsync(cmd, args, {
    encoding: 'utf-8',
    timeout: 30_000,
    ...opts,
  });
  return stdout.trim();
}

export async function getRemoteUrl(cwd: string): Promise<string> {
  return exec('git', ['remote', 'get-url', 'origin'], { cwd });
}

export async function createIssue(cwd: string, { title, body }: { title: string; body?: string }): Promise<number> {
  const args = ['issue', 'create', '--title', title.trim()];
  if (body && body.trim()) {
    args.push('--body', body.trim());
  }
  const output = await exec('gh', args, { cwd });
  const match = output.match(/\/issues\/(\d+)/);
  if (!match) throw new Error('Failed to parse issue number from: ' + output);
  return Number(match[1]);
}

export async function createPR(cwd: string, { title, body, base, head }: { title: string; body: string; base: string; head: string }): Promise<string> {
  const repo = await getRemoteUrl(cwd);
  return exec('gh', [
    'pr', 'create',
    '--title', title,
    '--body', body,
    '--base', base,
    '--head', head,
    '--repo', repo,
  ], { cwd });
}
