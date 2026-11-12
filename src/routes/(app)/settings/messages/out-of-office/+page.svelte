<script lang="ts">
	import { untrack } from 'svelte';
	import { pageTitle } from '$lib/utils/title';
	import { invalidateAll } from '$app/navigation';
	import PageHeader from '$lib/components/settings/PageHeader.svelte';
	import Section from '$lib/components/settings/Section.svelte';
	import SettingRow from '$lib/components/settings/SettingRow.svelte';
	import Toggle from '$lib/components/settings/Toggle.svelte';
	import { useDraft } from '$lib/settings/draft.svelte';
	import { sendJson } from '$lib/settings/send';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	type Form = { enabled: boolean; from: string; until: string; subject: string; body: string };

	let status = $state(untrack(() => data.status));

	// The form starts from what is saved, and is sent only by Save in the
	// pill at the foot of the page, whole, as the server takes it.
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
		'bg-transparent border border-border rounded-md px-2.5 text-sm text-text placeholder-text-tertiary outline-none focus:border-accent transition-colors';
</script>

<svelte:head><title>{pageTitle({ page: 'Out of office', subtitle: 'Settings' })}</title></svelte:head>

<PageHeader title="Out of office">
	{#snippet actions()}
		<!-- What is happening now, as the server has it: off, waiting for its
		     first day, sending, or over. -->
		<p class="text-sm text-text-tertiary" data-testid="auto-reply-status">{status}</p>
	{/snippet}
</PageHeader>

<Section>
	<SettingRow title="Automatic replies">
		{#snippet control()}
			<Toggle checked={draft.value.enabled} ariaLabel="Send automatic replies" onChange={(v) => (draft.value.enabled = v)} />
		{/snippet}
	</SettingRow>

	<SettingRow title="From">
		{#snippet control()}
			<input type="date" aria-label="From" bind:value={draft.value.from} class="{inputClass} h-8.5 w-[180px]" />
		{/snippet}
	</SettingRow>

	<SettingRow title="Until">
		{#snippet control()}
			<input type="date" aria-label="Until" bind:value={draft.value.until} min={draft.value.from || undefined} class="{inputClass} h-8.5 w-[180px]" />
		{/snippet}
	</SettingRow>

	<SettingRow title="Subject">
		{#snippet control()}
			<input aria-label="Subject" bind:value={draft.value.subject} placeholder="Automatic reply: …" class="{inputClass} h-8.5 w-[280px] max-w-full" />
		{/snippet}
	</SettingRow>

	<SettingRow title="Message">
		{#snippet control()}
			<textarea
				aria-label="Message"
				bind:value={draft.value.body}
				rows={5}
				class="{inputClass} py-2 w-[360px] max-w-full resize-none font-sans"
			></textarea>
		{/snippet}
	</SettingRow>
</Section>

<!-- Who gets a reply and who never does is not something the form shows,
     and it matters: it stays, folded away. -->
<details class="mb-8 text-sm text-text-secondary">
	<summary class="cursor-pointer text-[0.8125rem] font-semibold text-text-tertiary hover:text-text transition-colors">
		How replies are sent
	</summary>
	<ul class="list-disc pl-5 mt-2 space-y-1">
		<li>Zajel sends them itself, while it is running. Mail that arrives while it is stopped gets no reply.</li>
		<li>To the sender’s own address, never to a different reply-to address the message asks for.</li>
		<li>At most one reply per person per day, across all your accounts.</li>
		<li>Never to newsletters, mailing lists, automatic mail or delivery reports, and never to mail sent before you switched it on.</li>
	</ul>
</details>

{#if data.sent.length > 0}
	<Section title="Replies sent">
		{#each data.sent as reply, i (i)}
			<div class="flex flex-wrap items-center gap-x-4 gap-y-0.5 min-h-12 px-5 py-2 max-md:px-4 text-sm">
				<span class="flex-1 min-w-0 truncate text-text">{reply.to}</span>
				{#if data.multipleAccounts}<span class="text-text-tertiary">from {reply.account}</span>{/if}
				<span class="text-text-tertiary">{when(reply.at)}</span>
			</div>
		{/each}
	</Section>
{/if}
