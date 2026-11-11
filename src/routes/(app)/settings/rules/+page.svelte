<script lang="ts">
	import Icon from '$lib/components/Icon.svelte';
	import RuleEditor from '$lib/components/settings/RuleEditor.svelte';
	import { pageTitle } from '$lib/utils/title';
	import RuleAttention from '$lib/components/settings/RuleAttention.svelte';
	import RuleApplyDialog from '$lib/components/settings/RuleApplyDialog.svelte';
	import { fly } from 'svelte/transition';
	import type { PageData } from './$types';
	import { needsRewrite, type Rule } from '$lib/types/rules';
	import { hasRowNote, rowNote, ruleSummary } from '$lib/rules/describe';

	let { data }: { data: PageData } = $props();

	// The saved rules, in the order they run, as the server last listed them.
	// Every change is saved at once through /api/rules and the list read back.
	// svelte-ignore state_referenced_locally
	let rules = $state<Rule[]>(data.rules ?? []);
	/** The rule open in the editor, 'new' for one not yet saved, or null. */
	// svelte-ignore state_referenced_locally
	let selectedId = $state<string | null>(data.rules[0]?.id ?? null);
	const selected = $derived(rules.find((r) => r.id === selectedId) ?? null);

	// Rules an upgrade switched off until their owner deals with them are
	// listed apart, so they aren't missed. Every rule that can run is in the
	// main list, in its real order: one carrying only a note (it was split,
	// or lost its tab) still runs, so it stays where it runs, note and all.
	const attentionRules = $derived(rules.filter((r) => needsRewrite(r)));
	const mainRules = $derived(rules.filter((r) => !needsRewrite(r)));

	let busy = $state(false);
	let saveError = $state('');
	let savedToast = $state(false);

	async function refresh() {
		const res = await fetch('/api/rules').catch(() => null);
		if (res?.ok) rules = ((await res.json()) as { rules: Rule[] }).rules;
	}

	/** A change to the saved rules: sent, then the list read back. False when the server said no. */
	async function send(url: string, init: RequestInit): Promise<boolean> {
		busy = true;
		saveError = '';
		try {
			const res = await fetch(url, { headers: { 'Content-Type': 'application/json' }, ...init }).catch(() => null);
			if (!res?.ok) {
				saveError = (await res?.json().catch(() => null))?.error ?? 'That didn’t save. Try again.';
				return false;
			}
			await refresh();
			return true;
		} finally {
			busy = false;
		}
	}

	const toggleEnabled = (rule: Rule) =>
		send(`/api/rules/${encodeURIComponent(rule.id)}`, { method: 'PATCH', body: JSON.stringify({ enabled: !rule.enabled }) });

	/**
	 * Move a rule one place up or down the main list: it changes places with
	 * its neighbour there, and nothing else moves. The rules waiting under
	 * "Needs your attention" keep their places in the real order between them.
	 */
	async function move(rule: Rule, by: -1 | 1) {
		const at = mainRules.findIndex((r) => r.id === rule.id);
		const other = at === -1 ? undefined : mainRules[at + by];
		if (!other) return;
		const ids = rules.map((r) => r.id);
		const i = ids.indexOf(rule.id);
		const j = ids.indexOf(other.id);
		[ids[i], ids[j]] = [ids[j], ids[i]];
		await send('/api/rules/reorder', { method: 'POST', body: JSON.stringify({ ids }) });
	}

	const dismiss = (id: string) => send(`/api/rules/${encodeURIComponent(id)}/dismiss`, { method: 'POST' });

	/** Make the pin a flagged tab rule names, and remove the rule: one call, so a failure leaves the rule where it is. */
	const pinInstead = (id: string) => send(`/api/rules/${encodeURIComponent(id)}/pin`, { method: 'POST' });

	async function onSaved(rule: Rule, apply: boolean) {
		await refresh();
		selectedId = rule.id;
		if (apply) {
			await streamApply(rule);
		} else {
			savedToast = true;
			setTimeout(() => (savedToast = false), 1600);
		}
	}

	async function onDeleted(id: string) {
		await refresh();
		if (selectedId === id) selectedId = rules[0]?.id ?? null;
	}

	const summary = (rule: Rule) => ruleSummary(rule, data.mailboxes, data.labels);

	/** The rule "Save & apply" is running, while its progress shows. */
	let applying = $state<Rule | null>(null);
	const streamApply = async (rule: Rule) => {
		applying = rule;
	};
</script>

<svelte:head><title>{pageTitle({ page: 'Filters & Rules', subtitle: 'Settings' })}</title></svelte:head>

