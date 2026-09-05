<script lang="ts">
import WorkspaceAutomations, {
  type AutomationEditorMode,
} from '~/lib/features/workspace/ui/WorkspaceAutomations.svelte';
import { workspaceName } from '~/lib/features/workspace/model/workspace-view.ts';
import type { ManagedWorkspace } from '~/lib/shared/contracts/workspace.ts';
import { mainWorkspacePromptTarget } from '~/lib/shared/contracts/workspace-agent.ts';
import ManagementSurface from '~/lib/shared/ui/ManagementSurface.svelte';

let {
  workspace,
  initialAutomationId,
  close,
  onBusyChange = () => undefined,
}: {
  workspace: ManagedWorkspace;
  initialAutomationId?: string;
  close: () => void;
  onBusyChange?: (busy: boolean) => void;
} = $props();
let busy = $state(false);
let editorMode = $state<AutomationEditorMode>();

$effect(() => onBusyChange(busy));
</script>

<ManagementSurface
  title={editorMode === 'create' ? 'New automation' : editorMode === 'edit' ? 'Edit automation' : 'Agent automations'}
  titleId="workspace-automations-title"
  eyebrow={workspaceName(workspace)}
  {close}
  closeLabel="Close agent automations"
  back={editorMode ? () => editorMode = undefined : undefined}
  backLabel="Back to automations"
  {busy}
>
  <WorkspaceAutomations
    workspaceId={workspace.id}
    {initialAutomationId}
    bind:editorMode
    showEditorHeader={false}
    askAgentAvailable={Boolean(mainWorkspacePromptTarget(workspace))}
    onBusyChange={(value) => busy = value}
  />
</ManagementSurface>
