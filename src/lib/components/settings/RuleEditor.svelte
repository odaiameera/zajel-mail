<script lang="ts">
	import Icon from '$lib/components/Icon.svelte';
	import { onDestroy } from 'svelte';
	import type { Mailbox } from '$lib/jmap/types';
	import type { Label } from '$lib/types/labels';
	import {
		needsRewrite,
		RULE_ROLES,
		type Rule,
		type RuleCondition,
		type RuleDraft,
		type RuleProblem,
		type RuleRole,
		type RuleTarget
	} from '$lib/types/rules';
	import { buildFolderTree, flattenFolderTree } from '$lib/utils/folder-tree';

	/**
	 * One rule, being written: its name, its conditions, and what it does
	 * ("Then": one place to file mail, mark as read, star, stop). Nothing is
	 * sent until Save; the server checks the rule (parseRule) and what it
	 * finds wrong is shown beside the part it is about. Used by the rules
	 * page, and meant for the folders and labels page too.
	 */
	let {
		rule,
		mailboxes,
		labels,
		onSaved,
		onDeleted,
		onCancel
	}: {
		/** The rule to edit, or null for a new one. */
		rule: Rule | null;
		mailboxes: Mailbox[];
		labels: Label[];
		/** Saved; `apply` when the owner asked to apply it now as well. */
		onSaved: (rule: Rule, apply: boolean) => void;
		onDeleted: (id: string) => void;
		onCancel: () => void;
	} = $props();

	const newCondition = (): RuleCondition => ({
		id: 'c_' + Math.random().toString(36).slice(2),
		field: 'from',
		op: 'contains',
		value: '',
		negate: false
	});

	function draftOf(r: Rule | null): RuleDraft {
		if (!r) {
			return {
				name: '',
				enabled: true,
				logic: 'allof',
				conditions: [newCondition()],
				target: { kind: 'none' },
				markRead: false,
				star: false,
				stop: false
			};
		}
		const { name, enabled, logic, conditions, target, markRead, star, stop } = structuredClone($state.snapshot(r)) as Rule;
		return { name, enabled, logic, conditions: conditions.length ? conditions : [newCondition()], target, markRead, star, stop };
	}

	// The editor is remounted for each rule (the page keys it), so the draft
	// starts from the rule it was opened with.
	// svelte-ignore state_referenced_locally
	let draft = $state<RuleDraft>(draftOf(rule));
	let problems = $state<RuleProblem[]>([]);
	let saving = $state(false);
	let error = $state('');

	// svelte-ignore state_referenced_locally
	const rewriting = rule ? needsRewrite(rule) : false;

	const problemsFor = (field: RuleProblem['field'], index?: number) =>
		problems.filter((p) => p.field === field && p.index === index).map((p) => p.message);

	// --- Where it files mail ---

	const folderOptions = $derived(flattenFolderTree(buildFolderTree(mailboxes)));
	const roleOptions = $derived(RULE_ROLES.filter((role) => mailboxes.some((m) => m.role === role)));
	const ROLE_NAMES: Record<RuleRole, string> = { trash: 'Trash', archive: 'Archive', junk: 'Junk' };

	const targetKey = (t: RuleTarget) => (t.kind === 'folder' || t.kind === 'label' ? `${t.kind}:${t.mailboxId}` : t.kind);
	function targetFromKey(key: string): RuleTarget {
		const [kind, id] = key.split(/:(.*)/s);
		if ((kind === 'folder' || kind === 'label') && id) return { kind, mailboxId: id };
		if (RULE_ROLES.includes(kind as RuleRole)) return { kind: kind as RuleRole };
		return { kind: 'none' };
	}
	/** A target the account no longer has: kept as it is, and said so, until the owner picks another. */
	const targetMissing = $derived.by(() => {
		const t = draft.target;
		if (t.kind === 'folder') return !folderOptions.some((f) => f.id === t.mailboxId);
		if (t.kind === 'label') return !labels.some((l) => l.id === t.mailboxId);
		return t.kind !== 'none' && !roleOptions.includes(t.kind);
	});

	// --- Live match count ---

	let preview = $state<{ matched: number; scanned: number; total: number } | null>(null);
	let previewLoading = $state(false);
	let previewTimer: ReturnType<typeof setTimeout> | undefined;
	const previewKey = $derived(JSON.stringify({ logic: draft.logic, conditions: draft.conditions }));

	$effect(() => {
		void previewKey;
		if (previewTimer) clearTimeout(previewTimer);
		previewTimer = setTimeout(runPreview, 400);
	});
	onDestroy(() => {
		if (previewTimer) clearTimeout(previewTimer);
	});

	async function runPreview() {
		previewLoading = true;
		try {
			const res = await fetch('/api/rules/preview', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ rule: $state.snapshot(draft) })
			});
			const body = await res.json();
			preview = res.ok && typeof body.matched === 'number' ? body : null;
		} catch {
			preview = null;
		} finally {
			previewLoading = false;
		}
	}

	// --- Save, delete ---

	async function save(apply: boolean) {
		saving = true;
		error = '';
		problems = [];
		// "Save as exact rule": a rule an upgrade switched off comes back on.
		const body = { ...$state.snapshot(draft), ...(rewriting ? { enabled: true } : {}) };
		try {
			const res = await fetch(rule ? `/api/rules/${encodeURIComponent(rule.id)}` : '/api/rules', {
				method: rule ? 'PATCH' : 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(body)
			});
			const answer = await res.json().catch(() => ({}));
			if (!res.ok) {
				problems = Array.isArray(answer.problems) ? answer.problems : [];
				if (problems.length === 0) error = answer.error ?? `Save failed (HTTP ${res.status})`;
				return;
			}
			onSaved(answer.rule as Rule, apply);
		} catch (err) {
			error = err instanceof Error ? err.message : 'Save failed';
		} finally {
			saving = false;
		}
	}

	async function remove() {
		if (!rule) return;
		if (!confirm(`Delete rule "${rule.name}"? This cannot be undone.`)) return;
		saving = true;
		error = '';
		try {
			const res = await fetch(`/api/rules/${encodeURIComponent(rule.id)}`, { method: 'DELETE' });
			if (!res.ok) {
				error = (await res.json().catch(() => ({}))).error ?? 'Delete failed';
				return;
			}
			onDeleted(rule.id);
		} finally {
			saving = false;
		}
	}

	const inputClass =
		'bg-surface-hover border border-border rounded-lg px-2 py-1.5 text-xs text-text outline-none focus:border-accent';
