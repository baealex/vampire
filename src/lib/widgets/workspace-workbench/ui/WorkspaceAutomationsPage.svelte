<script lang="ts">
import WorkspaceAutomations from '~/lib/features/workspace/ui/WorkspaceAutomations.svelte';
import { workspaceName } from '~/lib/features/workspace/model/workspace-view.ts';
import type { ManagedWorkspace } from '~/lib/shared/contracts/workspace.ts';
import ManagementSurface from '~/lib/shared/ui/ManagementSurface.svelte';

let {
  workspace,
  close,
  onBusyChange = () => undefined,
}: {
  workspace: ManagedWorkspace;
  close: () => void;
  onBusyChange?: (busy: boolean) => void;
} = $props();
let busy = $state(false);

$effect(() => onBusyChange(busy));
</script>

<ManagementSurface
  title="Agent automations"
  titleId="workspace-automations-title"
  eyebrow={workspaceName(workspace)}
  {close}
  closeLabel="Close agent automations"
  focusOnMount={false}
  {busy}
>
  <WorkspaceAutomations workspaceId={workspace.id} onBusyChange={(value) => busy = value} />
</ManagementSurface>
