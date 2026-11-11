<script lang="ts">
	import Icon from '$lib/components/Icon.svelte';
	import RuleEditor from '$lib/components/settings/RuleEditor.svelte';
	import { pageTitle } from '$lib/utils/title';
	import { fade, fly } from 'svelte/transition';
	import { invalidateAll } from '$app/navigation';
	import type { PageData } from './$types';
	import { needsRewrite, type LegacyRule, type Rule, type RuleCondition, type TabNote } from '$lib/types/rules';
	import { INBOX_CATEGORIES, isInboxCategory } from '$lib/types/categories';

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

	// --- What a rule says, in words ---

	const FIELD_LABELS: Record<string, string> = { from: 'From', to: 'To', subject: 'Subject', body: 'Body' };
	const OP_LABELS: Record<string, string> = {
		contains: 'contains',
		not_contains: 'doesn’t contain',
		is: 'is exactly',
		starts_with: 'starts with',
		ends_with: 'ends with'
	};

	/** One condition in words, as it reads now or as it read before an upgrade changed it. */
	function conditionText(c: LegacyRule['conditions'][number] | RuleCondition): string {
		const not = c.negate ? 'NOT ' : '';
		const value = (c.value ?? '').trim();
		if (c.field === 'jev') {
			const strictness = 'strictness' in c ? c.strictness : undefined;
			const how = strictness && strictness !== 'normal' ? ` (${strictness})` : '';
			return `${not}Jev judged: “${value}”${how}`;
		}
		if (c.field === 'hasAttachment') return `${not}Has attachment`;
		if (c.field === 'size') return `${not}Size at least ${value} KB`;
		return `${not}${FIELD_LABELS[c.field] ?? c.field} ${OP_LABELS[c.op ?? 'contains'] ?? c.op} “${value}”`;
	}

	const mailboxById = $derived(new Map(data.mailboxes.map((m) => [m.id, m])));
	const labelById = $derived(new Map(data.labels.map((l) => [l.id, l])));

	/** Where a rule files mail, in words; "target missing" when the folder or label is gone. */
	function targetText(rule: Rule): string {
		const t = rule.target;
		if (t.kind === 'label') return labelById.get(t.mailboxId)?.name ?? 'target missing';
		if (t.kind === 'folder') return mailboxById.get(t.mailboxId)?.name ?? 'target missing';
		if (t.kind === 'none') {
			const did = [rule.markRead && 'mark read', rule.star && 'star'].filter(Boolean).join(', ');
			return did || 'nothing';
		}
		const name = { trash: 'Trash', archive: 'Archive', junk: 'Junk' }[t.kind];
		return data.mailboxes.some((m) => m.role === t.kind) ? name : 'target missing';
	}

	/** "From contains “shop” → Receipts" */
	function summary(rule: Rule): string {
		const conds = rule.conditions.map(conditionText).join(rule.logic === 'anyof' ? ' or ' : ' and ');
		return `${conds || 'No conditions'} → ${targetText(rule)}`;
	}

	/** The Inbox tab a rule used to put mail in, before rules stopped setting tabs: "the Updates tab", or null. */
	function legacyTab(rule: Rule): string | null {
		const tab = (rule.legacy?.actions ?? [])
			.filter((a) => a.type === 'setCategory')
			.map((a) => a.value)
			.filter(isInboxCategory)
			.at(-1);
		const label = INBOX_CATEGORIES.find((c) => c.key === tab)?.label;
		return label ? `the ${label} tab` : null;
	}

	/** A running rule's note, short enough for its row in the list. */
	function rowNote(rule: Rule): string {
		if (rule.attention === 'tab_removed') return `No longer puts mail in ${legacyTab(rule) ?? 'an Inbox tab'}.`;
		return `One of ${rule.note?.splitInto ?? 'several'} rules a rule filing in several places became.`;
	}

	const tabName = (key: string | undefined) => INBOX_CATEGORIES.find((c) => c.key === key)?.label ?? 'an Inbox tab';

	/** The mail a sender pin acts on, in words: a pin matches a whole address or a whole domain, nothing looser. */
	function pinReach(sender: string): string {
		return sender.startsWith('@')
			? `any address at ${sender.slice(1)} (the part after the @ has to be exactly that, so not its subdomains)`
			: `exactly the address ${sender}`;
	}

	/** Where a pin and the rule it stands in for differ, for the rule's owner to check. */
	function pinDifference(note: TabNote): string {
		const what = note.pin?.sender.startsWith('@') ? 'that domain' : 'that address';
		if (note.op === 'contains') {
			return `The rule matched any sender containing “${note.said}”; the pin matches only ${what}. Mail it doesn’t match stays in Important.`;
		}
		if (note.op === 'ends_with') {
			return `The rule matched any sender whose address ended with “${note.said}”. The pin matches only ${what}.`;
		}
		if (note.op === 'is') {
			return 'The rule matched this address only when the sender showed no name. The pin matches it with or without one.';
		}
		return '';
	}

	/** Why the upgrade left a rule that only set a tab switched off instead of making it a pin. */
	function whyNotPinned(note: TabNote | undefined): string {
		switch (note?.why) {
			case 'switched_off':
				return `This rule put mail in ${tabName(note.tab)}. It was switched off, so no pin was made.`;
			case 'after_stop':
				return 'An earlier rule stops processing, so this rule may never have run. No pin was made.';
			case 'pinned_elsewhere':
				return note.kept
					? `${note.kept.sender} is already pinned to ${tabName(note.kept.category)}, which was kept. This rule’s tab (${tabName(note.tab)}) is no longer applied.`
					: 'Rules can’t set a tab any more. This one can’t be turned into a sender pin automatically.';
			case 'no_account':
				return 'No mail account was found for these rules.';
			default:
				return 'Rules can’t set a tab any more. This one can’t be turned into a sender pin automatically.';
		}
	}

	// --- Save & apply (SSE stream) ---

	interface Progress {
		status: 'idle' | 'running' | 'done' | 'error';
		scanned: number;
		matched: number;
		applied: number;
		total: number;
		error?: string;
	}
	let progress = $state<Progress>({ status: 'idle', scanned: 0, matched: 0, applied: 0, total: 0 });
	let progressVisible = $state(false);
	let lastApplied: Rule | null = null;
	let abortCtrl: AbortController | null = null;

	async function streamApply(rule: Rule) {
		lastApplied = rule;
		progress = { status: 'running', scanned: 0, matched: 0, applied: 0, total: 0 };
		progressVisible = true;
		abortCtrl = new AbortController();

		try {
			const res = await fetch('/api/rules/apply', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				// The rule was saved a moment ago; the server applies the saved copy.
				body: JSON.stringify({ ruleIds: [rule.id] }),
				signal: abortCtrl.signal
			});
			if (!res.ok || !res.body) {
				progress = { ...progress, status: 'error', error: `HTTP ${res.status}` };
				return;
			}

			const reader = res.body.getReader();
			const decoder = new TextDecoder();
			let buffer = '';

			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				buffer += decoder.decode(value, { stream: true });
				const events = buffer.split('\n\n');
				buffer = events.pop() ?? '';
				for (const ev of events) {
					if (!ev.startsWith('data: ')) continue;
					try {
						handleEvent(JSON.parse(ev.slice(6)));
					} catch {
						// skip malformed SSE frame
					}
				}
			}

			if (progress.status === 'running') progress = { ...progress, status: 'done' };
		} catch (err) {
			if ((err as Error)?.name === 'AbortError') return;
			progress = { ...progress, status: 'error', error: err instanceof Error ? err.message : 'Apply failed' };
		} finally {
			abortCtrl = null;
			// Refresh mailboxes so unread counts reflect mark-read actions etc.
			invalidateAll();
		}
	}

	function handleEvent(data: { type: string; [k: string]: unknown }) {
		if (data.type === 'start') {
			progress = { ...progress, total: (data.total as number) ?? 0 };
		} else if (data.type === 'progress') {
			progress = {
				...progress,
				scanned: (data.scanned as number) ?? progress.scanned,
				matched: (data.matched as number) ?? progress.matched,
				applied: (data.applied as number) ?? progress.applied,
				total: (data.total as number) ?? progress.total
			};
		} else if (data.type === 'done') {
			const failed = (data.failed as number) ?? 0;
			progress = {
				...progress,
				scanned: (data.scanned as number) ?? progress.scanned,
				matched: (data.matched as number) ?? progress.matched,
				applied: (data.applied as number) ?? progress.applied,
				status: failed > 0 ? 'error' : 'done',
				error:
					failed > 0
						? `The mail server rejected ${failed} update${failed === 1 ? '' : 's'}${data.failedReason ? ` — ${data.failedReason}` : ''}.`
						: undefined
			};
		} else if (data.type === 'error') {
			progress = { ...progress, status: 'error', error: (data.message as string) ?? 'Error' };
		}
	}

	function closeOrCancel() {
		if (progress.status === 'running' && abortCtrl) abortCtrl.abort();
		progressVisible = false;
		progress = { status: 'idle', scanned: 0, matched: 0, applied: 0, total: 0 };
	}

	const progressPercent = $derived(
		progress.total > 0 ? Math.min(100, Math.round((progress.scanned / progress.total) * 100)) : 0
	);
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
			{#if movable && (rule.attention === 'tab_removed' || rule.attention === 'split' || rule.note?.splitInto)}
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
					{#if selected?.attention === 'jev_condition'}
						<div class="rounded-xl border border-warning/30 bg-warning/10 p-4 flex flex-col gap-2" role="note">
							<p class="text-sm font-medium text-text">This rule is switched off</p>
							<p class="text-xs text-text-secondary">
								It had a condition Jev judged, and rules now match exactly: by sender, recipient,
								subject, body, size or attachment. Without that condition it would act on more mail
								than you wrote it for, so it no longer runs. This is what it said:
							</p>
							{#if selected.legacy}
								<ul class="text-xs text-text list-disc pl-5 flex flex-col gap-0.5">
									{#each selected.legacy.conditions as c, i (i)}
										<li>{conditionText(c)}</li>
									{/each}
								</ul>
								<p class="text-2xs text-text-tertiary">
									It matched {selected.legacy.logic === 'anyof' ? 'ANY' : 'ALL'} of these{selected.legacy.enabled ? '' : ', and was already switched off'}.
								</p>
							{/if}
							{#if legacyTab(selected)}
								<p class="text-xs text-text-secondary">
									It also moved that mail to {legacyTab(selected)}, which a rule can no longer do.
								</p>
							{/if}
							<p class="text-xs text-text-secondary">
								Rewrite it below with exact conditions and press
								<span class="text-text">Save as exact rule</span> to switch it back on, or delete it.
							</p>
						</div>
					{:else if selected?.attention === 'tab_rule'}
						{@const note = selected.note?.tab}
						<div class="rounded-xl border border-warning/30 bg-warning/10 p-4 flex flex-col gap-2" role="note">
							<p class="text-sm font-medium text-text">This rule is switched off</p>
							<p class="text-xs text-text">{whyNotPinned(note)}</p>
							<p class="text-xs text-text-secondary">
								All it did was move mail to {legacyTab(selected) ?? 'an Inbox tab'}, and rules no longer
								put mail in a tab: sender pins do that now, whether Jev is on or off. It matched mail
								like this:
							</p>
							{#if selected.legacy}
								<ul class="text-xs text-text list-disc pl-5 flex flex-col gap-0.5">
									{#each selected.legacy.conditions as c, i (i)}
										<li>{conditionText(c)}</li>
									{/each}
								</ul>
								{#if selected.legacy.conditions.length > 1}
									<p class="text-2xs text-text-tertiary">
										It matched {selected.legacy.logic === 'anyof' ? 'ANY' : 'ALL'} of these.
									</p>
								{/if}
							{/if}
							{#if note?.pin}
								{@const pin = note.pin}
								<p class="text-xs text-text-secondary">
									A pin can do this instead. It would act on new mail from {pinReach(pin.sender)}.
									{pinDifference(note)}
								</p>
								<button onclick={() => pinInstead(selected.id)} disabled={busy} class="btn btn-primary self-start">
									{note.kept?.sender === pin.sender
										? `Pin to ${tabName(pin.category)} instead`
										: `Pin ${pin.sender} to ${tabName(pin.category)}`}
								</button>
								<p class="text-xs text-text-secondary">
									That makes the pin and removes this rule. Or give the rule something else to do
									below, a label or a folder, and press <span class="text-text">Save as exact rule</span>.
								</p>
							{:else}
								<p class="text-xs text-text-secondary">
									To keep those senders in their tab, pin them under
									<a href="/settings/jev" class="underline">Settings → Jev → Pinned senders</a> and delete
									this rule. Or give it something else to do below, a label or a folder, and press
									<span class="text-text">Save as exact rule</span>.
								</p>
							{/if}
						</div>
					{:else if selected?.attention === 'tab_pinned'}
						{@const note = selected.note?.tab}
						<div class="rounded-xl border border-warning/30 bg-warning/10 p-4 flex flex-col gap-2" role="note">
							{#if note?.pin}
								{@const pin = note.pin}
								<p class="text-sm font-medium text-text">
									{note.existing
										? `${pin.sender} was already pinned to ${tabName(pin.category)}.`
										: `This rule became a sender pin: ${pin.sender} → ${tabName(pin.category)}.`}
								</p>
								<p class="text-xs text-text-secondary">
									{note.existing
										? 'All it did was move mail to that tab, and you had already pinned this sender there, so your pin does its work now.'
										: 'All it did was move mail to that tab. Rules no longer do that; a pin does, whether Jev is on or off.'}
									The pin acts on new mail from {pinReach(pin.sender)}.
									{pinDifference(note)}
								</p>
							{:else}
								<p class="text-sm font-medium text-text">This rule became a sender pin</p>
							{/if}
							<p class="text-xs text-text-secondary">
								You can change or remove the pin under
								<a href="/settings/jev" class="underline">Settings → Jev → Pinned senders</a>. The rule is
								switched off and has nothing left to do; it stays here only until you have seen this.
							</p>
							<button onclick={() => dismiss(selected.id)} disabled={busy} class="btn btn-secondary self-start">
								Got it
							</button>
						</div>
					{:else if selected?.attention === 'tab_removed'}
						<div class="rounded-xl border border-warning/30 bg-warning/10 p-4 flex flex-col gap-2" role="note">
							<p class="text-sm font-medium text-text">
								This rule no longer puts mail in {legacyTab(selected) ?? 'an Inbox tab'}.
							</p>
							<p class="text-xs text-text-secondary">
								It used to move mail to {legacyTab(selected) ?? 'an Inbox tab'} as well. Rules no longer
								put mail in a tab, so that part was removed; the rest of the rule runs as before. To
								keep a sender’s mail in that tab, pin the sender under
								<a href="/settings/jev" class="underline">Settings → Jev → Pinned senders</a>.
								“Got it” beside it in the list clears this note.
							</p>
						</div>
					{/if}
					{#if selected?.note?.splitInto}
						<div class="rounded-xl border border-warning/30 bg-warning/10 p-4 flex flex-col gap-2" role="note">
							<p class="text-sm font-medium text-text">
								This rule filed mail in several places, so it is now {selected.note.splitInto} rules.
							</p>
							<p class="text-xs text-text-secondary">
								A rule files into one place now. The rules it became sit side by side in the list and
								together do what it did, except that where it moved mail to two folders, the first one
								decides.
							</p>
							<!-- A rule that runs has its "Got it" on its row in the list. -->
							{#if needsRewrite(selected)}
								<button onclick={() => dismiss(selected.id)} disabled={busy} class="btn btn-secondary self-start">
									Got it
								</button>
							{/if}
						</div>
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

{#if progressVisible}
	<div class="fixed inset-0 z-50 flex items-center justify-center bg-black/50" transition:fade={{ duration: 150 }}>
		<div
			class="w-[420px] bg-surface border border-border rounded-2xl p-5 shadow-[0_16px_64px_rgba(0,0,0,0.5)]"
			transition:fly={{ y: 16, duration: 200 }}
		>
			<div class="flex items-center gap-2 mb-3">
				{#if progress.status === 'running'}
					<span class="w-3 h-3 rounded-full border-2 border-accent/40 border-t-accent animate-spin"></span>
					<h2 class="text-sm font-semibold text-text">Applying rule…</h2>
				{:else if progress.status === 'done'}
					<Icon name="check" size={16} class="text-success" />
					<h2 class="text-sm font-semibold text-text">Applied</h2>
				{:else if progress.status === 'error'}
					<Icon name="error" size={16} class="text-danger" />
					<h2 class="text-sm font-semibold text-text">Failed</h2>
				{/if}
			</div>

			<div class="h-1.5 bg-surface-hover rounded-full overflow-hidden mb-3">
				<div
					class="h-full bg-accent transition-all duration-300 ease-out"
					style="width: {progress.status === 'done' ? 100 : progressPercent}%;"
				></div>
			</div>

			<div class="flex items-baseline gap-3 text-xs text-text-secondary mb-4">
				<span>Scanned <span class="text-text font-medium tabular-nums">{progress.scanned.toLocaleString()}</span></span>
				<span class="text-text-tertiary">·</span>
				<span>Matched <span class="text-text font-medium tabular-nums">{progress.matched.toLocaleString()}</span></span>
				<span class="text-text-tertiary">·</span>
				<span>Applied <span class="text-text font-medium tabular-nums">{progress.applied.toLocaleString()}</span></span>
				{#if progress.total > 0}
					<span class="text-text-tertiary ml-auto">of {progress.total.toLocaleString()}</span>
				{/if}
			</div>

			{#if progress.status === 'error' && progress.error}
				<p class="px-3 py-2 rounded-lg bg-danger/10 border border-danger/20 text-danger text-xs mb-4">
					{progress.error}
				</p>
			{/if}

			<div class="flex items-center gap-2 justify-end">
				{#if progress.status === 'running'}
					<button
						onclick={() => (progressVisible = false)}
						class="text-xs text-text-tertiary hover:text-text px-3 py-1.5 rounded-lg transition-colors cursor-pointer"
					>
						Run in background
					</button>
					<button onclick={closeOrCancel} class="btn btn-danger btn-sm">Cancel</button>
				{:else if progress.status === 'error'}
					<button
						onclick={closeOrCancel}
						class="text-xs text-text-tertiary hover:text-text px-3 py-1.5 rounded-lg transition-colors cursor-pointer"
					>
						Close
					</button>
					<button onclick={() => lastApplied && streamApply(lastApplied)} class="btn btn-primary btn-sm">Retry</button>
				{:else}
					<button onclick={closeOrCancel} class="btn btn-primary btn-sm">Done</button>
				{/if}
			</div>
		</div>
	</div>
{/if}
