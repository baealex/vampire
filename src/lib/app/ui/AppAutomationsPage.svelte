<script lang="ts">
import WorkspaceAutomationsOverview from '~/lib/features/workspace/ui/WorkspaceAutomationsOverview.svelte';
import type { ManagedWorkspace } from '~/lib/shared/contracts/workspace.ts';
import ManagementSurface from '~/lib/shared/ui/ManagementSurface.svelte';

let {
  workspaces,
  close,
  onManage,
  onBusyChange = () => undefined,
}: {
  workspaces: ManagedWorkspace[];
  close: () => void;
  onManage: (workspace: ManagedWorkspace, automationId?: string) => void;
  onBusyChange?: (busy: boolean) => void;
} = $props();
</script>

<ManagementSurface
  title="Automations"
  titleId="application-automations-title"
  eyebrow="Server settings"
  {close}
  closeLabel="Close all automations"
  showFooter={false}
>
  {#snippet children()}
    <WorkspaceAutomationsOverview {workspaces} {onManage} {onBusyChange} />
  {/snippet}
</ManagementSurface>
