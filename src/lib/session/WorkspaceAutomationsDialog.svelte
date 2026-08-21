<script lang="ts">
import DialogShell from '$lib/ui/DialogShell.svelte';
import SessionAutomations from '$lib/terminal/SessionAutomations.svelte';
import type { ManagedSession } from './types.ts';
import { workspaceName } from './view.ts';

let {
  session,
  close,
}: {
  session: ManagedSession;
  close: () => void;
} = $props();
</script>

<DialogShell
  eyebrow={workspaceName(session)}
  title="Agent automations"
  closeLabel="Close agent automations"
  {close}
  variant="inspect"
>
  <SessionAutomations sessionId={session.id} />
</DialogShell>
