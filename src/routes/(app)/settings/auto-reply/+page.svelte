<script lang="ts">
	import { untrack } from 'svelte';
	import { pageTitle } from '$lib/utils/title';
	import { invalidateAll } from '$app/navigation';
	import SettingRow from '$lib/components/settings/SettingRow.svelte';
	import Toggle from '$lib/components/settings/Toggle.svelte';
	import { useDraft } from '$lib/settings/draft.svelte';
	import { sendJson } from '$lib/settings/send';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	type Form = { enabled: boolean; from: string; until: string; subject: string; body: string };

	let status = $state(untrack(() => data.status));

	// The form starts from what is saved, and is sent only by Save in the
	// bar at the foot of the page, whole, as the server takes it.
	const draft = useDraft<Form>({
		initial: untrack(() => $state.snapshot(data.autoReply)),
		// Checked here as the server checks it, so a mistake shows before Save.
		check: ({ enabled, from, until, body }) =>
			from && until && until < from
				? 'The end date is before the start date.'
				: enabled && !body.trim()
					? 'Write the message to send.'
					: '',
		async persist(_changed, all) {
			const result = (await sendJson('/api/preferences/auto-reply', {
				...all,
				// The dates are the owner's days, in the time zone they are in now.
				tz: Intl.DateTimeFormat().resolvedOptions().timeZone
			})) as { status?: string } | null;
			status = result?.status ?? status;
			await invalidateAll();
		}
	});

	const when = (iso: string) =>
		new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

	const inputClass =
		'bg-surface-hover border border-border rounded-lg px-2.5 py-1.5 text-sm text-text placeholder-text-tertiary outline-none focus:border-accent';
</script>

<svelte:head><title>{pageTitle({ page: 'Auto-reply', subtitle: 'Settings' })}</title></svelte:head>

<header class="mb-6">
	<h1 class="text-xl font-semibold text-text">Auto-reply</h1>
	<p class="text-sm text-text-tertiary mt-1">
		Answer new mail automatically while you’re away. One setting covers all your linked accounts.
	</p>
	<p class="text-sm mt-2" data-testid="auto-reply-status">
		<span class="text-text-tertiary">Status:</span>
		<span class="font-medium text-text">{status}</span>
	</p>
</header>

<section>
	<SettingRow title="Send automatic replies" description="Nothing changes until you press Save.">
		{#snippet control()}
			<Toggle checked={draft.value.enabled} ariaLabel="Send automatic replies" onChange={(v) => (draft.value.enabled = v)} />
		{/snippet}
	</SettingRow>

	<SettingRow title="From" description="Optional. The first day replies are sent.">
		{#snippet control()}
			<input type="date" aria-label="From" bind:value={draft.value.from} class="{inputClass} w-[180px]" />
		{/snippet}
	</SettingRow>

	<SettingRow title="Until" description="Optional. The last day replies are sent.">
		{#snippet control()}
			<input type="date" aria-label="Until" bind:value={draft.value.until} min={draft.value.from || undefined} class="{inputClass} w-[180px]" />
		{/snippet}
	</SettingRow>

	<SettingRow title="Subject" description="Optional. Left empty, it is “Automatic reply:” and the original subject.">
		{#snippet control()}
			<input aria-label="Subject" bind:value={draft.value.subject} placeholder="Out of office" class="{inputClass} w-[280px]" />
		{/snippet}
	</SettingRow>

	<SettingRow title="Message" description="Sent as plain text.">
		{#snippet control()}
			<textarea
				aria-label="Message"
				bind:value={draft.value.body}
				rows={5}
				placeholder="I'm out of the office until next week…"
				class="{inputClass} w-[360px] resize-none font-sans"
			></textarea>
		{/snippet}
	</SettingRow>
</section>

<section class="mt-8 text-sm text-text-secondary space-y-1">
	<h2 class="text-sm font-semibold text-text">How replies are sent</h2>
	<ul class="list-disc pl-5 space-y-1">
		<li>Zajel sends them itself, while it is running. Mail that arrives while it is stopped gets no reply.</li>
		<li>To the sender’s own address, never to a different reply-to address the message asks for.</li>
		<li>At most one reply per person per day, across all your accounts.</li>
		<li>Never to newsletters, mailing lists, automatic mail or delivery reports, and never to mail sent before you switched it on.</li>
	</ul>
</section>

<section class="mt-8">
	<h2 class="text-sm font-semibold text-text mb-2">Replies sent</h2>
	{#if data.sent.length === 0}
		<p class="text-sm text-text-tertiary">None yet.</p>
	{:else}
		<ul class="text-sm space-y-1">
			{#each data.sent as reply, i (i)}
				<li class="flex gap-3">
					<span class="text-text">{reply.to}</span>
					<span class="text-text-tertiary">{when(reply.at)}</span>
					{#if data.multipleAccounts}<span class="text-text-tertiary">from {reply.account}</span>{/if}
				</li>
			{/each}
		</ul>
	{/if}
</section>
