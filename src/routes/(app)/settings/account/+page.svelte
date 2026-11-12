<script lang="ts">
	import { untrack } from 'svelte';
	import { pageTitle } from '$lib/utils/title';
	import { invalidateAll } from '$app/navigation';
	import SettingRow from '$lib/components/settings/SettingRow.svelte';
	import TextInput from '$lib/components/settings/TextInput.svelte';
	import { useDraft } from '$lib/settings/draft.svelte';
	import { sendJson } from '$lib/settings/send';
	import type { LayoutData } from '../$types';

	let { data }: { data: LayoutData } = $props();

	// Stored when Save is pressed in the bar at the foot of the page.
	const draft = useDraft({
		// What the page opened with; later reloads of `data` leave the form alone.
		initial: untrack(() => ({ displayName: data.displayName })),
		async persist(_changed, all) {
			await sendJson('/api/preferences/settings', { displayName: all.displayName });
			// The header shows the name too.
			await invalidateAll();
			// The server stores it without the spaces around it.
			return { displayName: all.displayName.trim() };
		}
	});
</script>

<svelte:head><title>{pageTitle({ page: 'Account', subtitle: 'Settings' })}</title></svelte:head>

<header class="mb-6">
	<h1 class="text-xl font-semibold text-text">Account</h1>
	<p class="text-sm text-text-tertiary mt-1">Your identity and personal details.</p>
</header>

<section>
	<SettingRow
		title="Display name"
		description="Shown on your profile card in the header, and as the organiser on calendar invitations you send. Outgoing mail carries the name of the address it is sent from, which comes from the mail server."
	>
		{#snippet control()}
			<TextInput bind:value={draft.value.displayName} ariaLabel="Display name" placeholder="Your name" maxlength={120} />
		{/snippet}
	</SettingRow>

	<div class="mt-4 text-xs text-text-tertiary">
		Manage signatures on the
		<a href="/settings/signatures" class="text-accent-fg hover:underline">Signatures</a> page.
	</div>
</section>
