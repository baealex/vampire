<script lang="ts">
import DialogShell from '~/lib/shared/ui/DialogShell.svelte';
import WorkspaceAutomations from '~/lib/features/terminal/WorkspaceAutomations.svelte';
import type { ManagedWorkspace } from '~/lib/shared/contracts/workspace.ts';
import { workspaceName } from './workspace-view.ts';

let {
  workspace,
  close,
}: {
  workspace: ManagedWorkspace;
  close: () => void;
} = $props();
</script>

<DialogShell
  eyebrow={workspaceName(workspace)}
  title="Agent automations"
  closeLabel="Close agent automations"
  {close}
  variant="inspect"
>
  <WorkspaceAutomations workspaceId={workspace.id} />
</DialogShell>
