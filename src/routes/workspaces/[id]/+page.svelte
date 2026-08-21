<script lang="ts">
import VampireApp from '~/lib/app/VampireApp.svelte';

let { data }: { data: { workspaceId: string } } = $props();
</script>

<VampireApp initialWorkspaceId={data.workspaceId} />