{#snippet ruleRow(rule: Rule, group: Rule[], index: number, movable: boolean)}
	<li
		class="group relative flex items-center gap-2 pl-3 pr-1 py-2 rounded-lg transition-all
			{selectedId === rule.id
				? 'bg-accent/10 border-l-2 border-accent text-text'
				: 'border-l-2 border-transparent text-text-secondary hover:bg-surface-hover hover:text-text'}"
	>
		{#if needsRewrite(rule)}
			<!-- Switched off until it is rewritten: there is nothing to toggle. -->
			<span class="shrink-0 text-warning" title="Switched off until you rewrite it">
				<Icon name="error" size={12} aria-label="Switched off until you rewrite it" />
			</span>
		{:else}
			<button
				onclick={() => toggleEnabled(rule)}
				disabled={busy}
				title={rule.enabled ? 'Disable rule' : 'Enable rule'}
				class="w-2.5 h-2.5 rounded-full shrink-0 border cursor-pointer transition-colors
					{rule.enabled ? 'bg-success border-success' : 'bg-transparent border-text-tertiary/50'}"
				aria-label={rule.enabled ? 'Disable rule' : 'Enable rule'}
			></button>
		{/if}
		<div class="flex-1 min-w-0 flex flex-col">
			<button class="min-w-0 text-left cursor-pointer" onclick={() => (selectedId = rule.id)}>
				<span class="block truncate text-sm">{rule.name || 'Untitled rule'}</span>
				<span class="block truncate text-2xs text-text-tertiary">{summary(rule)}</span>
			</button>
			{#if movable && hasRowNote(rule)}
				<!-- A note on a rule that runs: said where it runs, until it is read. -->
				<span class="flex items-center gap-2 text-2xs text-warning" role="note">
					<span class="truncate">{rowNote(rule)}</span>
					<button onclick={() => dismiss(rule.id)} disabled={busy} class="shrink-0 underline cursor-pointer disabled:opacity-50">
						Got it
					</button>
				</span>
			{/if}
		</div>
		{#if movable}
			<div class="flex flex-col shrink-0">
				<button
					onclick={() => move(rule, -1)}
					disabled={busy || index === 0}
					aria-label="Move up"
					title="Move up"
					class="text-text-tertiary hover:text-text disabled:opacity-30 cursor-pointer px-1 text-2xs leading-none"
				>▲</button>
				<button
					onclick={() => move(rule, 1)}
					disabled={busy || index === group.length - 1}
					aria-label="Move down"
					title="Move down"
					class="text-text-tertiary hover:text-text disabled:opacity-30 cursor-pointer px-1 text-2xs leading-none"
				>▼</button>
			</div>
		{/if}
	</li>
{/snippet}

<div class="h-full flex flex-col overflow-hidden">
	<!-- Title flush with the content edge and sized like every other settings
	     page; the way back to mail is in the settings menu. -->
	<header class="pb-4 border-b border-border flex items-center gap-3 shrink-0">
		<h1 class="text-xl font-semibold text-text">Rules</h1>
		<p class="text-xs text-text-tertiary">{rules.length} {rules.length === 1 ? 'rule' : 'rules'}</p>
		<div class="flex-1"></div>
		<button onclick={() => (selectedId = 'new')} class="btn btn-primary">+ New rule</button>
	</header>

	{#if saveError}
		<div class="mx-6 mt-3 px-3 py-2 rounded-lg bg-danger/10 border border-danger/20 text-danger text-xs" role="alert">{saveError}</div>
	{/if}

	<div class="flex-1 flex min-h-0 overflow-hidden">
		<!-- Rule list, in the order the rules run -->
		<aside class="w-[300px] shrink-0 border-r border-border overflow-y-auto py-3 px-2">
			{#if rules.length === 0}
				<p class="text-xs text-text-tertiary text-center py-8 px-3">
					No rules yet. Click “New rule” to get started.
				</p>
			{:else}
				{#if attentionRules.length > 0}
					<h2 class="px-3 pb-1.5 text-2xs font-semibold text-warning uppercase tracking-wide">Needs your attention</h2>
					<ul class="flex flex-col gap-0.5 mb-3">
						{#each attentionRules as rule, i (rule.id)}
							{@render ruleRow(rule, attentionRules, i, false)}
						{/each}
					</ul>
					{#if mainRules.length > 0}
						<h2 class="px-3 pb-1.5 text-2xs font-semibold text-text-tertiary uppercase tracking-wide">Rules</h2>
					{/if}
				{/if}
				<ul class="flex flex-col gap-0.5">
					{#each mainRules as rule, i (rule.id)}
						{@render ruleRow(rule, mainRules, i, true)}
					{/each}
				</ul>
			{/if}
		</aside>

		<!-- Editor -->
		<section class="flex-1 overflow-y-auto min-w-0">
			{#if selectedId === null || (selectedId !== 'new' && !selected)}
				<div class="h-full flex items-center justify-center text-text-tertiary text-sm px-6">
					Select a rule from the list, or click “New rule” to create one.
				</div>
			{:else}
				<div class="px-6 py-5 flex flex-col gap-5 max-w-[720px]">
					{#if selected}
						<RuleAttention rule={selected} {busy} onDismiss={dismiss} onPin={pinInstead} />
					{/if}

					<!-- What is left of a rule that became a pin is only its note: there is nothing to edit. -->
					{#if selected?.attention !== 'tab_pinned'}
						{#key selectedId}
							<RuleEditor
								rule={selected}
								mailboxes={data.mailboxes}
								labels={data.labels}
								{onSaved}
								{onDeleted}
								onCancel={() => (selectedId = selectedId === 'new' ? (rules[0]?.id ?? null) : null)}
							/>
						{/key}
					{/if}
				</div>
			{/if}
		</section>
	</div>
</div>

{#if savedToast}
	<div
		class="fixed bottom-[calc(1.5rem-var(--app-under))] left-1/2 -translate-x-1/2 bg-surface border border-border rounded-full px-4 py-2 text-sm text-text shadow-lg z-50"
		transition:fly={{ y: 12, duration: 200 }}
	>
		Saved
	</div>
{/if}

{#if applying}
	<RuleApplyDialog rule={applying} onClose={() => (applying = null)} />
{/if}
