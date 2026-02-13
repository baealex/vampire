import { spawn, execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import type { Provider, RunAgentHandle, StreamCallbacks } from './types.js';

const execFileAsync = promisify(execFileCb);

function cleanEnv() {
  const env = { ...process.env };
  delete env.CLAUDECODE;
  return env;
}

export const claudeProvider: Provider = {
  info: {
    name: 'claude',
    displayName: 'Claude Code',
    coAuthor: 'Claude <noreply@anthropic.com>',
  },

  async testConnection() {
    try {
      const { stdout } = await execFileAsync('claude', ['--version'], {
        encoding: 'utf-8',
        timeout: 10_000,
        env: cleanEnv(),
      });
      const version = stdout.trim();

      const { stdout: testOut } = await execFileAsync('claude', [
        '-p', 'Respond with exactly: OK',
        '--output-format', 'text',
      ], {
        encoding: 'utf-8',
        timeout: 30_000,
        env: cleanEnv(),
      });

      if (testOut.toLowerCase().includes('ok')) {
        return { ok: true, message: `Claude Code ${version} is ready.` };
      }
      return { ok: false, message: `CLI responded but output was unexpected: ${testOut.slice(0, 100)}` };
    } catch (err: any) {
      if (err.code === 'ENOENT') {
        return { ok: false, message: 'Claude CLI not found. Install: npm install -g @anthropic-ai/claude-code' };
      }
      return { ok: false, message: `Connection failed: ${err.message}` };
    }
  },

  runAgent({ prompt, cwd, callbacks }: { prompt: string; cwd: string; callbacks: StreamCallbacks }): RunAgentHandle {
    const child = spawn('claude', [
      '-p', '--dangerously-skip-permissions',
      '--output-format', 'stream-json', '--verbose',
      prompt,
    ], {
      cwd,
      env: { ...cleanEnv(), HOME: process.env.HOME },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const result = new Promise<string>((resolve, reject) => {
      let finalResult = '';
      let lineBuf = '';

      const processLine = (line: string) => {
        if (!line.trim()) return;
        try {
          const event = JSON.parse(line);
          if (event.type === 'assistant' && event.message?.content) {
            for (const block of event.message.content) {
              if (block.type === 'tool_use') {
                callbacks.onToolUse(block.name, block.input || {});
              } else if (block.type === 'text' && block.text) {
                finalResult += block.text;
                callbacks.onText(block.text);
              }
            }
          } else if (event.type === 'result') {
            if (event.result) {
              finalResult = event.result;
            }
          }
        } catch (_) {}
      };

      child.stdout!.on('data', (chunk: Buffer) => {
        lineBuf += chunk.toString();
        const lines = lineBuf.split('\n');
        lineBuf = lines.pop() || '';
        for (const line of lines) processLine(line);
      });

      child.stderr!.on('data', (chunk: Buffer) => {
        const text = chunk.toString().trim();
        if (text) callbacks.onText(text);
      });

      child.on('close', (code) => {
        if (lineBuf.trim()) processLine(lineBuf);
        if (code !== 0) reject(new Error(`Claude exited with code ${code}`));
        else resolve(finalResult);
      });

      child.on('error', reject);
    });

    return { child, result };
  },
};
