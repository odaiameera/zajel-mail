<script lang="ts">
	import Icon from '$lib/components/Icon.svelte';
	import { pageTitle } from '$lib/utils/title';
	import { slide, fade, fly } from 'svelte/transition';
	import { invalidateAll } from '$app/navigation';
	import { onDestroy } from 'svelte';
	import type { PageData } from './$types';
	import {
		isUsableCondition,
		needsRewrite,
		type LegacyRule,
		type Rule,
		type RuleAction,
		type TabNote
	} from '$lib/types/rules';
	import { INBOX_CATEGORIES, isInboxCategory } from '$lib/types/categories';
	import { findLabelsParentId, isLabelMailbox, isLabelsParent } from '$lib/types/labels';

	let { data }: { data: PageData } = $props();

	// Working copy. Edits here stay local until the user hits Save.
	let localRules = $state<Rule[]>(structuredClone(data.rules ?? []));
	let selectedId = $state<string | null>(data.rules[0]?.id ?? null);

	const selectedIdx = $derived(localRules.findIndex((r) => r.id === selectedId));

	// Rules an upgrade had to change, listed apart so they aren't missed.
	const attentionRules = $derived(localRules.filter((r) => r.attention));
	const otherRules = $derived(localRules.filter((r) => !r.attention));

	// Sort user folders (moveToFolder targets) and labels once.
	const labelsParentId = $derived(findLabelsParentId(data.mailboxes));
	const folderOptions = $derived(
		data.mailboxes
			.filter((m) => m.role === null && !isLabelMailbox(m, labelsParentId) && !isLabelsParent(m, labelsParentId))
			.sort((a, b) => a.name.localeCompare(b.name))
	);
	const systemFolderOptions = $derived(
		data.mailboxes.filter((m) => m.role === 'archive' || m.role === 'junk' || m.role === 'trash')
	);
	const labelOptions = $derived(data.labels);

	/**
	 * A saved action can point at a folder/label that was deleted after the
	 * rule was created — the select then renders blank and applying the rule
	 * silently does nothing server-side. Flag it loudly instead.
	 */
	function isStaleTarget(action: { type: string; value?: string }): boolean {
		if (!action.value) return false;
		if (action.type === 'applyLabel') {
			return !labelOptions.some((l) => l.id === action.value);
		}
		if (action.type === 'moveToFolder') {
			return (
				!folderOptions.some((m) => m.id === action.value) &&
				!systemFolderOptions.some((m) => m.id === action.value)
			);
		}
		return false;
	}

	// --- Save / deploy ---

	let saving = $state(false);
	let deployError = $state('');
	let deployWarning = $state('');
	let savedToast = $state(false);

	async function persistAll(): Promise<boolean> {
		saving = true;
		deployError = '';
		try {
			await fetch('/api/preferences/rules', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ rules: localRules })
			});
			const deployRes = await fetch('/api/rules/deploy', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ rules: localRules })
			});
			const deployData = await deployRes.json();
			// Sieve deploy is best-effort: rules are stored server-side and
			// applied by the app engine either way. A deploy failure (e.g.
			// Sieve unsupported/disabled on the mail server) must not block
			// saving or applying — surface it as a warning instead.
			deployWarning = deployData.error
				? `Rules saved. Delivery-time (Sieve) deploy failed: ${deployData.error} — rules still run through the app's own engine.`
				: deployData.deactivated
					? // A mail server runs one active Sieve script; activating ours switched the other off.
						`Rules saved. Your mail server's other Sieve script “${deployData.deactivated}” is no longer active; Zajel's rules run in its place.`
					: '';
			await invalidateAll();
			return true;
		} catch (err) {
			deployError = err instanceof Error ? err.message : 'Save failed';
			return false;
		} finally {
			saving = false;
		}
	}

	async function saveOnly() {
		const ok = await persistAll();
		if (ok) {
			savedToast = true;
			setTimeout(() => { savedToast = false; }, 1600);
		}
	}

	// --- Rule CRUD in the list ---

	function newRuleId(): string {
		return 'rule_' + Math.random().toString(36).slice(2) + '_' + Date.now();
	}

	async function createRule() {
		const rule: Rule = {
			id: newRuleId(),
			name: 'New rule',
			enabled: true,
			logic: 'allof',
			conditions: [{ id: 'c_' + Date.now(), field: 'from', op: 'contains', value: '', negate: false }],
			actions: [{ type: 'applyLabel' }],
			createdAt: Date.now()
		};
		localRules = [...localRules, rule];
		selectedId = rule.id;
		await persistAll();
	}

	async function toggleEnabled(id: string) {
		localRules = localRules.map((r) => (r.id === id ? { ...r, enabled: !r.enabled } : r));
		await persistAll();
	}

	async function deleteRule(id: string) {
		const r = localRules.find((x) => x.id === id);
		if (!r) return;
		if (!confirm(`Delete rule "${r.name}"? This cannot be undone.`)) return;
		await removeRule(id);
	}

	/** Take a rule out of the list and save. Unasked for what is left of a rule that became a pin. */
	async function removeRule(id: string) {
		localRules = localRules.filter((x) => x.id !== id);
		if (selectedId === id) selectedId = localRules[0]?.id ?? null;
		await persistAll();
	}

	/**
	 * Make the pin a flagged tab rule names (its sender, to the rule's tab),
	 * and remove the rule: the pin does what it did. The pin is saved first,
	 * so a failure leaves the rule where it is.
	 */
	async function pinInstead(id: string) {
		const pin = localRules.find((r) => r.id === id)?.tabNote?.pin;
		if (!pin) return;
		deployError = '';
		const res = await fetch('/api/jev/pins', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ sender: pin.sender, category: pin.category })
		}).catch(() => null);
		if (!res?.ok) {
			const body = await res?.json().catch(() => null);
			deployError = body?.error ?? 'Couldn’t save the pin. Try again.';
			return;
		}
		await removeRule(id);
	}

	// --- Rules that need attention ---

	const FIELD_LABELS: Record<string, string> = {
		from: 'From',
		to: 'To',
		subject: 'Subject',
		body: 'Body'
	};
	const OP_LABELS: Record<string, string> = {
		contains: 'contains',
		not_contains: 'doesn’t contain',
		is: 'is exactly',
		starts_with: 'starts with',
		ends_with: 'ends with'
	};

	/** One condition of a rule as it was before an upgrade changed it, in words. */
	function legacyConditionText(c: LegacyRule['conditions'][number]): string {
		const not = c.negate ? 'NOT ' : '';
		const value = (c.value ?? '').trim();
		if (c.field === 'jev') {
			const how = c.strictness && c.strictness !== 'normal' ? ` (${c.strictness})` : '';
			return `${not}Jev judged: “${value}”${how}`;
		}
		if (c.field === 'hasAttachment') return `${not}Has attachment`;
		if (c.field === 'size') return `${not}Size at least ${value} KB`;
		return `${not}${FIELD_LABELS[c.field] ?? c.field} ${OP_LABELS[c.op ?? 'contains'] ?? c.op} “${value}”`;
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

	/** Enough of a rule to run: something to match on, and something to do. */
	function canRunAsExact(rule: Rule): boolean {
		return rule.conditions.some(isUsableCondition) && rule.actions.length > 0;
	}

	/**
	 * The owner has rewritten a flagged rule with exact conditions: the flag
	 * and the old copy go, and the rule is switched back on.
	 */
	async function saveAsExactRule(id: string) {
		const idx = localRules.findIndex((r) => r.id === id);
		if (idx < 0) return;
		const { attention: _attention, legacy: _legacy, tabNote: _tabNote, ...rule } = $state.snapshot(localRules[idx]) as Rule;
		localRules[idx] = { ...rule, enabled: true };
		await saveOnly();
	}

	/** A note about a rule that still runs: read, so the note and the old copy go. */
	async function dismissAttention(id: string) {
		const idx = localRules.findIndex((r) => r.id === id);
		if (idx < 0) return;
		const { attention: _attention, legacy: _legacy, tabNote: _tabNote, ...rule } = $state.snapshot(localRules[idx]) as Rule;
		localRules[idx] = rule;
		await persistAll();
	}

	// --- Editor mutations (selected rule) ---

	function addCondition() {
		if (selectedIdx < 0) return;
		localRules[selectedIdx].conditions = [
			...localRules[selectedIdx].conditions,
			{ id: 'c_' + Date.now(), field: 'from', op: 'contains', value: '', negate: false }
		];
	}
	function removeCondition(cid: string) {
		if (selectedIdx < 0) return;
		localRules[selectedIdx].conditions = localRules[selectedIdx].conditions.filter((c) => c.id !== cid);
	}
	function addAction() {
		if (selectedIdx < 0) return;
		localRules[selectedIdx].actions = [...localRules[selectedIdx].actions, { type: 'markRead' } as RuleAction];
	}
	function removeAction(idx: number) {
		if (selectedIdx < 0) return;
		localRules[selectedIdx].actions = localRules[selectedIdx].actions.filter((_, i) => i !== idx);
	}

	// --- Live match preview ---

	let previewCount = $state<number | null>(null);
	let previewLoading = $state(false);
	let previewError = $state('');
	let previewTimer: ReturnType<typeof setTimeout> | undefined;

	// Serialise the parts of the selected rule that affect the preview.
	// Changes to this string retrigger a debounced preview fetch.
	const previewKey = $derived.by(() => {
		if (selectedIdx < 0) return '';
		const r = localRules[selectedIdx];
		return JSON.stringify({ id: r.id, logic: r.logic, conditions: r.conditions });
	});

	$effect(() => {
		previewKey; // dependency
		if (selectedIdx < 0) return;

		if (previewTimer) clearTimeout(previewTimer);
		previewTimer = setTimeout(runPreview, 400);
	});

	onDestroy(() => {
		if (previewTimer) clearTimeout(previewTimer);
	});

	async function runPreview() {
		if (selectedIdx < 0) return;
		// A rule being rewritten is counted as it reads now, without its flag:
		// the server counts nothing for a rule that is still switched off.
		const { attention: _attention, legacy: _legacy, tabNote: _tabNote, ...rule } = $state.snapshot(localRules[selectedIdx]) as Rule;
		previewLoading = true;
		previewError = '';
		try {
			const res = await fetch('/api/rules/preview', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ rule })
			});
			const data = await res.json();
			if (data.error) {
				previewError = data.error;
				previewCount = null;
			} else {
				previewCount = data.count ?? 0;
			}
		} catch (err) {
			previewError = err instanceof Error ? err.message : 'Preview failed';
			previewCount = null;
		} finally {
			previewLoading = false;
		}
	}

	// --- Save & apply now (SSE stream) ---

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
	let abortCtrl: AbortController | null = null;

	async function saveAndApply() {
		if (selectedIdx < 0) return;
		const ok = await persistAll();
		if (!ok) return;
		await streamApply(localRules[selectedIdx]);
	}

	async function streamApply(rule: Rule) {
		progress = { status: 'running', scanned: 0, matched: 0, applied: 0, total: 0 };
		progressVisible = true;
		abortCtrl = new AbortController();

		try {
			const res = await fetch('/api/rules/apply', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ rules: [rule] }),
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

			if (progress.status === 'running') {
				progress = { ...progress, status: 'done' };
			}
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

	function dismissProgress() {
		// Leave the stream running if still in progress; just hide the modal.
		progressVisible = false;
	}

	function closeOrCancel() {
		if (progress.status === 'running' && abortCtrl) abortCtrl.abort();
		progressVisible = false;
		progress = { status: 'idle', scanned: 0, matched: 0, applied: 0, total: 0 };
	}

	// --- Derived flags ---

	const progressPercent = $derived(
		progress.total > 0 ? Math.min(100, Math.round((progress.scanned / progress.total) * 100)) : 0
	);

	const folderOptionsById = $derived(new Map(data.mailboxes.map((m) => [m.id, m])));

	function actionSummary(a: RuleAction): string {
		switch (a.type) {
			case 'applyLabel': {
				const label = labelOptions.find((l) => l.id === a.value);
				return label ? `Apply label “${label.name}”` : 'Apply label';
			}
			case 'moveToFolder': {
				const mb = folderOptionsById.get(a.value ?? '');
				return mb ? `Move to “${mb.name}”` : 'Move to folder';
			}
			case 'markRead': return 'Mark as read';
			case 'markImportant': return 'Mark important';
			case 'delete': return 'Delete';
			case 'stopProcessing': return 'Stop processing';
		}
	}
</script>

<svelte:head><title>{pageTitle({ page: 'Filters & Rules', subtitle: 'Settings' })}</title></svelte:head>

{#snippet ruleRow(rule: Rule)}
	<li
		class="group relative flex items-center gap-2 pl-3 pr-1 py-2 rounded-lg cursor-pointer transition-all
			{selectedId === rule.id
				? 'bg-accent/10 border-l-2 border-accent text-text'
				: 'border-l-2 border-transparent text-text-secondary hover:bg-surface-hover hover:text-text hover:translate-x-0.5'}"
		onclick={() => { selectedId = rule.id; }}
	>
		{#if needsRewrite(rule)}
			<!-- Switched off until it is rewritten: there is nothing to toggle. -->
			<span class="shrink-0 text-warning" title="Switched off until you rewrite it">
				<Icon name="error" size={12} aria-label="Switched off until you rewrite it" />
			</span>
		{:else}
			<button
				onclick={(e) => { e.stopPropagation(); toggleEnabled(rule.id); }}
				title={rule.enabled ? 'Disable rule' : 'Enable rule'}
				class="w-2.5 h-2.5 rounded-full shrink-0 border cursor-pointer transition-colors
					{rule.enabled ? 'bg-success border-success' : 'bg-transparent border-text-tertiary/50'}"
				aria-label={rule.enabled ? 'Disable rule' : 'Enable rule'}
			></button>
		{/if}
		<span class="flex-1 truncate text-sm">{rule.name || 'Untitled rule'}</span>
		<button
			onclick={(e) => { e.stopPropagation(); deleteRule(rule.id); }}
			title="Delete rule"
			class="opacity-0 group-hover:opacity-100 pointer-coarse:opacity-100 text-text-tertiary hover:text-danger p-1 rounded-md cursor-pointer transition-opacity"
		>
			<Icon name="close" size={14} />
		</button>
	</li>
{/snippet}

<div class="h-full flex flex-col overflow-hidden">
	<!-- Title flush with the content edge and sized like every other settings
	     page; the way back to mail is in the settings menu. -->
	<header class="pb-4 border-b border-border flex items-center gap-3 shrink-0">
		<h1 class="text-xl font-semibold text-text">Rules</h1>
		<p class="text-xs text-text-tertiary">{localRules.length} {localRules.length === 1 ? 'rule' : 'rules'}</p>
		<div class="flex-1"></div>
		<button
			onclick={createRule}
			class="btn btn-primary"
		>
			+ New rule
		</button>
	</header>

	{#if deployWarning}
		<div class="mx-6 mt-3 px-3 py-2 rounded-lg bg-warning/10 border border-warning/20 text-warning text-xs">{deployWarning}</div>
	{/if}
	{#if deployError}
		<div class="mx-6 mt-3 px-3 py-2 rounded-lg bg-danger/10 border border-danger/20 text-danger text-xs">{deployError}</div>
	{/if}

	<div class="flex-1 flex min-h-0 overflow-hidden">
		<!-- Rule list -->
		<aside class="w-[280px] shrink-0 border-r border-border overflow-y-auto py-3 px-2">
			{#if localRules.length === 0}
				<p class="text-xs text-text-tertiary text-center py-8 px-3">
					No rules yet. Click “New rule” to get started.
				</p>
			{:else}
				{#if attentionRules.length > 0}
					<h2 class="px-3 pb-1.5 text-2xs font-semibold text-warning uppercase tracking-wide">Needs your attention</h2>
					<ul class="flex flex-col gap-0.5 mb-3">
						{#each attentionRules as rule (rule.id)}
							{@render ruleRow(rule)}
						{/each}
					</ul>
					{#if otherRules.length > 0}
						<h2 class="px-3 pb-1.5 text-2xs font-semibold text-text-tertiary uppercase tracking-wide">Rules</h2>
					{/if}
				{/if}
				<ul class="flex flex-col gap-0.5">
					{#each otherRules as rule (rule.id)}
						{@render ruleRow(rule)}
					{/each}
				</ul>
			{/if}
		</aside>

		<!-- Editor -->
		<section class="flex-1 overflow-y-auto min-w-0">
			{#if selectedIdx < 0}
				<div class="h-full flex items-center justify-center text-text-tertiary text-sm px-6">
					Select a rule from the list, or click “New rule” to create one.
				</div>
			{:else}
				{@const rule = localRules[selectedIdx]}
				<div class="px-6 py-5 flex flex-col gap-5 max-w-[720px]">
					{#if rule.attention === 'jev_condition'}
						<div class="rounded-xl border border-warning/30 bg-warning/10 p-4 flex flex-col gap-2" role="note">
							<p class="text-sm font-medium text-text">This rule is switched off</p>
							<p class="text-xs text-text-secondary">
								It had a condition Jev judged, and rules now match exactly: by sender, recipient,
								subject, body, size or attachment. Without that condition it would act on more mail
								than you wrote it for, so it no longer runs. This is what it said:
							</p>
							{#if rule.legacy}
								<ul class="text-xs text-text list-disc pl-5 flex flex-col gap-0.5">
									{#each rule.legacy.conditions as c}
										<li>{legacyConditionText(c)}</li>
									{/each}
								</ul>
								<p class="text-2xs text-text-tertiary">
									It matched {rule.legacy.logic === 'anyof' ? 'ANY' : 'ALL'} of these{rule.legacy.enabled ? '' : ', and was already switched off'}.
								</p>
							{/if}
							{#if legacyTab(rule)}
								<p class="text-xs text-text-secondary">
									It also moved that mail to {legacyTab(rule)}, which a rule can no longer do.
								</p>
							{/if}
							<p class="text-xs text-text-secondary">
								Rewrite it below with exact conditions and press
								<span class="text-text">Save as exact rule</span> to switch it back on, or delete it.
							</p>
						</div>
					{:else if rule.attention === 'tab_rule'}
						<div class="rounded-xl border border-warning/30 bg-warning/10 p-4 flex flex-col gap-2" role="note">
							<p class="text-sm font-medium text-text">This rule is switched off</p>
							<p class="text-xs text-text">{whyNotPinned(rule.tabNote)}</p>
							<p class="text-xs text-text-secondary">
								All it did was move mail to {legacyTab(rule) ?? 'an Inbox tab'}, and rules no longer
								put mail in a tab: sender pins do that now, whether Jev is on or off. It matched mail
								like this:
							</p>
							{#if rule.legacy}
								<ul class="text-xs text-text list-disc pl-5 flex flex-col gap-0.5">
									{#each rule.legacy.conditions as c}
										<li>{legacyConditionText(c)}</li>
									{/each}
								</ul>
								{#if rule.legacy.conditions.length > 1}
									<p class="text-2xs text-text-tertiary">
										It matched {rule.legacy.logic === 'anyof' ? 'ANY' : 'ALL'} of these.
									</p>
								{/if}
							{/if}
							{#if rule.tabNote?.pin}
								{@const pin = rule.tabNote.pin}
								<p class="text-xs text-text-secondary">
									A pin can do this instead. It would act on new mail from {pinReach(pin.sender)}.
									{pinDifference(rule.tabNote)}
								</p>
								<button onclick={() => pinInstead(rule.id)} disabled={saving} class="btn btn-primary self-start">
									{rule.tabNote.kept?.sender === pin.sender
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
					{:else if rule.attention === 'tab_pinned'}
						<div class="rounded-xl border border-warning/30 bg-warning/10 p-4 flex flex-col gap-2" role="note">
							{#if rule.tabNote?.pin}
								{@const pin = rule.tabNote.pin}
								<p class="text-sm font-medium text-text">
									{rule.tabNote.existing
										? `${pin.sender} was already pinned to ${tabName(pin.category)}.`
										: `This rule became a sender pin: ${pin.sender} → ${tabName(pin.category)}.`}
								</p>
								<p class="text-xs text-text-secondary">
									{rule.tabNote.existing
										? 'All it did was move mail to that tab, and you had already pinned this sender there, so your pin does its work now.'
										: 'All it did was move mail to that tab. Rules no longer do that; a pin does, whether Jev is on or off.'}
									The pin acts on new mail from {pinReach(pin.sender)}.
									{pinDifference(rule.tabNote)}
								</p>
							{:else}
								<p class="text-sm font-medium text-text">This rule became a sender pin</p>
							{/if}
							<p class="text-xs text-text-secondary">
								You can change or remove the pin under
								<a href="/settings/jev" class="underline">Settings → Jev → Pinned senders</a>. The rule is
								switched off and has nothing left to do; it stays here only until you have seen this.
							</p>
							<button onclick={() => removeRule(rule.id)} disabled={saving} class="btn btn-secondary self-start">
								Got it
							</button>
						</div>
					{:else if rule.attention === 'tab_removed'}
						<div class="rounded-xl border border-warning/30 bg-warning/10 p-4 flex flex-col gap-2" role="note">
							<p class="text-sm font-medium text-text">
								This rule no longer puts mail in {legacyTab(rule) ?? 'an Inbox tab'}.
							</p>
							<p class="text-xs text-text-secondary">
								It used to move mail to {legacyTab(rule) ?? 'an Inbox tab'} as well. Rules no longer
								put mail in a tab, so that part was removed; the rest of the rule runs as before. To
								keep a sender’s mail in that tab, pin the sender under
								<a href="/settings/jev" class="underline">Settings → Jev → Pinned senders</a>.
							</p>
							<button onclick={() => dismissAttention(rule.id)} disabled={saving} class="btn btn-secondary self-start">
								Got it
							</button>
						</div>
					{/if}

					<!-- What is left of a rule that became a pin is only its note: there is nothing to edit. -->
					{#if rule.attention !== 'tab_pinned'}
					<!-- Name -->
					<div class="flex flex-col gap-1.5">
						<label for="rule-name" class="text-xs font-semibold text-text-tertiary uppercase tracking-wide">Name</label>
						<input
							id="rule-name"
							bind:value={rule.name}
							maxlength={80}
							placeholder="Describe what this rule does"
							class="bg-surface-hover border border-border rounded-lg px-3 py-2 text-sm text-text outline-none focus:border-accent transition-colors"
						/>
					</div>

					<!-- Match logic -->
					<div class="flex items-center gap-2 text-sm text-text-secondary">
						<span>Match</span>
						<div class="flex rounded-lg border border-border overflow-hidden">
							<button
								onclick={() => { rule.logic = 'allof'; }}
								class="px-2.5 py-1 text-xs transition-colors cursor-pointer {rule.logic === 'allof' ? 'bg-accent text-white' : 'text-text-tertiary hover:bg-surface-hover'}"
							>ALL</button>
							<button
								onclick={() => { rule.logic = 'anyof'; }}
								class="px-2.5 py-1 text-xs border-l border-border transition-colors cursor-pointer {rule.logic === 'anyof' ? 'bg-accent text-white' : 'text-text-tertiary hover:bg-surface-hover'}"
							>ANY</button>
						</div>
						<span>of the following:</span>
					</div>

					<!-- Conditions -->
					<div class="flex flex-col gap-2">
						{#each rule.conditions as condition (condition.id)}
							<div class="flex items-center gap-1.5 flex-wrap" transition:slide={{ duration: 150 }}>
								<select bind:value={condition.field} class="bg-surface-hover border border-border rounded-lg px-2 py-1.5 text-xs text-text outline-none focus:border-accent">
									<option value="from">From</option>
									<option value="to">To</option>
									<option value="subject">Subject</option>
									<option value="body">Body</option>
									<option value="size">Size (KB)</option>
									<option value="hasAttachment">Has attachment</option>
								</select>
								{#if condition.field !== 'hasAttachment'}
									<select bind:value={condition.op} class="bg-surface-hover border border-border rounded-lg px-2 py-1.5 text-xs text-text outline-none focus:border-accent">
										<option value="contains">contains</option>
										<option value="not_contains">doesn't contain</option>
										<option value="is">is exactly</option>
										<option value="starts_with">starts with</option>
										<option value="ends_with">ends with</option>
									</select>
									<input
										bind:value={condition.value}
										type={condition.field === 'size' ? 'number' : 'text'}
										placeholder={condition.field === 'size' ? 'KB' : 'value…'}
										class="flex-1 min-w-[120px] bg-surface-hover border border-border rounded-lg px-2 py-1.5 text-xs text-text outline-none focus:border-accent"
									/>
								{/if}
								<button
									onclick={() => { condition.negate = !condition.negate; }}
									class="text-3xs px-1.5 py-0.5 rounded-md border cursor-pointer transition-colors
										{condition.negate ? 'border-danger/50 text-danger bg-danger/10' : 'border-border text-text-tertiary hover:border-text-tertiary'}"
								>NOT</button>
								<button
									onclick={() => removeCondition(condition.id)}
									title="Remove condition"
									class="text-text-tertiary hover:text-danger cursor-pointer p-1 rounded-md"
									aria-label="Remove condition"
								>
									<Icon name="close" size={14} />
								</button>
							</div>
						{/each}
						<button
							onclick={addCondition}
							class="text-xs text-accent-fg hover:text-accent-fg-hover cursor-pointer self-start"
						>+ Add condition</button>
					</div>

					<!-- Actions -->
					<div class="flex flex-col gap-2 pt-2 border-t border-border">
						<p class="text-xs font-semibold text-text-tertiary uppercase tracking-wide">Then</p>
						{#each rule.actions as action, idx}
							<div class="flex items-center gap-1.5 flex-wrap" transition:slide={{ duration: 150 }}>
								<select bind:value={action.type} class="bg-surface-hover border border-border rounded-lg px-2 py-1.5 text-xs text-text outline-none focus:border-accent">
									<option value="applyLabel">Apply label</option>
									<option value="moveToFolder">Move to folder</option>
									<option value="markRead">Mark as read</option>
									<option value="markImportant">Mark important</option>
									<option value="delete">Move to trash</option>
									<option value="stopProcessing">Stop processing</option>
								</select>
								{#if action.type === 'applyLabel'}
									<select bind:value={action.value} class="flex-1 min-w-[140px] bg-surface-hover border border-border rounded-lg px-2 py-1.5 text-xs text-text outline-none focus:border-accent">
										<option value="">Select a label…</option>
										{#each labelOptions as lb}
											<option value={lb.id}>{lb.name}</option>
										{/each}
									</select>
								{:else if action.type === 'moveToFolder'}
									<select bind:value={action.value} class="flex-1 min-w-[140px] bg-surface-hover border border-border rounded-lg px-2 py-1.5 text-xs text-text outline-none focus:border-accent">
										<option value="">Select a folder…</option>
										{#if folderOptions.length > 0}
											<optgroup label="User folders">
												{#each folderOptions as mb}
													<option value={mb.id}>{mb.name}</option>
												{/each}
											</optgroup>
										{/if}
										{#if systemFolderOptions.length > 0}
											<optgroup label="System">
												{#each systemFolderOptions as mb}
													<option value={mb.id}>{mb.name}</option>
												{/each}
											</optgroup>
										{/if}
									</select>
								{/if}
								{#if isStaleTarget(action)}
									<span class="w-full text-2xs text-warning">
										⚠ The {action.type === 'moveToFolder' ? 'folder' : 'label'} this rule pointed at no longer exists — pick a new one and save, or the rule will do nothing.
									</span>
								{/if}
								<button
									onclick={() => removeAction(idx)}
									title="Remove action"
									class="text-text-tertiary hover:text-danger cursor-pointer p-1 rounded-md"
									aria-label="Remove action"
								>
									<Icon name="close" size={14} />
								</button>
							</div>
						{/each}
						<button
							onclick={addAction}
							class="text-xs text-accent-fg hover:text-accent-fg-hover cursor-pointer self-start"
						>+ Add action</button>
					</div>

					<!-- Summary line -->
					<p class="text-2xs text-text-tertiary italic">
						{rule.actions.map(actionSummary).join(' · ') || 'No actions'}
					</p>

					<!-- Match preview + save bar -->
					<div class="rounded-xl border border-border bg-surface-hover/40 p-4 flex items-center gap-3 flex-wrap">
						<div class="flex items-center gap-2">
							{#if previewLoading}
								<span class="w-3 h-3 rounded-full border-2 border-accent/40 border-t-accent animate-spin"></span>
								<span class="text-xs text-text-tertiary">Counting…</span>
							{:else if previewError}
								<span class="text-xs text-danger">{previewError}</span>
							{:else if previewCount !== null}
								<span class="text-sm font-semibold text-text">{previewCount.toLocaleString()}</span>
								<span class="text-xs text-text-tertiary">
									existing {previewCount === 1 ? 'email matches' : 'emails match'} this rule{needsRewrite(rule) ? ' as it reads now' : ''}
								</span>
							{:else}
								<span class="text-xs text-text-tertiary">No preview</span>
							{/if}
						</div>
						<div class="flex-1"></div>
						{#if needsRewrite(rule)}
							<button onclick={() => deleteRule(rule.id)} disabled={saving} class="btn btn-secondary">
								Delete rule
							</button>
							<button
								onclick={() => saveAsExactRule(rule.id)}
								disabled={saving || !canRunAsExact(rule)}
								title={canRunAsExact(rule)
									? 'Switch the rule back on, matching only the conditions above'
									: 'Give the rule at least one condition and one action first'}
								class="btn btn-primary"
							>
								{saving ? 'Saving…' : 'Save as exact rule'}
							</button>
						{:else}
							<button
								onclick={saveOnly}
								disabled={saving}
								class="btn btn-secondary"
							>
								{saving ? 'Saving…' : 'Save'}
							</button>
							<button
								onclick={saveAndApply}
								disabled={saving}
								class="btn btn-primary"
							>
								Save &amp; apply now
							</button>
						{/if}
					</div>
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
	<div
		class="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
		transition:fade={{ duration: 150 }}
	>
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
						onclick={dismissProgress}
						class="text-xs text-text-tertiary hover:text-text px-3 py-1.5 rounded-lg transition-colors cursor-pointer"
					>
						Run in background
					</button>
					<button
						onclick={closeOrCancel}
						class="btn btn-danger btn-sm"
					>
						Cancel
					</button>
				{:else if progress.status === 'error'}
					<button
						onclick={closeOrCancel}
						class="text-xs text-text-tertiary hover:text-text px-3 py-1.5 rounded-lg transition-colors cursor-pointer"
					>
						Close
					</button>
					<button
						onclick={saveAndApply}
						class="btn btn-primary btn-sm"
					>
						Retry
					</button>
				{:else}
					<button
						onclick={closeOrCancel}
						class="btn btn-primary btn-sm"
					>
						Done
					</button>
				{/if}
			</div>
		</div>
	</div>
{/if}
