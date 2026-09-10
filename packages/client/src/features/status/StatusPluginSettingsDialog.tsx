import {
  loadWorkspaceAgentAction,
  submitWorkspaceAgentAction,
} from '@vampire/lib/shared/api/workspace-agent-actions.ts';
import {
  cloneStatusPlugins,
  createStatusPluginPreset,
  isStatusPluginList,
  MAX_STATUS_PLUGINS,
  type StatusPlugin,
  type StatusPluginPreset,
} from '@vampire/lib/shared/contracts/status-plugin.ts';
import type { ManagedWorkspace } from '@vampire/lib/shared/contracts/workspace.ts';
import { mainWorkspacePromptTarget } from '@vampire/lib/shared/contracts/workspace-agent.ts';
import { ChevronDown, ChevronRight, ChevronUp, Ellipsis, Plus, Save, Sparkles, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { requestJson } from '~/shared/api/request.ts';
import { registerNavigationGuard } from '~/shared/lib/navigation-guard.ts';
import { CodeEditor } from '~/shared/ui/CodeEditor.tsx';
import {
  AskAgentPanel,
  Button,
  DropdownMenu,
  DropdownMenuItem,
  DropdownMenuSeparator,
  Input,
  ManagementSurface,
  Select,
  Spinner,
} from '~/shared/ui/index.ts';
import styles from './status-plugin-settings-dialog.module.css';

type Response = { plugins: StatusPlugin[]; presets: StatusPluginPreset[] };
function command(): StatusPlugin {
  return {
    id: crypto.randomUUID(),
    name: 'Command',
    enabled: true,
    intervalMs: 60_000,
    source: { type: 'command', command: '' },
  };
}

export function StatusPluginSettingsDialog({
  onClose,
  workspaceId,
  workspaces,
}: {
  onClose: () => void;
  workspaceId?: string;
  workspaces: ManagedWorkspace[];
}) {
  const [plugins, setPlugins] = useState<StatusPlugin[]>([]);
  const [presets, setPresets] = useState<StatusPluginPreset[]>([]);
  const [loaded, setLoaded] = useState('[]');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [selectedId, setSelectedId] = useState<string>();
  const [askingAgent, setAskingAgent] = useState(false);
  const [discardOpen, setDiscardOpen] = useState(false);
  const discardResolver = useRef<((discard: boolean) => void) | null>(null);
  const agentTargets = useMemo(
    () =>
      workspaces.flatMap((workspace) => {
        const process = mainWorkspacePromptTarget(workspace);
        return process ? [{ workspace, processLabel: process.label }] : [];
      }),
    [workspaces],
  );
  const [targetWorkspaceId, setTargetWorkspaceId] = useState(() => workspaceId ?? agentTargets[0]?.workspace.id ?? '');
  const dirty = useMemo(() => JSON.stringify(plugins) !== loaded, [loaded, plugins]);
  const selected = plugins.find((plugin) => plugin.id === selectedId);
  useEffect(() => {
    let active = true;
    void requestJson<Response>('/api/status-plugins', { cache: 'no-store' })
      .then((response) => {
        if (active) {
          setPlugins(cloneStatusPlugins(response.plugins));
          setPresets(response.presets);
          setLoaded(JSON.stringify(response.plugins));
        }
      })
      .catch((cause) => setError(cause instanceof Error ? cause.message : 'Unable to load status widgets.'))
      .finally(() => setLoading(false));
    return () => {
      active = false;
    };
  }, []);
  useEffect(() => {
    if (!dirty) return;
    return registerNavigationGuard(
      () =>
        new Promise<boolean>((resolve) => {
          discardResolver.current = resolve;
          setDiscardOpen(true);
        }),
    );
  }, [dirty]);
  const resolveDiscard = (discard: boolean) => {
    setDiscardOpen(false);
    const resolve = discardResolver.current;
    discardResolver.current = null;
    resolve?.(discard);
  };
  const update = (id: string, change: (plugin: StatusPlugin) => StatusPlugin) =>
    setPlugins((current) => current.map((plugin) => (plugin.id === id ? change(plugin) : plugin)));
  const add = (plugin: StatusPlugin | undefined) => {
    if (!plugin || plugins.length >= MAX_STATUS_PLUGINS) return;
    setPlugins((current) => [...current, plugin]);
    setSelectedId(plugin.id);
  };
  const move = (index: number, offset: -1 | 1) =>
    setPlugins((current) => {
      const target = index + offset;
      if (target < 0 || target >= current.length) return current;
      const next = [...current];
      [next[index], next[target]] = [next[target]!, next[index]!];
      return next;
    });
  const remove = (id: string) => {
    setPlugins((current) => current.filter((plugin) => plugin.id !== id));
    if (selectedId === id) setSelectedId(undefined);
  };
  const save = async () => {
    const normalized = cloneStatusPlugins(plugins).map((plugin) => ({
      ...plugin,
      name: plugin.name.trim(),
      source: { ...plugin.source, command: plugin.source.command.replace(/\r\n?/g, '\n').trim() },
    }));
    if (!isStatusPluginList(normalized)) {
      setError('Each widget needs a name, a command, and a valid whole-second interval.');
      return;
    }
    setSaving(true);
    setError('');
    try {
      const response = await requestJson<{ plugins: StatusPlugin[] }>('/api/status-plugins', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ plugins: normalized }),
      });
      setPlugins(cloneStatusPlugins(response.plugins));
      setLoaded(JSON.stringify(response.plugins));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to save status widgets.');
    } finally {
      setSaving(false);
    }
  };
  return (
    <>
      <ManagementSurface
        title={selected?.name || 'Status widgets'}
        titleId="status-widget-settings-title"
        eyebrow="Server settings"
        close={onClose}
        closeLabel="Close status widget settings"
        back={askingAgent ? () => setAskingAgent(false) : selected ? () => setSelectedId(undefined) : undefined}
        backLabel="Back to status widgets"
        busy={saving}
        footer={
          dirty ? (
            <div className={styles.footer}>
              <span>Unsaved changes</span>
              <Button variant="primary" onClick={() => void save()} disabled={saving}>
                <Save size={15} />
                {saving ? 'Saving…' : 'Save changes'}
              </Button>
            </div>
          ) : undefined
        }
      >
        <div className={styles.settings}>
          {askingAgent ? (
            <div className={styles.agentView}>
              <label className={styles.agentTarget}>
                <span>Send to</span>
                <Select
                  aria-label="Send to"
                  value={targetWorkspaceId}
                  onChange={(event) => setTargetWorkspaceId(event.currentTarget.value)}
                >
                  {agentTargets.map((target) => (
                    <option key={target.workspace.id} value={target.workspace.id}>
                      {target.workspace.workspaceLabel?.trim() || target.workspace.cwd} · {target.processLabel}
                    </option>
                  ))}
                </Select>
                <small>Widget files are global; choose the workspace agent that should update them.</small>
              </label>
              {targetWorkspaceId ? (
                <AskAgentPanel
                  key={targetWorkspaceId}
                  showTarget={false}
                  close={() => setAskingAgent(false)}
                  load={() => loadWorkspaceAgentAction(targetWorkspaceId, 'status-widget')}
                  submit={(request) => submitWorkspaceAgentAction(targetWorkspaceId, 'status-widget', request)}
                />
              ) : (
                <p>Start a foreground process in a workspace’s main terminal to use Ask Agent.</p>
              )}
            </div>
          ) : loading ? (
            <div className={styles.loading}>
              <Spinner />
              Loading status widgets…
            </div>
          ) : selected ? (
            <div className={styles.detail}>
              <div className={styles.detailTop}>
                <label>
                  Name
                  <Input
                    value={selected.name}
                    onChange={(event) => {
                      const value = event.currentTarget.value;
                      update(selected.id, (plugin) => ({ ...plugin, name: value }));
                    }}
                  />
                </label>
                <label>
                  Every
                  <Input
                    type="number"
                    value={selected.intervalMs / 1000}
                    onChange={(event) => {
                      const value = event.currentTarget.valueAsNumber;
                      update(selected.id, (plugin) => ({ ...plugin, intervalMs: value * 1000 }));
                    }}
                  />
                </label>
              </div>
              <label className={styles.enabledField}>
                <input
                  type="checkbox"
                  checked={selected.enabled}
                  onChange={(event) => {
                    const checked = event.currentTarget.checked;
                    update(selected.id, (plugin) => ({ ...plugin, enabled: checked }));
                  }}
                />
                Enabled
              </label>
              <label className={styles.commandField}>
                Command
                <CodeEditor
                  label="Command"
                  language="shell"
                  value={selected.source.command}
                  onChange={(value) =>
                    update(selected.id, (plugin) => ({ ...plugin, source: { type: 'command', command: value } }))
                  }
                />
              </label>
              <Button
                variant="danger-outline"
                aria-label={`Remove ${selected.name}`}
                onClick={() => remove(selected.id)}
              >
                <Trash2 size={15} />
                Remove widget
              </Button>
            </div>
          ) : (
            <>
              <div className={styles.toolbar}>
                <span>
                  {plugins.length} {plugins.length === 1 ? 'widget' : 'widgets'}
                </span>
                <Button size="sm" disabled={dirty || agentTargets.length === 0} onClick={() => setAskingAgent(true)}>
                  <Sparkles size={14} />
                  Ask agent…
                </Button>
                <DropdownMenu
                  align="end"
                  label="Add widget"
                  triggerClassName={styles.addButton}
                  trigger={
                    <>
                      <Plus size={14} />
                      Add widget
                    </>
                  }
                >
                  {presets.map((preset) => (
                    <DropdownMenuItem
                      key={preset.id}
                      onSelect={() => add(createStatusPluginPreset(preset.id, crypto.randomUUID()))}
                    >
                      <Plus size={14} />
                      {preset.name}
                    </DropdownMenuItem>
                  ))}
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onSelect={() => add(command())}>
                    <Plus size={14} />
                    Command
                  </DropdownMenuItem>
                </DropdownMenu>
              </div>
              <div className={styles.list}>
                {plugins.map((plugin, index) => (
                  <article className={styles.row} key={plugin.id}>
                    <button
                      className={styles.summary}
                      type="button"
                      aria-label={`Edit ${plugin.name}`}
                      onClick={() => setSelectedId(plugin.id)}
                    >
                      <span className={styles.order}>{index + 1}</span>
                      <span className={styles.main}>
                        <strong>{plugin.name}</strong>
                        <small>
                          {plugin.intervalMs / 1000}s · {plugin.enabled ? 'On' : 'Off'}
                        </small>
                      </span>
                      <ChevronRight className={styles.chevron} size={16} />
                    </button>
                    <DropdownMenu align="end" label={`Actions for ${plugin.name}`} trigger={<Ellipsis size={17} />}>
                      <DropdownMenuItem
                        disabled={index === 0}
                        aria-label={`Move ${plugin.name} up`}
                        onSelect={() => move(index, -1)}
                      >
                        <ChevronUp size={15} />
                        Move up
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        disabled={index === plugins.length - 1}
                        aria-label={`Move ${plugin.name} down`}
                        onSelect={() => move(index, 1)}
                      >
                        <ChevronDown size={15} />
                        Move down
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem danger aria-label={`Remove ${plugin.name}`} onSelect={() => remove(plugin.id)}>
                        <Trash2 size={15} />
                        Remove
                      </DropdownMenuItem>
                    </DropdownMenu>
                  </article>
                ))}
              </div>
            </>
          )}
          {error ? (
            <p className={styles.error} role="alert">
              {error}
            </p>
          ) : null}
        </div>
      </ManagementSurface>
      {discardOpen ? (
        <div className={styles.discardOverlay}>
          <section
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="discard-widget-title"
            className={styles.discardDialog}
          >
            <h2 id="discard-widget-title">Discard unsaved widget changes?</h2>
            <p>Your status widget edits have not been saved.</p>
            <footer>
              <Button autoFocus onClick={() => resolveDiscard(false)}>
                Cancel
              </Button>
              <Button variant="danger-outline" onClick={() => resolveDiscard(true)}>
                Discard changes
              </Button>
            </footer>
          </section>
        </div>
      ) : null}
    </>
  );
}