</script>

{#snippet problemList(messages: string[])}
	{#each messages as message (message)}
		<p class="text-2xs text-danger" role="alert">{message}</p>
	{/each}
{/snippet}

<div class="flex flex-col gap-5">
	<!-- Name -->
	<div class="flex flex-col gap-1.5">
		<label for="rule-name" class="text-xs font-semibold text-text-tertiary uppercase tracking-wide">Name</label>
		<input
			id="rule-name"
			bind:value={draft.name}
			maxlength={120}
			placeholder="Describe what this rule does"
			class="bg-surface-hover border border-border rounded-lg px-3 py-2 text-sm text-text outline-none focus:border-accent transition-colors"
		/>
		{@render problemList(problemsFor('name'))}
	</div>

	<!-- Match logic -->
	<div class="flex flex-col gap-1">
		<div class="flex items-center gap-2 text-sm text-text-secondary">
			<span>Match</span>
			<div class="flex rounded-lg border border-border overflow-hidden">
				<button
					onclick={() => (draft.logic = 'allof')}
					class="px-2.5 py-1 text-xs transition-colors cursor-pointer {draft.logic === 'allof' ? 'bg-accent text-white' : 'text-text-tertiary hover:bg-surface-hover'}"
				>ALL</button>
				<button
					onclick={() => (draft.logic = 'anyof')}
					class="px-2.5 py-1 text-xs border-l border-border transition-colors cursor-pointer {draft.logic === 'anyof' ? 'bg-accent text-white' : 'text-text-tertiary hover:bg-surface-hover'}"
				>ANY</button>
			</div>
			<span>of the following:</span>
		</div>
		{@render problemList(problemsFor('logic'))}
	</div>

	<!-- Conditions -->
	<div class="flex flex-col gap-2">
		{#each draft.conditions as condition, index (condition.id)}
			<div class="flex flex-col gap-1">
				<div class="flex items-center gap-1.5 flex-wrap">
					<select bind:value={condition.field} aria-label="Looks at" class={inputClass}>
						<option value="from">From</option>
						<option value="to">To</option>
						<option value="subject">Subject</option>
						<option value="body">Body</option>
						<option value="size">Size (KB)</option>
						<option value="hasAttachment">Has attachment</option>
					</select>
					{#if condition.field !== 'hasAttachment'}
						<select bind:value={condition.op} aria-label="Matches" class={inputClass}>
							<option value="contains">contains</option>
							<option value="not_contains">doesn't contain</option>
							<option value="is">is exactly</option>
							<option value="starts_with">starts with</option>
							<option value="ends_with">ends with</option>
						</select>
						<input
							bind:value={condition.value}
							aria-label="Value"
							type={condition.field === 'size' ? 'number' : 'text'}
							placeholder={condition.field === 'size' ? 'KB' : 'value…'}
							class="flex-1 min-w-[120px] {inputClass}"
						/>
					{/if}
					<button
						onclick={() => (condition.negate = !condition.negate)}
						class="text-3xs px-1.5 py-0.5 rounded-md border cursor-pointer transition-colors
							{condition.negate ? 'border-danger/50 text-danger bg-danger/10' : 'border-border text-text-tertiary hover:border-text-tertiary'}"
					>NOT</button>
					<button
						onclick={() => (draft.conditions = draft.conditions.filter((c) => c.id !== condition.id))}
						title="Remove condition"
						aria-label="Remove condition"
						class="text-text-tertiary hover:text-danger cursor-pointer p-1 rounded-md"
					>
						<Icon name="close" size={14} />
					</button>
				</div>
				{@render problemList(problemsFor('conditions', index))}
			</div>
		{/each}
		<button
			onclick={() => (draft.conditions = [...draft.conditions, newCondition()])}
			class="text-xs text-accent-fg hover:text-accent-fg-hover cursor-pointer self-start"
		>+ Add condition</button>
		{@render problemList(problemsFor('conditions'))}
	</div>

	<!-- Then -->
	<div class="flex flex-col gap-2 pt-2 border-t border-border">
		<p class="text-xs font-semibold text-text-tertiary uppercase tracking-wide">Then</p>
		<label class="flex flex-col gap-1 text-xs text-text-secondary">
			File it in
			<select
				class="max-w-[320px] {inputClass}"
				value={targetKey(draft.target)}
				onchange={(e) => (draft.target = targetFromKey(e.currentTarget.value))}
			>
				<option value="none">Nowhere: leave it where it is</option>
				{#if targetMissing}
					<option value={targetKey(draft.target)}>(target missing)</option>
				{/if}
				{#if folderOptions.length > 0}
					<optgroup label="Folders">
						{#each folderOptions as f (f.id)}
							<option value="folder:{f.id}">{'— '.repeat(f.depth)}{f.name}</option>
						{/each}
					</optgroup>
				{/if}
				{#if labels.length > 0}
					<optgroup label="Labels">
						{#each labels as l (l.id)}
							<option value="label:{l.id}">{l.name}</option>
						{/each}
					</optgroup>
				{/if}
				{#each roleOptions as role (role)}
					<option value={role}>{ROLE_NAMES[role]}</option>
				{/each}
			</select>
		</label>
		{#if targetMissing}
			<p class="text-2xs text-warning">
				Target missing: the {draft.target.kind === 'label' ? 'label' : 'folder'} this rule files into no longer exists, so
				the rule does nothing there. Pick another and save.
			</p>
		{/if}
		{@render problemList(problemsFor('target'))}
		<label class="flex items-center gap-2 text-sm text-text-secondary">
			<input type="checkbox" bind:checked={draft.markRead} /> Mark as read
		</label>
		<label class="flex items-center gap-2 text-sm text-text-secondary">
			<input type="checkbox" bind:checked={draft.star} /> Star
		</label>
		<label class="flex items-center gap-2 text-sm text-text-secondary">
			<input type="checkbox" bind:checked={draft.stop} /> Stop processing later rules
		</label>
		{@render problemList(problemsFor('actions'))}
	</div>

	{#if error}
		<p class="px-3 py-2 rounded-lg bg-danger/10 border border-danger/20 text-danger text-xs" role="alert">{error}</p>
	{/if}

	<!-- Match count + buttons -->
	<div class="rounded-xl border border-border bg-surface-hover/40 p-4 flex items-center gap-3 flex-wrap">
		<div class="flex items-center gap-2">
			{#if previewLoading}
				<span class="w-3 h-3 rounded-full border-2 border-accent/40 border-t-accent animate-spin"></span>
				<span class="text-xs text-text-tertiary">Counting…</span>
			{:else if preview !== null}
				<span class="text-sm font-semibold text-text">{preview.matched.toLocaleString()}</span>
				<span class="text-xs text-text-tertiary">
					{#if preview.scanned < preview.total}
						of your newest {preview.scanned.toLocaleString()} Inbox messages {preview.matched === 1 ? 'matches' : 'match'}
					{:else}
						Inbox {preview.matched === 1 ? 'message matches' : 'messages match'}
					{/if}
					this rule{rewriting ? ' as it reads now' : ''}
				</span>
			{:else}
				<span class="text-xs text-text-tertiary">No preview</span>
			{/if}
		</div>
		<div class="flex-1"></div>
		{#if rule}
			<button onclick={remove} disabled={saving} class="btn btn-secondary">Delete</button>
		{/if}
		<button onclick={onCancel} disabled={saving} class="btn btn-secondary">Cancel</button>
		{#if rewriting}
			<button onclick={() => save(false)} disabled={saving} class="btn btn-primary">
				{saving ? 'Saving…' : 'Save as exact rule'}
			</button>
		{:else}
			<button onclick={() => save(false)} disabled={saving} class="btn btn-secondary">
				{saving ? 'Saving…' : 'Save'}
			</button>
			<button onclick={() => save(true)} disabled={saving} class="btn btn-primary">Save &amp; apply</button>
		{/if}
	</div>
</div>
