import { workspaceName } from '@vampire/lib/features/workspace/model/workspace-view.ts';
import {
  loadWorkspaceAgentAction,
  submitWorkspaceAgentAction,
} from '@vampire/lib/shared/api/workspace-agent-actions.ts';
import { Sparkles } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { registerNavigationGuard } from '~/shared/lib/navigation-guard.ts';
import {
  AskAgentPanel,
  Button,
  PanelState,
  Textarea,
  WorkspacePanelHeader,
  WorkspaceSidePanel,
} from '~/shared/ui/index.ts';
import type { WorkspaceState } from './model/workspace-state.ts';
import './workspace-note.css';

export function WorkspaceNoteDialog({
  onClose,
  open,
  state,
  workspaceId,
}: {
  onClose: () => void;
  open: boolean;
  state: WorkspaceState;
  workspaceId: string;
}) {
  const workspace = state.workspaces.find((item) => item.id === workspaceId);
  const [draft, setDraft] = useState('');
  const [saved, setSaved] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [askingAgent, setAskingAgent] = useState(false);
  const draftRef = useRef(draft);
  const savedRef = useRef(saved);
  const saveRef = useRef<Promise<boolean> | undefined>(undefined);
  const timerRef = useRef<number | undefined>(undefined);
  draftRef.current = draft;
  savedRef.current = saved;
  const flush = useCallback(async () => {
    if (timerRef.current !== undefined) window.clearTimeout(timerRef.current);
    timerRef.current = undefined;
    if (saveRef.current) await saveRef.current;
    if (draftRef.current === savedRef.current) return true;
    const value = draftRef.current;
    setSaving(true);
    setError('');
    const request = state
      .updateWorkspaceNote(workspaceId, value)
      .then(() => {
        savedRef.current = value;
        setSaved(value);
        return true;
      })
      .catch((cause) => {
        setError(cause instanceof Error ? cause.message : 'The note could not be saved.');
        return false;
      })
      .finally(() => {
        setSaving(false);
        saveRef.current = undefined;
      });
    saveRef.current = request;
    return request;
  }, [state, workspaceId]);
  useEffect(() => {
    let active = true;
    void state
      .loadWorkspaceNote(workspaceId)
      .then((note) => {
        if (active) {
          setDraft(note);
          setSaved(note);
          savedRef.current = note;
        }
      })
      .catch((cause) => {
        if (active) setError(cause instanceof Error ? cause.message : 'The note could not be loaded.');
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
      void flush();
    };
  }, [flush, state, workspaceId]);
  useEffect(() => registerNavigationGuard(flush), [flush]);
  useEffect(() => {
    if (loading || draft === saved) return;
    if (timerRef.current !== undefined) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => void flush(), 700);
    return () => {
      if (timerRef.current !== undefined) window.clearTimeout(timerRef.current);
    };
  }, [draft, flush, loading, saved]);
  useEffect(() => {
    const guard = (event: MouseEvent) => {
      const button = (event.target as Element | null)?.closest<HTMLButtonElement>('[data-workspace-id]');
      const targetId = button?.dataset.workspaceId;
      if (!targetId || targetId === workspaceId || draftRef.current === savedRef.current) return;
      event.preventDefault();
      event.stopPropagation();
      void flush().then((ok) => {
        if (ok) {
          const workspace = state.workspaces.find((item) => item.id === targetId);
          if (workspace) state.openWorkspace(workspace);
        }
      });
    };
    document.addEventListener('click', guard, { capture: true });
    return () => document.removeEventListener('click', guard, { capture: true });
  }, [flush, state, workspaceId]);
  const close = () =>
    void flush().then((ok) => {
      if (ok) onClose();
    });
  return (
    <WorkspaceSidePanel open={open} className="workspace-note-panel" aria-label="Workspace note panel">
      <section
        className="note-editor panel"
        aria-label={askingAgent ? 'Ask agent about this note' : undefined}
        aria-labelledby={askingAgent ? undefined : 'workspace-note-title'}
      >
        {askingAgent ? (
          <AskAgentPanel
            close={() => {
              setAskingAgent(false);
              window.setTimeout(() => document.getElementById('workspace-note-ask-agent')?.focus());
            }}
            load={() => loadWorkspaceAgentAction(workspaceId, 'note')}
            submit={async (request) => {
              if (!(await flush())) throw new Error(error || 'Save the note before asking the agent.');
              return submitWorkspaceAgentAction(workspaceId, 'note', request);
            }}
          />
        ) : (
          <>
            <WorkspacePanelHeader
              title="Note"
              subtitle={workspace ? workspaceName(workspace) : undefined}
              subtitleTitle={workspace?.cwd}
              titleId="workspace-note-title"
              close={close}
              closeLabel="Close workspace note"
              actions={
                <Button
                  id="workspace-note-ask-agent"
                  size="sm"
                  onClick={() => setAskingAgent(true)}
                  disabled={loading || Boolean(error)}
                >
                  <Sparkles size={15} />
                  Ask agent…
                </Button>
              }
            />
            {loading ? (
              <PanelState loading>Loading note…</PanelState>
            ) : (
              <Textarea
                className="note-textarea"
                size="fill"
                value={draft}
                onChange={(event) => {
                  setError('');
                  setDraft(event.currentTarget.value);
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Escape') close();
                }}
                placeholder="What is this workspace for? What changed? What comes next?"
                autoFocus={open}
                aria-label="Workspace note"
              />
            )}
            <footer>
              <span role={error ? 'alert' : 'status'}>
                {saving ? 'Saving…' : error ? error : draft === saved ? 'Saved' : 'Saving soon…'}
              </span>
            </footer>
          </>
        )}
      </section>
    </WorkspaceSidePanel>
  );
}
