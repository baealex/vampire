<script lang="ts">
	import { onMount, type Snippet } from 'svelte';
	import type { ManagedSession } from '$lib/session/types';
	import SessionNoteEditor from '$lib/terminal/SessionNoteEditor.svelte';
	import TerminalHeader from '$lib/terminal/TerminalHeader.svelte';
	import TerminalViewport from '$lib/terminal/TerminalViewport.svelte';
	import type { SystemMetrics } from '$lib/system-metrics';
	import { isDesktopViewport } from '$lib/ui/layout';

	let {
		session,
		close,
		onUpdateNote,
		onLoadNote,
		onInputActivity = () => undefined,
		onOutputActivity = () => undefined,
		repositoryOpen = false,
		isGitRepository = undefined,
		changeCount = 0,
		worktreeCount = 0,
		onRepositoryStatus = () => undefined,
		onToggleRepository = () => undefined,
		systemMetrics,
		children
	}: {
		session: ManagedSession;
		close: () => void;
		onUpdateNote: (sessionId: string, note: string) => Promise<void>;
		onLoadNote: (sessionId: string) => Promise<string>;
		onInputActivity?: (sessionId: string, timestamp: number) => void;
		onOutputActivity?: (sessionId: string, active: boolean, timestamp?: number) => void;
		repositoryOpen?: boolean;
		isGitRepository?: boolean;
		changeCount?: number;
		worktreeCount?: number;
		onRepositoryStatus?: (changeCount: number, worktreeCount: number) => void;
		onToggleRepository?: () => void;
		systemMetrics?: SystemMetrics;
		children?: Snippet;
	} = $props();

	let viewportStyle = $state('');
	let terminalFontSize = $state(14);
	let noteOpen = $state(false);
	const minimumFontSize = 10;
	const maximumFontSize = 22;
	const projectName = $derived(session.cwd.replace(/\/+$/, '').split('/').pop() || session.cwd);

	function changeTerminalFontSize(delta: number) {
		terminalFontSize = Math.min(maximumFontSize, Math.max(minimumFontSize, terminalFontSize + delta));
	}

	onMount(() => {
		const updateViewport = () => {
			if (isDesktopViewport()) {
				viewportStyle = '';
				return;
			}
			const viewport = window.visualViewport;
			const height = Math.round(viewport?.height ?? window.innerHeight);
			const top = Math.round(viewport?.offsetTop ?? 0);
			viewportStyle = `--terminal-viewport-height: ${height}px; --terminal-viewport-top: ${top}px;`;
		};

		updateViewport();
		window.addEventListener('resize', updateViewport);
		window.visualViewport?.addEventListener('resize', updateViewport);
		window.visualViewport?.addEventListener('scroll', updateViewport);

		return () => {
			window.removeEventListener('resize', updateViewport);
			window.visualViewport?.removeEventListener('resize', updateViewport);
			window.visualViewport?.removeEventListener('scroll', updateViewport);
		};
	});
</script>

<section
	class="terminal-sheet"
	style={viewportStyle}
	aria-label={`Terminal for ${projectName}`}
>
	<div class="terminal-topbar">
		<TerminalHeader
			{projectName}
			cwd={session.cwd}
			hasNote={Boolean(session.notePreview)}
			{noteOpen}
			fontSize={terminalFontSize}
			{minimumFontSize}
			{maximumFontSize}
			{systemMetrics}
			{close}
			{repositoryOpen}
			{isGitRepository}
			{changeCount}
			{worktreeCount}
			toggleRepository={onToggleRepository}
			toggleNote={() => noteOpen = !noteOpen}
			decreaseFontSize={() => changeTerminalFontSize(-1)}
			increaseFontSize={() => changeTerminalFontSize(1)}
		>
			{#snippet noteEditor()}
				<SessionNoteEditor
					getNote={() => onLoadNote(session.id)}
					close={() => noteOpen = false}
					save={async (note) => {
						await onUpdateNote(session.id, note);
					}}
				/>
			{/snippet}
		</TerminalHeader>
	</div>

	<TerminalViewport
		sessionId={session.id}
		{onInputActivity}
		{onOutputActivity}
		{onRepositoryStatus}
		bind:fontSize={terminalFontSize}
		{minimumFontSize}
		{maximumFontSize}
	>
		{#if children}{@render children()}{/if}
	</TerminalViewport>
</section>

<style>
	.terminal-sheet { position: fixed; z-index: 20; top: var(--terminal-viewport-top, 0); left: 0; display: grid; grid-template-rows: auto minmax(0, 1fr); width: 100%; height: var(--terminal-viewport-height, 100dvh); min-width: 0; overflow: hidden; background: var(--color-terminal-background); color: var(--color-terminal-foreground); }
	.terminal-topbar { position: relative; z-index: 7; min-width: 0; }

	@media (min-width: 64rem) {
		.terminal-sheet { position: relative; z-index: 1; top: auto; height: 100dvh; min-height: 0; border: 0; border-radius: 0; }
	}
</style>
