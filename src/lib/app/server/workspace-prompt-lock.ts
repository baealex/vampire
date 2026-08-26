type WorkspacePromptLockGlobal = typeof globalThis & {
  __vampireWorkspacePromptLocks?: Map<string, Promise<void>>;
};

const lockGlobal = globalThis as WorkspacePromptLockGlobal;
if (!lockGlobal.__vampireWorkspacePromptLocks) lockGlobal.__vampireWorkspacePromptLocks = new Map();
const locks = lockGlobal.__vampireWorkspacePromptLocks;

export async function withWorkspacePromptLock<T>(workspaceId: string, operation: () => Promise<T>): Promise<T> {
  const previous = locks.get(workspaceId) ?? Promise.resolve();
  let release = () => {};
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  locks.set(workspaceId, current);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (locks.get(workspaceId) === current) locks.delete(workspaceId);
  }
}
