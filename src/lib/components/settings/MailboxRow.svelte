<script lang="ts">
	import Icon from '$lib/components/Icon.svelte';
	import MailboxIcon from '$lib/components/MailboxIcon.svelte';
	import Toggle from './Toggle.svelte';
	import { goto, invalidateAll } from '$app/navigation';
	import { page } from '$app/state';
	import type { Mailbox } from '$lib/jmap/types';
	import type { IconNode } from '$lib/types/icon-node';
	import { mailboxDeleteRulesNote, needsRewrite, type Rule, type RuleTarget } from '$lib/types/rules';
	import { conditionsText, hasRowNote, rowNote } from '$lib/rules/describe';
	import { moveStep } from '$lib/utils/folder-tree';
	import { mailboxIconName } from '$lib/icons';

	/**
	 * One folder, label or system folder in Settings, with the rules that
	 * file mail into it. Opened, it lists those rules and offers "Add rule",
	 * started with this as the place to file. A folder or label can be moved
	 * one place up or down, edited and deleted from here; on a phone Edit
	 * and Delete are inside the opened row, so the name keeps its room.
	 */
	let {
		mailbox,
		name: shownName,
		kind,
		mailboxes,
		depth = 0,
		color = null,
		iconNode = null,
		rules,
		target,
		busy = false,
		onEdit,
		onOpenRule,
		onAddRule,
		onToggleRule,
		onDismissRule,
		onError,
		onChanged
	}: {
		mailbox: Mailbox;
		/** The name to show, when it isn't the mailbox's own (a label's stored display name). */
		name?: string;
		kind: 'folder' | 'label' | 'system';
		/** The account's mailboxes: where this one's neighbours are. */
		mailboxes: Mailbox[];
		/** How deep in the folder tree, for the indent. */
		depth?: number;
		color?: string | null;
		iconNode?: IconNode | null;
		/** The rules that file mail into it, in the order they run. */
		rules: Rule[];
		/** What a rule started here files into; null where no rule can file (the Inbox, Sent, Drafts). */
		target: RuleTarget | null;
		/** A change to the rules is being saved. */
		busy?: boolean;
		onEdit?: () => void;
		/** `opener` is the control pressed, for focus to return to. */
		onOpenRule: (rule: Rule, opener: HTMLElement) => void;
		onAddRule: (target: RuleTarget, opener: HTMLElement) => void;
		onToggleRule: (rule: Rule) => void;
		/** "Got it" on a running rule's note. */
		onDismissRule: (rule: Rule) => void;
		/** Something the server refused, to show in the page; '' clears it. */
		onError: (message: string) => void;
		/** Deleted: the rules that filed into it have changed too. */
		onChanged?: () => void;
	} = $props();

	let open = $state(false);
	let working = $state(false);

	const name = $derived(shownName ?? mailbox.name);
	const editable = $derived(kind !== 'system');
	const noun = $derived(kind === 'label' ? 'label' : 'folder');
	const canMoveUp = $derived(editable && !!moveStep(mailboxes, mailbox.id, 'up'));
	const canMoveDown = $derived(editable && !!moveStep(mailboxes, mailbox.id, 'down'));
	const rulesCount = $derived(`${rules.length} ${rules.length === 1 ? 'rule' : 'rules'}`);

	async function post(body: Record<string, unknown>, failed: string): Promise<Record<string, unknown> | null> {
		working = true;
		onError('');
		try {
			const res = await fetch('/api/folders', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(body)
			}).catch(() => null);
			const payload = (await res?.json().catch(() => ({}))) ?? {};
			if (!res?.ok || payload?.success === false) {
				onError(typeof payload?.error === 'string' ? payload.error : failed);
				return null;
			}
			return payload;
		} finally {
			working = false;
		}
	}

	// One place up or down among its siblings: what a drag in the sidebar
	// does, for keyboards and touch screens.
	async function step(direction: 'up' | 'down') {
		const request = moveStep(mailboxes, mailbox.id, direction);
		if (!request) return;
		if (await post({ action: 'reorder', ...request }, `The ${noun} couldn’t be moved. Try again.`)) await invalidateAll();
	}

	async function remove() {
		const note = mailboxDeleteRulesNote(rules, mailbox.id);
		const what =
			kind === 'label'
				? 'Emails tagged with this label will not be deleted.'
				: 'Messages inside will not be deleted — move them first if you want to keep them somewhere else.';
		if (!confirm(`Delete "${name}"? ${what}${note ? ` ${note}` : ''}`)) return;
		if (!(await post({ action: 'delete', id: mailbox.id }, `The ${noun} couldn’t be deleted. Try again.`))) return;
		if (page.url.pathname === `/folder/${mailbox.id}`) goto('/inbox');
		await invalidateAll();
		onChanged?.();
	}
