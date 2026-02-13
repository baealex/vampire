import { execFile as execFileCb, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import type { PrismaClient, Job, Project } from '@prisma/client';
import { getProvider } from './providers/registry.js';

const execFileAsync = promisify(execFileCb);

// Event bus for real-time log streaming
export const logEmitter = new EventEmitter();
logEmitter.setMaxListeners(50);

// Active worker registry (jobId → { kill() })
interface Worker {
  kill(signal?: NodeJS.Signals): void;
}

const activeWorkers = new Map<number, Worker>();

export function cancelWorker(jobId: number): void {
  const worker = activeWorkers.get(jobId);
  if (worker) {
    worker.kill();
    activeWorkers.delete(jobId);
  }
}

// Debounced DB flush for log persistence
const flushTimers = new Map<number, ReturnType<typeof setTimeout>>();
function scheduleFlush(jobId: number, prisma: PrismaClient, getLog: () => string): void {
  if (flushTimers.has(jobId)) return;
  flushTimers.set(
    jobId,
    setTimeout(async () => {
      flushTimers.delete(jobId);
      try {
        await prisma.job.update({
          where: { id: jobId },
          data: { log: getLog() },
        });
      } catch (_) {}
    }, 2000),
  );
}

async function exec(cmd: string, args: string[], opts: Record<string, unknown> = {}): Promise<string> {
  const { stdout } = await execFileAsync(cmd, args, {
    encoding: 'utf-8',
    timeout: 120_000,
    ...opts,
  });
  return stdout.trim();
}

async function isCancelled(prisma: PrismaClient, jobId: number): Promise<boolean> {
  try {
    const current = await prisma.job.findUnique({ where: { id: jobId }, select: { status: true } });
    return current?.status === 'cancelled';
  } catch (_) {
    return false;
  }
}

interface FollowUpContext {
  branch: string;
  message: string;
  previousDiff?: string | null;
}

interface WorkerParams {
  job: Job;
  project: Project;
  prisma: PrismaClient;
  followUp?: FollowUpContext;
}

interface WorkerResult {
  status: string;
  branch?: string;
  prBody?: string | null;
  prTitle?: string;
  diff?: string;
}

export function runWorker({ job, project, prisma, followUp }: WorkerParams): Worker {
  let logBuffer = '';
  let childProcess: ChildProcess | null = null;
  let cloneDir: string | null = null;

  function log(text: string): void {
    logBuffer += text + '\n';
    logEmitter.emit(`job:${job.id}`, text + '\n');
    scheduleFlush(job.id, prisma, () => logBuffer);
  }

  const workerPromise = (async (): Promise<WorkerResult> => {
    try {
      const { issueNo, type, description } = job;
      const { baseBranch, path: projectRoot, prompt: extraPrompt } = project;
      const provider = getProvider(project.provider || 'claude');
      const isFollowUp = !!followUp;
      const isDirect = issueNo == null;

      log('========================================');
      log(`  Vampire — ${isDirect ? `Direct #${job.id}` : `Issue #${issueNo}`}${isFollowUp ? ' (Follow-up)' : ''}`);
      log(`  ${new Date().toISOString().replace('T', ' ').slice(0, 19)}`);
      log('========================================');
      log('');

      let issueTitle: string;
      let issueBody: string;
      let branchName: string;

      if (isFollowUp) {
        branchName = followUp.branch;
        issueTitle = job.issueTitle || (isDirect ? `${type} #${job.id}` : `${type} #${issueNo}`);
        issueBody = '';

        log('[1/5] Follow-up on existing branch...');
        log(`  Branch: ${branchName}`);
        log(`  Feedback: ${followUp.message.slice(0, 100)}${followUp.message.length > 100 ? '...' : ''}`);
        log('');
      } else if (isDirect) {
        log('[1/5] Direct mode — using provided description...');

        issueTitle = job.issueTitle || `${type} #${job.id}`;
        issueBody = description || '';
        branchName = `${type}/${job.id}`;

        log(`  Title:  ${issueTitle}`);
        log(`  Type:   ${type}`);
        log(`  Branch: ${branchName}`);
        log('');
      } else {
        log(`[1/5] Reading issue #${issueNo}...`);

        issueTitle = await exec('gh', ['issue', 'view', String(issueNo), '--json', 'title', '-q', '.title'], { cwd: projectRoot });
        issueBody = await exec('gh', ['issue', 'view', String(issueNo), '--json', 'body', '-q', '.body'], { cwd: projectRoot });

        branchName = `${type}/${issueNo}`;

        await prisma.job.update({
          where: { id: job.id },
          data: { issueTitle },
        });

        log(`  Title:  ${issueTitle}`);
        log(`  Type:   ${type}`);
        log(`  Branch: ${branchName}`);
        log('');
      }

      if (await isCancelled(prisma, job.id)) throw new Error('cancelled');

      // ─── 2. Fetch ───
      log('[2/5] Fetching latest...');
      await exec('git', ['fetch', 'origin', baseBranch], { cwd: projectRoot });
      if (isFollowUp) {
        try {
          await exec('git', ['fetch', 'origin', branchName], { cwd: projectRoot });
        } catch (_) {}
      }

      // ─── 3. Clean workspace ───
      log('[3/5] Creating clean workspace...');

      const remoteUrl = await exec('git', ['remote', 'get-url', 'origin'], { cwd: projectRoot });

      cloneDir = join(tmpdir(), isDirect ? `vampire-direct-${job.id}-${Date.now()}` : `vampire-${issueNo}-${Date.now()}`);

      if (isFollowUp) {
        await exec('git', [
          'clone', projectRoot, cloneDir,
          '--branch', baseBranch,
          '--no-tags',
          '--quiet',
        ]);

        await exec('git', ['remote', 'set-url', 'origin', remoteUrl], { cwd: cloneDir });

        await exec('git', ['fetch', 'origin', branchName], { cwd: cloneDir });
        await exec('git', ['checkout', '-b', branchName, `origin/${branchName}`], { cwd: cloneDir });
      } else {
        await exec('git', [
          'clone', projectRoot, cloneDir,
          '--branch', baseBranch,
          '--single-branch',
          '--no-tags',
          '--quiet',
        ]);

        await exec('git', ['remote', 'set-url', 'origin', remoteUrl], { cwd: cloneDir });

        try {
          const lsRemote = await exec('git', ['ls-remote', '--heads', 'origin', branchName], { cwd: cloneDir });
          if (lsRemote.includes(branchName)) {
            log(`  Remote branch '${branchName}' already exists. Will force push.`);
          }
        } catch (_) {}

        await exec('git', ['checkout', '-b', branchName], { cwd: cloneDir });
      }

      log(`  Workspace: ${cloneDir}`);
      log('');

      if (await isCancelled(prisma, job.id)) throw new Error('cancelled');

      // ─── 4. Run agent ───
      log('[4/5] Running agent...');
      log('────────────────────────────────────────');

      let prompt: string;

      if (isFollowUp) {
        const taskRef = isDirect ? `Task: ${issueTitle}` : `GitHub Issue #${issueNo}: ${issueTitle}`;
        prompt = `${taskRef}

── Previous work ──
Code was previously modified for this ${isDirect ? 'task' : 'issue'} and pushed to branch ${branchName}.
${followUp.previousDiff ? `\nPrevious changes (diff):\n${followUp.previousDiff.slice(0, 3000)}\n` : ''}

── Feedback / Change request ──
${followUp.message}

── Instructions ──
Apply the feedback above by modifying the code.
You must build on top of the existing changes on this branch.
Do not just analyze — you must actually edit files.`;
      } else if (isDirect) {
        prompt = `Task: ${issueTitle}

${issueBody}

── Instructions ──
You must write code and modify files to complete the task above.
Do not just analyze or explain — actually create or edit files.
If the task is ambiguous, use your best judgment to implement a solution.`;
      } else {
        prompt = `GitHub Issue #${issueNo}: ${issueTitle}

${issueBody}

── Instructions ──
You must write code and modify files to resolve the issue above.
Do not just analyze or explain — actually create or edit files.
If the issue is ambiguous, use your best judgment to implement a solution.`;
      }

      if (extraPrompt) {
        prompt += `\n\n── Project rules ──\n${extraPrompt}`;
      }

      // Detect PR body template
      const prTemplatePath = join(cloneDir, '.github', 'PULL_REQUEST_TEMPLATE.md');
      if (existsSync(prTemplatePath)) {
        const prTpl = readFileSync(prTemplatePath, 'utf-8');
        prompt += `\n\nAfter all code changes are complete, output the PR body in this format:

Between \`---PR_BODY_START---\` and \`---PR_BODY_END---\`, fill in the PR template below.
Keep the template structure and replace placeholders with details about this work.

---PR_BODY_START---
${prTpl}
---PR_BODY_END---`;
      } else if (isDirect) {
        prompt += `\n\nAfter all code changes are complete, output the PR body in this format:

Between \`---PR_BODY_START---\` and \`---PR_BODY_END---\`, write the PR body.
Include what changed and how to verify.

---PR_BODY_START---
## Changes
(describe changes)

## How to verify
(verification steps)
---PR_BODY_END---`;
      } else {
        prompt += `\n\nAfter all code changes are complete, output the PR body in this format:

Between \`---PR_BODY_START---\` and \`---PR_BODY_END---\`, write the PR body.
The issue number is #${issueNo}. Include what changed and how to verify.

---PR_BODY_START---
Resolves #${issueNo}

## Changes
(describe changes)

## How to verify
(verification steps)
---PR_BODY_END---`;
      }

      const MAX_RETRY = 2;
      let claudeOutput = '';

      for (let attempt = 1; attempt <= MAX_RETRY + 1; attempt++) {
        if (await isCancelled(prisma, job.id)) throw new Error('cancelled');

        let currentPrompt: string;
        if (attempt === 1) {
          currentPrompt = prompt;
        } else {
          log('');
          log(`[4/5] Retry #${attempt - 1} — analyzing previous failure and retrying...`);
          log('────────────────────────────────────────');

          const retryTaskRef = isDirect ? `Task: ${issueTitle}` : `GitHub Issue #${issueNo}: ${issueTitle}`;
          currentPrompt = `${retryTaskRef}

${issueBody}

── Previous attempt result ──
The previous attempt did not produce any file changes.

Previous agent response:
${claudeOutput}

── Retry instructions ──
Analyze why the previous attempt failed, then try a different approach to ${isDirect ? 'complete the task' : 'resolve the issue'}.
You MUST modify files. Do not just analyze — actually change the code.
If the problem is complex, take a step-by-step approach.`;

          if (extraPrompt) {
            currentPrompt += `\n\n── Project rules ──\n${extraPrompt}`;
          }
        }

        // Run agent via provider
        const handle = provider.runAgent({
          prompt: currentPrompt,
          cwd: cloneDir!,
          callbacks: {
            onToolUse(name, input) {
              if (name === 'Read') log(`▸ Reading: ${input.file_path || ''}`);
              else if (name === 'Edit') log(`▸ Editing: ${input.file_path || ''}`);
              else if (name === 'Write') log(`▸ Writing: ${input.file_path || ''}`);
              else if (name === 'Bash') {
                const cmd = input.command || '';
                log(`▸ Running: ${cmd.length > 120 ? cmd.slice(0, 120) + '...' : cmd}`);
              } else if (name === 'Grep') log(`▸ Searching: "${input.pattern || ''}" in ${input.path || '.'}`);
              else if (name === 'Glob') log(`▸ Finding files: ${input.pattern || ''}`);
              else log(`▸ ${name}: ${JSON.stringify(input).slice(0, 100)}`);
            },
            onText(text) {
              log(text.replace(/\n$/, ''));
            },
          },
        });

        childProcess = handle.child;
        claudeOutput = await handle.result;
        childProcess = null;

        log('');
        log('────────────────────────────────────────');

        // Check for changes
        let hasChanges = false;
        try {
          await exec('git', ['diff', '--quiet'], { cwd: cloneDir });
          await exec('git', ['diff', '--cached', '--quiet'], { cwd: cloneDir });
          const untracked = await exec('git', ['ls-files', '--others', '--exclude-standard'], { cwd: cloneDir });
          hasChanges = untracked.length > 0;
        } catch (_) {
          hasChanges = true;
        }

        if (hasChanges) break;

        if (attempt > MAX_RETRY) {
          log('');
          log(`No changes detected after ${MAX_RETRY} retries.`);
          if (!isDirect) {
            try {
              await exec('gh', [
                'issue', 'comment', String(issueNo),
                '--body', `Vampire: Attempted ${MAX_RETRY} times but could not produce changes. Please make the issue description more specific.`,
                '--repo', remoteUrl,
              ], { cwd: cloneDir });
            } catch (_) {}
          }
          throw new Error('no changes after retries');
        }

        log('');
        log(`No changes detected. Retrying... (attempt ${attempt}/${MAX_RETRY})`);
      }

      if (await isCancelled(prisma, job.id)) throw new Error('cancelled');

      // ─── 5. Commit & Push ───
      log('[5/5] Committing & pushing...');

      const currentBranch = await exec('git', ['branch', '--show-current'], { cwd: cloneDir });
      if (currentBranch === baseBranch) {
        throw new Error(`FATAL: current branch is ${baseBranch}. Aborting push.`);
      }

      await exec('git', ['add', '-A'], { cwd: cloneDir });

      const commitMsg = isDirect
        ? `${type}: ${issueTitle}\n\nCo-Authored-By: ${provider.info.coAuthor}`
        : `${type}: ${issueTitle} (#${issueNo})\n\nCo-Authored-By: ${provider.info.coAuthor}`;
      await exec('git', ['commit', '--no-verify', '-m', commitMsg], { cwd: cloneDir });

      await exec('git', [
        'push', 'origin',
        `refs/heads/${branchName}:refs/heads/${branchName}`,
        '--force-with-lease',
      ], { cwd: cloneDir });

      // ─── Extract results ───
      const diff = await exec('git', ['diff', 'HEAD~1'], { cwd: cloneDir });

      const prBodyMatch = claudeOutput.match(/---PR_BODY_START---\n([\s\S]*?)\n---PR_BODY_END---/);
      let prBody = prBodyMatch?.[1]?.trim() || null;
      if (!prBody) {
        prBody = isDirect
          ? `_Auto-generated by Vampire_`
          : `Resolves #${issueNo}\n\n_Auto-generated by Vampire_`;
      }

      const prTitle = isDirect
        ? `${type}: ${issueTitle}`
        : `${type}: ${issueTitle} (#${issueNo})`;

      log('');
      log('========================================');
      log('  DONE');
      log(`  ${isDirect ? `Task: ${issueTitle}` : `Issue:  #${issueNo}`}`);
      log(`  Branch: ${branchName}`);
      log('  Create a PR from the web UI.');
      log('========================================');

      return { status: 'completed', branch: branchName, prBody, prTitle, diff };
    } catch (err: any) {
      if (err.message === 'cancelled') {
        return { status: 'cancelled' };
      }
      log('');
      log(`Error: ${err.message}`);
      throw err;
    } finally {
      if (cloneDir) {
        try {
          await rm(cloneDir, { recursive: true, force: true });
          log('');
          log('Cleaning up workspace...');
        } catch (_) {}
      }
    }
  })();

  // Update DB on completion
  workerPromise
    .then(async (result) => {
      let finalStatus = result.status;
      if (finalStatus !== 'cancelled') {
        if (await isCancelled(prisma, job.id)) {
          finalStatus = 'cancelled';
        }
      }

      try {
        await prisma.job.update({
          where: { id: job.id },
          data: {
            status: finalStatus,
            log: logBuffer,
            branch: result.branch || null,
            prBody: result.prBody || null,
            prTitle: result.prTitle || null,
            diff: result.diff || null,
          },
        });
      } catch (e) {
        console.error('Failed to update job:', e);
      }

      activeWorkers.delete(job.id);
      logEmitter.emit(`job:${job.id}`, `\n[worker exited: ${finalStatus}]`);
      logEmitter.emit(`job:${job.id}:done`, finalStatus);
    })
    .catch(async (err) => {
      let finalStatus = 'failed';
      if (await isCancelled(prisma, job.id)) {
        finalStatus = 'cancelled';
      }

      try {
        await prisma.job.update({
          where: { id: job.id },
          data: {
            status: finalStatus,
            log: logBuffer,
          },
        });
      } catch (e) {
        console.error('Failed to update job:', e);
      }

      activeWorkers.delete(job.id);
      logEmitter.emit(`job:${job.id}`, `\n[worker exited: ${finalStatus}]`);
      logEmitter.emit(`job:${job.id}:done`, finalStatus);
    });

  const worker: Worker = {
    kill(signal: NodeJS.Signals = 'SIGTERM') {
      if (childProcess) {
        try { childProcess.kill(signal); } catch (_) {}
      }
    },
  };
  activeWorkers.set(job.id, worker);

  return worker;
}
