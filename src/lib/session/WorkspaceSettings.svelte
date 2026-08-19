<script lang="ts">
	import Plus from '@lucide/svelte/icons/plus';
	import Save from '@lucide/svelte/icons/save';
	import Trash2 from '@lucide/svelte/icons/trash-2';
	import DialogShell from '$lib/ui/DialogShell.svelte';
	import type { LaunchProfile, ManagedSession } from './types.ts';
	import type { LaunchProfileSettings } from './workspace-state.svelte.ts';

	let {
		session,
		onClose,
		onSave
	}: {
		session: ManagedSession;
		onClose: () => void;
		onSave: (settings: LaunchProfileSettings) => Promise<{ ok: boolean; error?: string }>;
	} = $props();

	let profiles = $state<LaunchProfile[]>([]);
	let defaultProfileId = $state<string | null>(null);
	let autoStartDefaultProfile = $state(false);
	let initializedSessionId: string | undefined;
	let saving = $state(false);
	let savingError = $state('');
	const workspaceName = $derived(session.cwd.replace(/\/+$/, '').split('/').pop() || session.cwd);
	const hasUnsavedChanges = $derived(
		JSON.stringify(profiles) !== JSON.stringify(session.launchProfiles)
			|| defaultProfileId !== session.defaultLaunchProfileId
			|| autoStartDefaultProfile !== session.autoStartDefaultProfile
	);

	$effect(() => {
		if (initializedSessionId === session.id) return;
		initializedSessionId = session.id;
		profiles = session.launchProfiles.map((profile) => ({ ...profile }));
		defaultProfileId = session.defaultLaunchProfileId;
		autoStartDefaultProfile = session.autoStartDefaultProfile;
	});

	function addProfile() {
		const profile: LaunchProfile = {
			id: globalThis.crypto?.randomUUID?.() ?? `profile-${Date.now()}-${Math.random().toString(36).slice(2)}`,
			name: `Profile ${profiles.length + 1}`,
			command: ''
		};
		profiles = [...profiles, profile];
		if (!defaultProfileId) defaultProfileId = profile.id;
		savingError = '';
	}

	function removeProfile(profileId: string) {
		profiles = profiles.filter((profile) => profile.id !== profileId);
		if (defaultProfileId === profileId) defaultProfileId = profiles[0]?.id ?? null;
	}

	function validate(): string | undefined {
		if (profiles.length === 0) return undefined;
		const names = new Set<string>();
		for (const profile of profiles) {
			profile.name = profile.name.trim();
			profile.command = profile.command.trim();
			if (!profile.name) return 'Give every launch profile a name.';
			if (!profile.command) return 'Give every launch profile a command.';
			if (names.has(profile.name.toLowerCase())) return 'Launch profile names must be unique.';
			names.add(profile.name.toLowerCase());
			if (/[\0\r\n\t]/.test(profile.name) || /[\0\r\n\t]/.test(profile.command)) {
				return 'Names and commands must stay on one line.';
			}
		}
		if (defaultProfileId && !profiles.some((profile) => profile.id === defaultProfileId)) {
			defaultProfileId = null;
		}
		return undefined;
	}

	async function save() {
		savingError = validate() ?? '';
		if (savingError) return;
		saving = true;
		try {
			const result = await onSave({
				launchProfiles: profiles.map((profile) => ({ ...profile })),
				defaultLaunchProfileId: defaultProfileId,
				autoStartDefaultProfile: autoStartDefaultProfile && defaultProfileId !== null
			});
			if (!result.ok) savingError = result.error ?? 'Unable to save the launch profiles.';
		} finally {
			saving = false;
		}
	}
</script>

