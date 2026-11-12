<script lang="ts">
	import Icon from '$lib/components/Icon.svelte';
	import MailboxIcon from '$lib/components/MailboxIcon.svelte';
	import Toggle from './Toggle.svelte';
	import RowMenu from './RowMenu.svelte';
	import { goto, invalidateAll } from '$app/navigation';
	import { page } from '$app/state';
	import type { Mailbox } from '$lib/jmap/types';
	import type { IconNode } from '$lib/types/icon-node';
	import { mailboxDeleteRulesNote, needsRewrite, type Rule, type RuleTarget } from '$lib/types/rules';
	import { conditionsText, hasRowNote, rowNote } from '$lib/rules/describe';
	import { mailboxIconName } from '$lib/icons';

	/**
	 * One folder, label or system folder in Settings, with the rules that
	 * file mail into it. Opened, it lists those rules and offers "Add rule",
	 * started with this as the place to file.
	 *
	 * A folder or label is dragged by the handle at its start to reorder it
	 * (or, a folder, to put it inside another); the list around the rows
	 * does the dragging (see $lib/actions/sortable), so the row only marks
	 * what is the row and what is the handle. View, Edit and Delete are
	 * behind the one button at its end, so the name keeps its room.
	 */
	let {
		mailbox,
		name: shownName,
		kind,
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

<!-- The indent: 24px a level; on a phone 14px, and no deeper than four levels. -->
<div
	role="group"
	aria-label={name}
	tabindex="-1"
	class="outline-none"
	style="--indent: {depth * 24}px; --indent-sm: {Math.min(depth, 4) * 14}px"
>
	<!-- The row itself: what is dragged, and what a drop lands on. -->
	<div
		data-sort-id={editable ? mailbox.id : undefined}
		class="flex items-center gap-1 min-h-14 pr-3 max-md:pr-2 pl-[calc(0.5rem+var(--indent))] max-md:pl-[calc(0.25rem+var(--indent-sm))]"
	>
		{#if editable}
			<button
				type="button"
				data-sort-handle
				aria-label="Reorder {name}"
				disabled={working}
				class="w-6 h-9 max-md:h-11 shrink-0 flex items-center justify-center rounded-md text-text-tertiary hover:text-text transition-colors disabled:opacity-50"
			>
				<Icon name="reorder" size={16} />
			</button>
		{:else}
			<span class="w-6 shrink-0"></span>
		{/if}
		{#if target}
			<button
				type="button"
				onclick={() => (open = !open)}
				aria-expanded={open}
				class="flex-1 min-w-0 flex items-center gap-2.5 h-9 max-md:h-11 px-1.5 rounded-md text-left cursor-pointer hover:bg-surface-hover focus-visible:bg-surface-hover transition-colors"
			>
				<Icon name="next" size={12} class="text-text-tertiary transition-transform duration-150 {open ? 'rotate-90' : ''}" />
				{@render rowName()}
			</button>
		{:else}
			<div class="flex-1 min-w-0 flex items-center gap-2.5 h-9 px-1.5">
				<span class="w-3 shrink-0"></span>
				{@render rowName()}
			</div>
		{/if}
		{#if editable}
			<RowMenu
				ariaLabel="{name} options"
				items={[
					{ label: 'View', onSelect: () => goto(`/folder/${mailbox.id}`) },
					{ label: 'Edit', disabled: working, onSelect: () => onEdit?.() },
					{ label: 'Delete', danger: true, disabled: working, onSelect: remove }
				]}
			/>
		{/if}
	</div>

	{#if open && target}
		<div class="pb-3 pr-3 pl-[calc(4.25rem+var(--indent))] max-md:pl-[calc(3.75rem+var(--indent-sm))]">
			{#if rules.length === 0}
				<p class="text-[0.8125rem] text-text-tertiary py-1.5">No rules</p>
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
		</div>
	{/if}
</div>

{#snippet rowName()}
	{#if kind === 'system'}
		<Icon name={mailboxIconName(mailbox.role)} class="text-text-tertiary" />
	{:else}
		<MailboxIcon node={iconNode} fallback={kind === 'label' ? 'dot' : 'folder'} {color} />
	{/if}
	<span class="flex-1 min-w-0 truncate text-sm font-medium {kind === 'system' ? 'text-text-secondary' : 'text-text'}">{name}</span>
	{#if rules.length > 0}
		<span class="text-[0.8125rem] text-text-tertiary shrink-0">{rulesCount}</span>
	{/if}
{/snippet}
