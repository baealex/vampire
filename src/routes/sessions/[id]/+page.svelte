<script lang="ts">
	import VampireApp from '../../+page.svelte';

	let { data }: { data: { sessionId: string } } = $props();
</script>

<VampireApp initialSessionId={data.sessionId} />
