<script lang="ts">
import DialogShell from '~/lib/shared/ui/DialogShell.svelte';
import WorkspaceAutomations from '~/lib/features/workspace/ui/WorkspaceAutomations.svelte';
import type { ManagedWorkspace } from '~/lib/shared/contracts/workspace.ts';
import { workspaceName } from '~/lib/features/workspace/model/workspace-view.ts';

let {
  workspace,
  close,
}: {
  workspace: ManagedWorkspace;
  close: () => void;
} = $props();

let busy = $state(false);
</script>

<DialogShell
  eyebrow={workspaceName(workspace)}
  title="Agent automations"
  closeLabel="Close agent automations"
  {close}
  closeDisabled={busy}
  variant="inspect"
>
  <WorkspaceAutomations workspaceId={workspace.id} onBusyChange={(value) => busy = value} />
</DialogShell>
