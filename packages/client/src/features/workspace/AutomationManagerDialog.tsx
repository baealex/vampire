import { workspaceName } from '@vampire/lib/features/workspace/model/workspace-view.ts';
import {
  loadWorkspaceAgentAction,
  submitWorkspaceAgentAction,
} from '@vampire/lib/shared/api/workspace-agent-actions.ts';
import type { ManagedWorkspace } from '@vampire/lib/shared/contracts/workspace.ts';
import {
  MAX_AUTOMATION_INTERVAL_MS,
  MIN_AUTOMATION_INTERVAL_MS,
  type WorkspaceAutomation,
  type WorkspaceAutomationSchedule,
  type WorkspaceAutomationWeekday,
} from '@vampire/lib/shared/contracts/workspace-automations.ts';
import { Clock3, Pause, Pencil, Play, Plus, Sparkles, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { flushSync } from 'react-dom';
import { requestJson } from '~/shared/api/request.ts';
import { navigationGuard } from '~/shared/lib/navigation-guard.ts';
import {
  AskAgentPanel,
  Button,
  Field,
  Input,
  ManagementSurface,
  Select,
  Spinner,
  Textarea,
} from '~/shared/ui/index.ts';
import './automation-manager-dialog.css';

type ScheduleType = WorkspaceAutomationSchedule['type'];
const WEEKDAYS: Array<[WorkspaceAutomationWeekday, string]> = [
  [0, 'Sun'],
  [1, 'Mon'],
  [2, 'Tue'],
  [3, 'Wed'],
  [4, 'Thu'],
  [5, 'Fri'],
  [6, 'Sat'],
];
function dateTime(timestamp = Date.now() + 300_000) {
  const date = new Date(timestamp);
  return new Date(timestamp - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}
function clock(hour: number, minute: number) {
  return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(
    new Date(2020, 0, 1, hour, minute),
  );
}
function scheduleLabel(schedule: WorkspaceAutomationSchedule) {
  if (schedule.type === 'once') return `One time · ${new Date(schedule.runAt).toLocaleString()}`;
  if (schedule.type === 'interval') return `Every ${Math.round(schedule.intervalMs / 60_000)} min`;
  return `${schedule.weekdays.map((day) => WEEKDAYS.find(([id]) => id === day)?.[1]).join(', ')} at ${clock(schedule.hour, schedule.minute)} (${schedule.timeZone})`;
}

export function AutomationManagerDialog({
  initialAutomationId,
  initialWorkspaceId,
  onClose,
  onNavigate,
  workspaces,
}: {
  initialAutomationId?: string;
  initialWorkspaceId?: string;
  onClose: () => void;
  onNavigate?: (path: string) => void;
  workspaces: ManagedWorkspace[];
}) {
  const [workspaceId, setWorkspaceId] = useState(initialWorkspaceId ?? workspaces[0]?.id ?? '');
  const [automations, setAutomations] = useState<WorkspaceAutomation[]>([]);
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState('');
  const [error, setError] = useState('');
  const [editing, setEditing] = useState<WorkspaceAutomation | 'new'>();
  const [askingAgent, setAskingAgent] = useState(false);
  const [name, setName] = useState('');
  const [prompt, setPrompt] = useState('');
  const [scheduleType, setScheduleType] = useState<ScheduleType>('once');
  const [runAt, setRunAt] = useState(dateTime());
  const [intervalMinutes, setIntervalMinutes] = useState('60');
  const [weekdays, setWeekdays] = useState<WorkspaceAutomationWeekday[]>([1, 2, 3, 4, 5]);
  const [weeklyTime, setWeeklyTime] = useState('09:00');
  const [timeZone, setTimeZone] = useState(() => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC');
  const [baseline, setBaseline] = useState('');
  const draft = JSON.stringify([
    name,
    prompt,
    scheduleType,
    scheduleType === 'weekly'
      ? [weekdays, weeklyTime, timeZone]
      : [runAt, scheduleType === 'interval' ? intervalMinutes : ''],
  ]);
  const dirty = Boolean(editing) && draft !== baseline;
  const selectedWorkspace = useMemo(
    () => workspaces.find((workspace) => workspace.id === workspaceId),
    [workspaceId, workspaces],
  );
  const begin = useCallback((automation?: WorkspaceAutomation) => {
    const schedule = automation?.schedule;
    const initialRunAt = dateTime(
      schedule?.type === 'once' ? schedule.runAt : schedule?.type === 'interval' ? schedule.startAt : undefined,
    );
    const initialInterval = schedule?.type === 'interval' ? String(schedule.intervalMs / 60_000) : '60';
    const initialWeekdays: WorkspaceAutomationWeekday[] =
      schedule?.type === 'weekly' ? schedule.weekdays : [1, 2, 3, 4, 5];
    const initialTime =
      schedule?.type === 'weekly'
        ? `${String(schedule.hour).padStart(2, '0')}:${String(schedule.minute).padStart(2, '0')}`
        : '09:00';
    const initialZone =
      schedule?.type === 'weekly' ? schedule.timeZone : Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    setRunAt(initialRunAt);
    setIntervalMinutes(initialInterval);
    setWeekdays(initialWeekdays);
    setWeeklyTime(initialTime);
    setTimeZone(initialZone);
    setBaseline(
      JSON.stringify([
        automation?.name ?? '',
        automation?.prompt ?? '',
        schedule?.type ?? 'once',
        schedule?.type === 'weekly'
          ? [initialWeekdays, initialTime, initialZone]
          : [initialRunAt, schedule?.type === 'interval' ? initialInterval : ''],
      ]),
    );
    setEditing(automation ?? 'new');
    setName(automation?.name ?? '');
    setPrompt(automation?.prompt ?? '');
    setScheduleType(automation?.schedule.type ?? 'once');
  }, []);
  const load = useCallback(
    async (background = false) => {
      if (!workspaceId) return;
      if (!background) {
        setLoading(true);
        setError('');
      }
      try {
        const loaded = (
          await requestJson<{ automations: WorkspaceAutomation[] }>(
            `/api/workspaces/${encodeURIComponent(workspaceId)}/automations`,
            { cache: 'no-store' },
            'Unable to load automations',
          )
        ).automations;
        setAutomations(loaded);
        setError('');
        const requested = initialAutomationId && loaded.find((item) => item.id === initialAutomationId);
        if (requested && !background) begin(requested);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : 'Unable to load automations');
      } finally {
        if (!background) setLoading(false);
      }
    },
    [begin, initialAutomationId, workspaceId],
  );
  useEffect(() => {
    setEditing(undefined);
    void load();
  }, [load]);
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (!editing && !askingAgent) void load(true);
    }, 2_000);
    return () => window.clearInterval(timer);
  }, [askingAgent, editing, load]);
  const buildSchedule = (): WorkspaceAutomationSchedule | undefined => {
    if (scheduleType === 'weekly') {
      const [hour, minute] = weeklyTime.split(':').map(Number);
      if (!weekdays.length || !Number.isInteger(hour) || !Number.isInteger(minute)) return;
      return {
        type: 'weekly',
        weekdays: [...weekdays].sort(),
        hour: hour!,
        minute: minute!,
        timeZone,
        startAt: Date.now(),
      };
    }
    const timestamp = new Date(runAt).getTime();
    if (!Number.isFinite(timestamp)) return;
    if (scheduleType === 'once') return { type: 'once', runAt: timestamp };
    const intervalMs = Number(intervalMinutes) * 60_000;
    if (
      !Number.isInteger(intervalMs) ||
      intervalMs < MIN_AUTOMATION_INTERVAL_MS ||
      intervalMs > MAX_AUTOMATION_INTERVAL_MS
    )
      return;
    return { type: 'interval', intervalMs, startAt: timestamp };
  };
  const save = async () => {
    const schedule = buildSchedule();
    if (!workspaceId || !name.trim() || !prompt.trim() || !schedule) {
      setError('Enter a name, prompt, and valid schedule.');
      return;
    }
    const id = editing === 'new' ? '' : (editing?.id ?? '');
    setBusyId(id || 'new');
    setError('');
    try {
      const response = await requestJson<{ automation: WorkspaceAutomation }>(
        id
          ? `/api/workspaces/${encodeURIComponent(workspaceId)}/automations/${encodeURIComponent(id)}`
          : `/api/workspaces/${encodeURIComponent(workspaceId)}/automations`,
        {
          method: id ? 'PATCH' : 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name: name.trim(), prompt: prompt.trim(), schedule }),
        },
      );
      setAutomations((current) => [
        response.automation,
        ...current.filter((item) => item.id !== response.automation.id),
      ]);
      setEditing(undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to save the automation');
    } finally {
      setBusyId('');
    }
  };
  const setEnabled = async (automation: WorkspaceAutomation, enabled: boolean) => {
    setBusyId(automation.id);
    try {
      const response = await requestJson<{ automation: WorkspaceAutomation }>(
        `/api/workspaces/${encodeURIComponent(workspaceId)}/automations/${encodeURIComponent(automation.id)}`,
        { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled }) },
      );
      setAutomations((current) => current.map((item) => (item.id === automation.id ? response.automation : item)));
    } finally {
      setBusyId('');
    }
  };
  const remove = async (automation: WorkspaceAutomation) => {
    setBusyId(automation.id);
    try {
      await requestJson(
        `/api/workspaces/${encodeURIComponent(workspaceId)}/automations/${encodeURIComponent(automation.id)}`,
        { method: 'DELETE' },
      );
      setAutomations((current) => current.filter((item) => item.id !== automation.id));
    } finally {
      setBusyId('');
    }
  };
  const title = editing && editing !== 'new' ? 'Edit automation' : 'Agent automations';
  const leaveEditor = async () => {
    if (busyId || (dirty && !(await navigationGuard()?.()))) return;
    flushSync(() => setEditing(undefined));
    if (editing && editing !== 'new') {
      const returning = new URLSearchParams(location.search).get('return') === 'all';
      onNavigate?.(`/workspaces/${encodeURIComponent(workspaceId)}/automations${returning ? '?return=all' : ''}`);
    }
  };
  return (
    <ManagementSurface
      title={title}
      titleId="workspace-automations-title"
      dirty={dirty}
      busy={Boolean(busyId)}
      back={askingAgent ? () => setAskingAgent(false) : editing ? () => void leaveEditor() : undefined}
      backLabel="Back to automations"
      close={onClose}
      closeLabel="Close agent automations"
    >
      {askingAgent ? (
        <AskAgentPanel
          close={() => setAskingAgent(false)}
          load={() => loadWorkspaceAgentAction(workspaceId, 'automation')}
          submit={(request) => submitWorkspaceAgentAction(workspaceId, 'automation', request)}
          onSubmitted={() => void load()}
        />
      ) : (
        <div className="automation-manager">
          <label className="automation-workspace">
            Workspace
            <Select
              disabled={Boolean(editing) || Boolean(busyId)}
              value={workspaceId}
              onChange={(event) => setWorkspaceId(event.currentTarget.value)}
            >
              {workspaces.map((workspace) => (
                <option key={workspace.id} value={workspace.id}>
                  {workspaceName(workspace)}
                </option>
              ))}
            </Select>
          </label>
          {selectedWorkspace ? (
            <p className="automation-cwd" title={selectedWorkspace.cwd}>
              {selectedWorkspace.cwd}
            </p>
          ) : null}
          {!editing ? (
            <div className="automation-toolbar">
              <span>Scheduled prompts run in the main terminal.</span>
              <Button size="sm" onClick={() => setAskingAgent(true)}>
                <Sparkles size={15} />
                Ask agent…
              </Button>
              <Button size="sm" onClick={() => begin()}>
                <Plus size={15} />
                New automation
              </Button>
            </div>
          ) : null}
          {editing ? (
            <section className="automation-editor">
              <h3>{editing === 'new' ? 'New automation' : `Edit ${editing.name}`}</h3>
              <Field label="Name">
                <Input value={name} maxLength={80} onChange={(event) => setName(event.currentTarget.value)} autoFocus />
              </Field>
              <Field label="Prompt">
                <Textarea value={prompt} maxLength={8000} onChange={(event) => setPrompt(event.currentTarget.value)} />
              </Field>
              <Field label="Schedule">
                <Select
                  value={scheduleType}
                  onChange={(event) => setScheduleType(event.currentTarget.value as ScheduleType)}
                >
                  <option value="once">Once</option>
                  <option value="interval">Interval</option>
                  <option value="weekly">Weekly</option>
                </Select>
              </Field>
              {scheduleType === 'once' ? (
                <Field label="Run at">
                  <Input
                    type="datetime-local"
                    value={runAt}
                    onChange={(event) => setRunAt(event.currentTarget.value)}
                  />
                </Field>
              ) : scheduleType === 'interval' ? (
                <>
                  <Field label="Start at">
                    <Input
                      type="datetime-local"
                      value={runAt}
                      onChange={(event) => setRunAt(event.currentTarget.value)}
                    />
                  </Field>
                  <Field label="Every (minutes)">
                    <Input
                      type="number"
                      value={intervalMinutes}
                      onChange={(event) => setIntervalMinutes(event.currentTarget.value)}
                    />
                  </Field>
                </>
              ) : (
                <>
                  <Field label="Days">
                    <div className="weekday-picker">
                      {WEEKDAYS.map(([day, label]) => (
                        <button
                          type="button"
                          key={day}
                          className={weekdays.includes(day) ? 'active' : ''}
                          onClick={() =>
                            setWeekdays((current) =>
                              current.includes(day) ? current.filter((item) => item !== day) : [...current, day],
                            )
                          }
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                  </Field>
                  <Field label="Time">
                    <Input
                      type="time"
                      value={weeklyTime}
                      onChange={(event) => setWeeklyTime(event.currentTarget.value)}
                    />
                  </Field>
                  <Field label="Time zone">
                    <Input value={timeZone} onChange={(event) => setTimeZone(event.currentTarget.value)} />
                  </Field>
                </>
              )}
              <div className="automation-editor-actions">
                <Button variant="ghost" disabled={Boolean(busyId)} onClick={() => void leaveEditor()}>
                  Cancel
                </Button>
                <Button variant="primary" disabled={Boolean(busyId)} onClick={() => void save()}>
                  {busyId ? 'Saving…' : editing === 'new' ? 'Add automation' : 'Save changes'}
                </Button>
              </div>
            </section>
          ) : null}
          {loading ? (
            <div className="automation-loading">
              <Spinner />
              Loading automations…
            </div>
          ) : !editing && automations.length === 0 ? (
            <div className="automation-empty">
              <Clock3 size={22} />
              No automations for this workspace.
            </div>
          ) : !editing ? (
            <div className="automation-list">
              {automations.map((automation) => (
                <article key={automation.id}>
                  <div>
                    <strong>{automation.name}</strong>
                    <span>{scheduleLabel(automation.schedule)}</span>
                    <p>{automation.prompt}</p>
                  </div>
                  <span>
                    <Button
                      variant="icon"
                      aria-label={`${automation.enabled ? 'Pause' : 'Resume'} ${automation.name}`}
                      onClick={() => void setEnabled(automation, !automation.enabled)}
                    >
                      {automation.enabled ? <Pause size={15} /> : <Play size={15} />}
                    </Button>
                    <Button variant="icon" aria-label={`Edit ${automation.name}`} onClick={() => begin(automation)}>
                      <Pencil size={15} />
                    </Button>
                    <Button
                      variant="icon"
                      aria-label={`Delete ${automation.name}`}
                      onClick={() => void remove(automation)}
                    >
                      <Trash2 size={15} />
                    </Button>
                  </span>
                </article>
              ))}
            </div>
          ) : null}
          {error ? (
            <p className="automation-error" role="alert">
              {error}
            </p>
          ) : null}
        </div>
      )}
    </ManagementSurface>
  );
}