</script>

<!-- The indent: 16px a level; on a phone 12px, and no deeper than four levels. -->
<div
	role="group"
	aria-label={name}
	tabindex="-1"
	class="outline-none"
	style="--indent: {depth * 16}px; --indent-sm: {Math.min(depth, 4) * 12}px"
>
	<div class="flex items-center gap-1 py-1.5 pl-(--indent) max-md:pl-(--indent-sm)">
		{#if target}
			<button
				type="button"
				onclick={() => (open = !open)}
				aria-expanded={open}
				class="flex-1 min-w-0 flex items-center gap-2 h-8 pl-1 pr-2 -ml-1 rounded-md text-left cursor-pointer hover:bg-surface-hover focus-visible:bg-surface-hover transition-colors"
			>
				<Icon name="next" size={12} class="text-text-tertiary transition-transform duration-150 {open ? 'rotate-90' : ''}" />
				{@render rowName()}
			</button>
		{:else}
			<div class="flex-1 min-w-0 flex items-center gap-2 h-8 pl-1 pr-2 -ml-1">
				<span class="w-3 shrink-0"></span>
				{@render rowName()}
			</div>
		{/if}
		{#if kind === 'system'}
			<span class="text-3xs text-text-tertiary uppercase tracking-wider shrink-0 pr-1">{mailbox.role ?? ''}</span>
		{:else}
			<a
				href={`/folder/${mailbox.id}`}
				class="max-md:hidden text-xs text-text-tertiary hover:text-text px-1.5 py-1 rounded-md transition-colors"
			>View</a>
			<button
				type="button"
				onclick={() => step('up')}
				disabled={working || !canMoveUp}
				title="Move up"
				aria-label="Move {name} up"
				class="p-1 rounded-md text-text-tertiary hover:text-text hover:bg-surface-hover transition-colors cursor-pointer disabled:opacity-30 disabled:cursor-default disabled:hover:bg-transparent"
			><Icon name="move-up" size={14} /></button>
			<button
				type="button"
				onclick={() => step('down')}
				disabled={working || !canMoveDown}
				title="Move down"
				aria-label="Move {name} down"
				class="p-1 rounded-md text-text-tertiary hover:text-text hover:bg-surface-hover transition-colors cursor-pointer disabled:opacity-30 disabled:cursor-default disabled:hover:bg-transparent"
			><Icon name="move-down" size={14} /></button>
			<button
				type="button"
				onclick={() => onEdit?.()}
				disabled={working}
				aria-label="Edit {name}"
				class="max-md:hidden text-xs text-text-tertiary hover:text-text px-1.5 py-1 rounded-md hover:bg-surface-hover transition-colors cursor-pointer disabled:opacity-50"
			>Edit</button>
			<button
				type="button"
				onclick={remove}
				disabled={working}
				aria-label="Delete {name}"
				class="max-md:hidden text-xs text-text-tertiary hover:text-danger px-1.5 py-1 rounded-md hover:bg-surface-hover transition-colors cursor-pointer disabled:opacity-50"
			>Delete</button>
		{/if}
	</div>

	{#if open && target}
		<div class="pb-3 pl-[calc(var(--indent)+20px)] max-md:pl-[calc(var(--indent-sm)+20px)]">
			{#if rules.length === 0}
				<p class="text-xs text-text-tertiary py-1.5">No rules file mail here yet.</p>
			{:else}
				<ul class="flex flex-col">
					{#each rules as rule (rule.id)}
						<li class="flex items-center gap-3 py-1.5">
							{#if needsRewrite(rule)}
								<!-- Switched off until it is rewritten: there is nothing to toggle. -->
								<span class="w-7 shrink-0 flex justify-center text-warning" title="Switched off until you rewrite it">
									<Icon name="error" size={14} aria-label="Switched off until you rewrite it" />
								</span>
							{:else}
								<Toggle
									size="sm"
									checked={rule.enabled}
									disabled={busy}
									ariaLabel={rule.name || 'Untitled rule'}
									onChange={() => onToggleRule(rule)}
								/>
							{/if}
							<div class="flex-1 min-w-0">
								<button
									type="button"
									class="block w-full min-w-0 text-left cursor-pointer group"
									onclick={(e) => onOpenRule(rule, e.currentTarget)}
								>
									<span class="block truncate text-sm text-text group-hover:text-accent-fg transition-colors">{rule.name || 'Untitled rule'}</span>
									<span class="block truncate text-2xs text-text-tertiary">{conditionsText(rule)}</span>
								</button>
								{#if hasRowNote(rule)}
									<!-- The same note as under "All rules, in order", until it is read. -->
									<span class="flex items-center gap-2 text-2xs text-warning" role="note">
										<span class="truncate">{rowNote(rule)}</span>
										<button
											type="button"
											onclick={() => onDismissRule(rule)}
											disabled={busy}
											class="shrink-0 underline cursor-pointer disabled:opacity-50"
										>Got it</button>
									</span>
								{/if}
							</div>
						</li>
					{/each}
				</ul>
			{/if}
			<button type="button" onclick={(e) => onAddRule(target, e.currentTarget)} class="btn btn-secondary btn-sm mt-1.5">
				<Icon name="add" size={14} />
				Add rule
			</button>
			{#if editable}
				<!-- On a phone the row itself has no room for these. -->
				<div class="md:hidden flex items-center gap-1 mt-2 -ml-1.5">
					<button
						type="button"
						onclick={() => onEdit?.()}
						disabled={working}
						class="text-xs text-text-tertiary hover:text-text px-1.5 py-1 rounded-md hover:bg-surface-hover transition-colors cursor-pointer disabled:opacity-50"
					>Edit {noun}</button>
					<button
						type="button"
						onclick={remove}
						disabled={working}
						class="text-xs text-text-tertiary hover:text-danger px-1.5 py-1 rounded-md hover:bg-surface-hover transition-colors cursor-pointer disabled:opacity-50"
					>Delete {noun}</button>
				</div>
			{/if}
		</div>
	{/if}
</div>

{#snippet rowName()}
	{#if kind === 'system'}
		<Icon name={mailboxIconName(mailbox.role)} class="text-text-tertiary" />
	{:else}
		<MailboxIcon node={iconNode} fallback={kind === 'label' ? 'dot' : 'folder'} {color} />
	{/if}
	<span class="min-w-0 truncate text-sm {kind === 'system' ? 'text-text-secondary' : 'text-text'}">{name}</span>
	<!-- On a phone the name comes first: the unread count gives way to it. -->
	{#if mailbox.unreadEmails > 0}
		<span class="max-md:hidden text-xs text-text-tertiary shrink-0 tabular-nums">{mailbox.unreadEmails} unread</span>
	{/if}
	{#if rules.length > 0}
		<span class="text-xs text-text-tertiary shrink-0"
			>{#if mailbox.unreadEmails > 0}<span class="max-md:hidden mr-2">·</span>{/if}{rulesCount}</span
		>
	{/if}
{/snippet}