<DialogShell eyebrow={workspaceName} title="Launch profiles" close={onClose} variant="inspect">
	{#snippet children()}
		<div class="launch-profile-dialog">
			<div class="dialog-intro">
				<div>
					<strong>Startup commands</strong>
					<p>Save commands for this workspace. When the main session is reopened, Vampire can run the selected default in the new shell. Saving does not run anything in the current session.</p>
				</div>
				<button class="add-button" type="button" onclick={addProfile}>
					<Plus size={15} strokeWidth={2} aria-hidden="true" />
					<span>Add profile</span>
				</button>
			</div>

			{#if profiles.length === 0}
				<div class="empty-profiles">
					<span>No startup commands yet.</span>
					<button class="text-button" type="button" onclick={addProfile}>Add your first profile</button>
				</div>
			{:else}
				<div class="profile-list">
					{#each profiles as profile, index (profile.id)}
						<article class="profile-card">
							<div class="profile-card__top">
								<label>
									<span>Name</span>
									<input bind:value={profile.name} maxlength="80" />
								</label>
								<button class="icon-danger" type="button" onclick={() => removeProfile(profile.id)} aria-label={`Remove ${profile.name || `profile ${index + 1}`}`}>
									<Trash2 size={15} strokeWidth={1.8} aria-hidden="true" />
								</button>
							</div>
							<label>
								<span>Command</span>
								<input class="command-input" bind:value={profile.command} maxlength="1000" spellcheck="false" />
							</label>
							<div class="profile-card__footer">
								<label class="default-profile">
									<input type="radio" name="default-launch-profile" checked={defaultProfileId === profile.id} onchange={() => defaultProfileId = profile.id} />
									<span>Default</span>
								</label>
							</div>
						</article>
					{/each}
				</div>
			{/if}

			<div class="startup-row">
				<div>
					<strong>Auto-start on reopen</strong>
					<p>Run the default command when this workspace's main session is reopened.</p>
				</div>
				<label class="toggle-row">
					<input type="checkbox" checked={autoStartDefaultProfile} disabled={!defaultProfileId} onchange={(event) => autoStartDefaultProfile = event.currentTarget.checked} />
					<span>On</span>
				</label>
			</div>

			{#if savingError}<p class="feedback feedback--error" role="alert">{savingError}</p>{/if}
		</div>
	{/snippet}

	{#snippet footer()}
		<div class="dialog-footer">
			<p class="footnote">Commands run as the Vampire server user when the session is reopened.</p>
			<button class="save-button" type="button" onclick={() => void save()} disabled={saving}>
				<Save size={15} strokeWidth={1.9} aria-hidden="true" />
				<span>{saving ? 'Saving…' : hasUnsavedChanges ? 'Save changes' : 'Saved'}</span>
			</button>
		</div>
	{/snippet}
</DialogShell>

<style>
	.launch-profile-dialog { display: grid; gap: 0.9rem; min-width: 0; }
	.dialog-intro { display: flex; align-items: flex-start; justify-content: space-between; gap: 1rem; }
	.dialog-intro strong { display: block; color: var(--color-text); font-size: var(--text-label); font-weight: var(--weight-medium); }
	.dialog-intro p { max-width: 34rem; margin: 0.25rem 0 0; color: var(--color-text-secondary); font-size: var(--text-caption); line-height: var(--leading-body); }
	.add-button, .save-button { display: inline-flex; align-items: center; justify-content: center; gap: 0.38rem; min-height: 2.3rem; border-radius: var(--radius-sm); font: inherit; font-size: var(--text-caption); font-weight: var(--weight-medium); cursor: pointer; }
	.add-button { flex: 0 0 auto; padding: 0 0.65rem; border: 1px solid var(--color-border); background: var(--color-control-background); color: var(--color-text); }
	.add-button:hover { border-color: var(--color-accent); background: var(--color-surface-hover); color: var(--color-accent); }
	.empty-profiles { display: flex; align-items: center; justify-content: space-between; gap: 0.75rem; padding: 0.8rem 0.9rem; border: 1px dashed var(--color-border-strong); border-radius: var(--radius-md); color: var(--color-text-secondary); font-size: var(--text-caption); }
	.text-button { padding: 0; border: 0; background: transparent; color: var(--color-accent); font: inherit; font-size: var(--text-caption); font-weight: var(--weight-medium); cursor: pointer; }
	.text-button:hover { color: var(--color-accent-hover); }
	.profile-list { display: grid; gap: 0.65rem; }
	.profile-card { display: grid; gap: 0.65rem; padding: 0.75rem; border: 1px solid var(--color-border); border-radius: var(--radius-md); background: var(--color-surface-raised); }
	.profile-card__top { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: end; gap: 0.55rem; }
	.profile-card label { display: grid; gap: 0.3rem; min-width: 0; color: var(--color-text-secondary); font-size: var(--text-nano); font-weight: var(--weight-medium); }
	.profile-card input:not([type="radio"]):not([type="checkbox"]) { width: 100%; min-height: 2.3rem; padding: 0 0.6rem; border: 1px solid var(--color-border-strong); border-radius: var(--radius-sm); background: var(--color-control-background); color: var(--color-text); font: inherit; font-size: var(--text-caption); }
	.profile-card input:focus-visible, .toggle-row input:focus-visible { outline: 2px solid var(--color-accent); outline-offset: 2px; }
	.command-input { font-family: var(--font-mono) !important; }
	.icon-danger { display: grid; place-items: center; width: 2.3rem; height: 2.3rem; padding: 0; border: 1px solid transparent; border-radius: var(--radius-control); background: transparent; color: var(--color-text-tertiary); cursor: pointer; }
	.icon-danger:hover { border-color: var(--color-danger-border); background: var(--color-danger-surface-hover); color: var(--color-danger-text); }
	.profile-card__footer { display: flex; align-items: center; justify-content: flex-end; gap: 0.75rem; }
	.save-button:disabled { cursor: wait; opacity: 0.62; }
	.default-profile, .toggle-row { display: inline-flex !important; grid-template-columns: none !important; align-items: center; gap: 0.4rem !important; color: var(--color-text-secondary) !important; font-weight: var(--weight-normal) !important; cursor: pointer; }
	.default-profile input, .toggle-row input { accent-color: var(--color-accent); }
	.startup-row { display: flex; align-items: center; justify-content: space-between; gap: 1rem; padding-top: 0.85rem; border-top: 1px solid var(--color-border-subtle); }
	.startup-row strong { color: var(--color-text); font-size: var(--text-caption); font-weight: var(--weight-medium); }
	.startup-row p { margin: 0.2rem 0 0; color: var(--color-text-tertiary); font-size: var(--text-nano); line-height: var(--leading-body); }
	.toggle-row { flex: 0 0 auto; }
	.feedback { margin: 0; padding: 0.65rem 0.75rem; border-radius: var(--radius-sm); font-size: var(--text-caption); line-height: var(--leading-ui); }
	.feedback--error { background: var(--color-danger-surface-hover); color: var(--color-danger-text); }
	.dialog-footer { display: flex; align-items: center; justify-content: space-between; gap: 1rem; padding-top: 0.1rem; }
	.footnote { margin: 0; color: var(--color-text-tertiary); font-size: var(--text-nano); line-height: var(--leading-body); }
	.save-button { flex: 0 0 auto; padding: 0 0.75rem; border: 0; background: var(--color-accent); color: var(--color-accent-ink); }
	.save-button:hover:not(:disabled) { background: var(--color-accent-hover); }

	@media (max-width: 38rem) {
		.dialog-intro { flex-direction: column; }
		.add-button { align-self: flex-start; }
		.empty-profiles { align-items: flex-start; flex-direction: column; }
		.startup-row, .dialog-footer { align-items: flex-start; flex-direction: column; }
		.toggle-row, .save-button { align-self: stretch; }
		.save-button { width: 100%; }
	}
</style>
