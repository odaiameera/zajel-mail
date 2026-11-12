<script lang="ts">
	import Icon from '$lib/components/Icon.svelte';
	import CreateMailboxModal, { type EditingMailbox } from '$lib/components/modals/CreateMailboxModal.svelte';
	import MailboxRow from '$lib/components/settings/MailboxRow.svelte';
	import RuleDialog from '$lib/components/settings/RuleDialog.svelte';
	import RuleApplyDialog from '$lib/components/settings/RuleApplyDialog.svelte';
	import Toggle from '$lib/components/settings/Toggle.svelte';
	import PageHeader from '$lib/components/settings/PageHeader.svelte';
	import Section from '$lib/components/settings/Section.svelte';
	import { invalidateAll } from '$app/navigation';
	import { page } from '$app/state';
	import { tick } from 'svelte';
	import { fly } from 'svelte/transition';
	import { pageTitle } from '$lib/utils/title';
	import { colorByHex } from '$lib/constants/colors';
	import {
		buildFolderTree,
		dropRequest,
		flattenFolderTree,
		moveStep,
		orderedSiblings,
		type ReorderRequest
	} from '$lib/utils/folder-tree';
	import { reordered, sortable, type SortMove } from '$lib/actions/sortable';
	import { hasRowNote, rowNote, ruleSummary } from '$lib/rules/describe';
	import { needsRewrite, RULE_ROLES, type Rule, type RuleRole, type RuleTarget } from '$lib/types/rules';
	import type { Mailbox } from '$lib/jmap/types';
	import type { Label } from '$lib/types/labels';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	// The saved rules, in the order they run, as the server last listed them.
	// Every change is saved at once through /api/rules and the list read back.
	// A new load (another account, say) replaces them; which rows are open
	// is kept by the rows themselves.
	let rules = $derived<Rule[]>(data.rules ?? []);

	// Rules an upgrade switched off until their owner deals with them are
	// listed apart, so they aren't missed. Every rule that can run is in
	// "All rules, in order", in its real order: one carrying only a note (it
	// was split, or lost its tab) still runs, so it stays where it runs.
	const attentionRules = $derived(rules.filter((r) => needsRewrite(r)));
	const mainRules = $derived(rules.filter((r) => !needsRewrite(r)));

	const summary = (rule: Rule) => ruleSummary(rule, data.mailboxes, data.labels);

	// --- Folders, labels, system folders ---

	const mailboxById = $derived(new Map(data.mailboxes.map((m) => [m.id, m])));
	// The folder tree as a flat list, in order, with its depth for the indent.
	const folders = $derived(
		flattenFolderTree(buildFolderTree(data.mailboxes))
			.map((opt) => ({ mailbox: mailboxById.get(opt.id), depth: opt.depth }))
			.filter((f): f is { mailbox: Mailbox; depth: number } => !!f.mailbox)
	);
	const labels = $derived(
		data.labels
			.map((label) => ({ label, mailbox: mailboxById.get(label.id) }))
			.filter((l): l is { label: Label; mailbox: Mailbox } => !!l.mailbox)
	);
	const systemFolders = $derived(data.mailboxes.filter((m) => m.role !== null));

	const sameTarget = (a: RuleTarget, b: RuleTarget) =>
		a.kind === b.kind && ('mailboxId' in a ? a.mailboxId : null) === ('mailboxId' in b ? b.mailboxId : null);
	const rulesInto = (target: RuleTarget) => rules.filter((r) => sameTarget(r.target, target));
	const roleTarget = (role: string | null): RuleTarget | null =>
		RULE_ROLES.includes(role as RuleRole) ? { kind: role as RuleRole } : null;

	// --- Saving ---

	/** Where a refusal is shown: at the top of the section the change was made in. */
	type Place = 'attention' | 'folders' | 'labels' | 'system' | 'rules' | 'dialog';
	let errors = $state<Partial<Record<Place, string>>>({});
	let busy = $state(false);
	let savedToast = $state(false);

	async function refresh() {
		const res = await fetch('/api/rules').catch(() => null);
		if (res?.ok) rules = ((await res.json()) as { rules: Rule[] }).rules;
	}

	/** A change to the saved rules: sent, then the list read back. False when the server said no. */
	async function send(url: string, init: RequestInit, place: Place): Promise<boolean> {
		busy = true;
		errors[place] = '';
		try {
			const res = await fetch(url, { headers: { 'Content-Type': 'application/json' }, ...init }).catch(() => null);
			if (!res?.ok) {
				errors[place] = (await res?.json().catch(() => null))?.error ?? 'That didn’t save. Try again.';
				return false;
			}
			await refresh();
			return true;
		} finally {
			busy = false;
		}
	}

	const toggleRule = (rule: Rule, place: Place) =>
		send(
			`/api/rules/${encodeURIComponent(rule.id)}`,
			{ method: 'PATCH', body: JSON.stringify({ enabled: !rule.enabled }) },
			place
		);

	/**
	 * A rule dragged to a new place in "All rules, in order" (or moved with
	 * the arrow keys on its handle). Only the rules listed there change
	 * places: the ones waiting under "Needs your attention" keep theirs in
	 * the real order between them.
	 */
	async function moveRule(move: SortMove) {
		const listed = mainRules.map((r) => r.id);
		const next = reordered(listed, move);
		if (next.join() === listed.join()) return;
		const inList = new Set(listed);
		let at = 0;
		const ids = rules.map((r) => (inList.has(r.id) ? next[at++] : r.id));
		await send('/api/rules/reorder', { method: 'POST', body: JSON.stringify({ ids }) }, 'rules');
	}

	// --- Rearranging folders and labels ---
	//
	// A row dragged by its handle lands before or after another, or (a
	// folder) inside one: the same rules as in the mail sidebar, and the
	// same request. The arrow keys on a handle move it one place among its
	// siblings.

	let moving = $state(false);

	async function reorderMailbox(request: ReorderRequest | null, place: 'folders' | 'labels') {
		if (!request || moving) return;
		moving = true;
		errors[place] = '';
		try {
			const res = await fetch('/api/folders', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ action: 'reorder', ...request })
			}).catch(() => null);
			const payload = (await res?.json().catch(() => ({}))) ?? {};
			if (!res?.ok || payload?.success === false) {
				const noun = place === 'labels' ? 'label' : 'folder';
				errors[place] = typeof payload?.error === 'string' ? payload.error : `The ${noun} couldn’t be moved. Try again.`;
				return;
			}
			await invalidateAll();
		} finally {
			moving = false;
		}
	}

	/**
	 * What a drop asks for. Let go under the whole list, a folder goes to
	 * the end of the top level, whatever level the last row happens to be
	 * on: under the list is not "inside the last folder's parent".
	 */
	function placeFor(move: SortMove, place: 'folders' | 'labels'): ReorderRequest | null {
		if (place === 'folders' && move.edge === 'end') {
			const moved = data.mailboxes.find((m) => m.id === move.id);
			if (!moved) return null;
			const top = orderedSiblings(data.mailboxes, null, false);
			// Already the last one at the top level: nothing to ask for.
			if ((moved.parentId ?? null) === null && top[top.length - 1]?.id === moved.id) return null;
			return { id: move.id, parentId: null, beforeId: null };
		}
		return dropRequest(data.mailboxes, move.id, move.targetId, move.zone);
	}

	const mailboxSorting = (place: 'folders' | 'labels') => ({
		disabled: moving,
		// A folder takes another inside it; a label doesn't.
		canNest: () => place === 'folders',
		canPlace: (id: string, targetId: string, zone: SortMove['zone'], edge?: SortMove['edge']) =>
			!!placeFor({ id, targetId, zone, edge }, place),
		onMove: (move: SortMove) => reorderMailbox(placeFor(move, place), place),
		onStep: (id: string, direction: 'up' | 'down') => reorderMailbox(moveStep(data.mailboxes, id, direction), place)
	});

	const dismiss = (id: string, place: Place) =>
		send(`/api/rules/${encodeURIComponent(id)}/dismiss`, { method: 'POST' }, place);

	/** Make the pin a flagged tab rule names, and remove the rule: one call, so a failure leaves the rule where it is. */
	const pinInstead = (id: string) => send(`/api/rules/${encodeURIComponent(id)}/pin`, { method: 'POST' }, 'dialog');

	// --- The rule dialog ---

	/** The rule open in the dialog (null: a new one, filing into `target` to begin with). */
	let dialog = $state<{ ruleId: string | null; target?: RuleTarget } | null>(null);
	const dialogRule = $derived(dialog?.ruleId ? (rules.find((r) => r.id === dialog?.ruleId) ?? null) : null);
	// A rule that went away while open (it became a pin, or was dismissed) closes its dialog.
	$effect(() => {
		if (dialog?.ruleId && !dialogRule) closeDialog();
	});

	/**
	 * Where focus goes when the dialog closes: the control that opened it;
	 * if that went (its rule was deleted), the row it was in; else the
	 * heading of its section.
	 */
	let returnTo: { opener: HTMLElement; row: HTMLElement | null; heading: HTMLElement | null } | null = null;

	function remember(opener: HTMLElement | undefined) {
		returnTo = opener
			? {
					opener,
					row: opener.closest<HTMLElement>('[role="group"]'),
					heading: opener.closest('section')?.querySelector<HTMLElement>('h2') ?? null
				}
			: null;
	}

	async function restoreFocus() {
		const to = returnTo;
		returnTo = null;
		await tick();
		const target = [to?.opener, to?.row, to?.heading].find((el) => el?.isConnected) ?? document.querySelector<HTMLElement>('h1');
		target?.focus();
	}

	function openRule(rule: Rule, opener?: HTMLElement) {
		errors.dialog = '';
		remember(opener);
		dialog = { ruleId: rule.id };
	}
	function newRule(target?: RuleTarget, opener?: HTMLElement) {
		errors.dialog = '';
		remember(opener);
		dialog = { ruleId: null, target };
	}
	function closeDialog() {
		// Closed once: a rule deleted from the dialog also goes from the list.
		if (!dialog) return;
		dialog = null;
		restoreFocus();
	}

	/** The rule "Save & apply" is running, while its progress shows. */
	let applying = $state<Rule | null>(null);

	async function onSaved(rule: Rule, apply: boolean) {
		await refresh();
		if (apply) {
			// Its progress takes focus; it goes back to the opener when that closes.
			dialog = null;
			applying = rule;
		} else {
			closeDialog();
			savedToast = true;
			setTimeout(() => (savedToast = false), 1600);
		}
	}

	async function onDeleted() {
		await refresh();
		closeDialog();
	}

	// --- "All rules, in order" ---

	let rulesOpen = $state(false);
	let systemOpen = $state(false);
	// Opened for a link to #rules.
	$effect(() => {
		if (page.url.hash === '#rules') rulesOpen = true;
	});

	// --- Creating and editing folders and labels ---

	let modal = $state<{ kind: 'folder' | 'label'; editing: EditingMailbox | null } | null>(null);

	function editFolder(folder: Mailbox) {
		const meta = data.mailboxMeta[folder.id];
		modal = {
			kind: 'folder',
			editing: {
				id: folder.id,
				name: folder.name,
				color: meta?.color ? colorByHex(meta.color) : null,
				icon: meta?.icon ?? null,
				parentId: folder.parentId
			}
		};
	}

	function editLabel(label: Label) {
		modal = {
			kind: 'label',
			editing: { id: label.id, name: label.name, color: colorByHex(label.color), icon: label.icon ?? null, parentId: null }
		};
	}
</script>

<svelte:head><title>{pageTitle({ page: 'Folders & labels', subtitle: 'Settings' })}</title></svelte:head>

{#snippet alert(message: string | undefined)}
	{#if message}
		<p class="mb-2 px-3 py-2 rounded-lg bg-danger/10 border border-danger/20 text-danger text-[0.8125rem]" role="alert">{message}</p>
	{/if}
{/snippet}

<!-- A list folded into one row of a card: its name, how many, and a chevron. -->
{#snippet fold(title: string, count: number, open: boolean, toggle: () => void)}
	<button
		type="button"
		onclick={toggle}
		aria-expanded={open}
		class="w-full flex items-center gap-4 min-h-14 px-5 max-md:px-4 text-left cursor-pointer rounded-xl hover:bg-surface-hover transition-colors"
	>
		<span class="flex-1 min-w-0 text-sm font-medium text-text">{title}</span>
		<span class="text-sm font-normal text-text-tertiary tabular-nums" aria-hidden="true">{count}</span>
		<Icon name="next" size={16} class="text-text-tertiary -mr-1 transition-transform duration-150 {open ? 'rotate-90' : ''}" />
	</button>
{/snippet}

<PageHeader title="Folders & labels">
	{#snippet actions()}
		<button type="button" onclick={() => (modal = { kind: 'folder', editing: null })} class="btn btn-secondary">
			<Icon name="add" size={14} />
			New folder
		</button>
		<button type="button" onclick={() => (modal = { kind: 'label', editing: null })} class="btn btn-secondary">
			<Icon name="add" size={14} />
			New label
		</button>
	{/snippet}
</PageHeader>

{#if attentionRules.length > 0}
	<!-- Kept: rules that stopped running say so, and why is one press away. -->
	<Section title="Needs your attention" id="attention" bare>
		<p class="text-[0.8125rem] text-text-tertiary -mt-1 mb-2">An upgrade switched these rules off.</p>
		{@render alert(errors.attention)}
		<ul class="rounded-xl border border-border divide-y divide-border">
			{#each attentionRules as rule (rule.id)}
				<li>
					<button
						type="button"
						onclick={(e) => openRule(rule, e.currentTarget)}
						class="w-full flex items-center gap-3 min-h-14 px-5 max-md:px-4 py-2 text-left cursor-pointer group"
					>
						<span class="shrink-0 text-warning" title="Switched off until you rewrite it">
							<Icon name="error" size={14} aria-label="Switched off until you rewrite it" />
						</span>
						<span class="flex-1 min-w-0">
							<span class="block truncate text-sm font-medium text-text group-hover:text-accent-fg transition-colors">{rule.name || 'Untitled rule'}</span>
							<span class="block truncate text-[0.8125rem] text-text-tertiary">{summary(rule)}</span>
						</span>
						<Icon name="next" size={16} class="text-text-tertiary -mr-1" />
					</button>
				</li>
			{/each}
		</ul>
	</Section>
{/if}

<Section title="Folders" id="folders" bare>
	{@render alert(errors.folders)}
	{#if folders.length === 0}
		<p class="text-sm text-text-tertiary py-2">No folders</p>
	{:else}
		<div class="rounded-xl border border-border divide-y divide-border" use:sortable={mailboxSorting('folders')}>
			{#each folders as { mailbox, depth } (mailbox.id)}
				{@const meta = data.mailboxMeta[mailbox.id]}
				{@const target = { kind: 'folder', mailboxId: mailbox.id } as RuleTarget}
				<MailboxRow
					{mailbox}
					kind="folder"
					{depth}
					color={meta?.color ?? null}
					iconNode={meta?.iconNode ?? null}
					rules={rulesInto(target)}
					{target}
					{busy}
					onEdit={() => editFolder(mailbox)}
					onOpenRule={openRule}
					onAddRule={newRule}
					onToggleRule={(rule) => toggleRule(rule, 'folders')}
					onDismissRule={(rule) => dismiss(rule.id, 'folders')}
					onError={(message) => (errors.folders = message)}
					onChanged={refresh}
				/>
			{/each}
		</div>
	{/if}
</Section>

<Section title="Labels" id="labels" bare>
	{@render alert(errors.labels)}
	{#if labels.length === 0}
		<p class="text-sm text-text-tertiary py-2">No labels</p>
	{:else}
		<div class="rounded-xl border border-border divide-y divide-border" use:sortable={mailboxSorting('labels')}>
			{#each labels as { label, mailbox } (label.id)}
				{@const target = { kind: 'label', mailboxId: label.id } as RuleTarget}
				<MailboxRow
					{mailbox}
					name={label.name}
					kind="label"
					color={label.color}
					iconNode={label.iconNode ?? null}
					rules={rulesInto(target)}
					{target}
					{busy}
					onEdit={() => editLabel(label)}
					onOpenRule={openRule}
					onAddRule={newRule}
					onToggleRule={(rule) => toggleRule(rule, 'labels')}
					onDismissRule={(rule) => dismiss(rule.id, 'labels')}
					onError={(message) => (errors.labels = message)}
					onChanged={refresh}
				/>
			{/each}
		</div>
	{/if}
</Section>

<!-- The two lists that are looked at now and then, each folded into a row. -->
<section id="rules" class="mb-3 scroll-mt-6" aria-labelledby="rules-heading">
	<div class="rounded-xl border border-border divide-y divide-border">
		<h2 id="rules-heading" tabindex="-1" class="outline-none">
			{@render fold('All rules, in order', mainRules.length, rulesOpen, () => (rulesOpen = !rulesOpen))}
		</h2>
		{#if rulesOpen}
			<!-- Kept: why the order matters is the point of the list. -->
			<p class="px-5 max-md:px-4 py-2.5 text-[0.8125rem] text-text-tertiary">
				Top first. Labels add up; the first rule that moves a message decides its folder.
			</p>
			{#if errors.rules}
				<div class="px-5 max-md:px-4 pt-2">{@render alert(errors.rules)}</div>
			{/if}
			{#if mainRules.length > 0}
				<ul class="divide-y divide-border" use:sortable={{ onMove: moveRule, disabled: busy || mainRules.length < 2 }}>
					{#each mainRules as rule (rule.id)}
						<li data-sort-id={rule.id} class="flex items-center gap-2 min-h-14 pl-2 pr-5 max-md:pr-4 py-2">
							<button
								type="button"
								data-sort-handle
								aria-label="Reorder {rule.name || 'Untitled rule'}"
								disabled={mainRules.length < 2}
								class="w-6 h-9 max-md:h-11 shrink-0 flex items-center justify-center rounded-md text-text-tertiary hover:text-text transition-colors disabled:opacity-30 disabled:cursor-default"
							>
								<Icon name="reorder" size={16} />
							</button>
							<div class="flex-1 min-w-0 px-1.5">
								<button type="button" class="block w-full min-w-0 text-left cursor-pointer group" onclick={(e) => openRule(rule, e.currentTarget)}>
									<span class="block truncate text-sm font-medium text-text group-hover:text-accent-fg transition-colors">{rule.name || 'Untitled rule'}</span>
									<span class="block truncate text-[0.8125rem] text-text-tertiary">{summary(rule)}</span>
								</button>
								{#if hasRowNote(rule)}
									<!-- A note on a rule that runs: said where it runs, until it is read. -->
									<span class="flex items-center gap-2 text-2xs text-warning" role="note">
										<span class="truncate">{rowNote(rule)}</span>
										<button
											type="button"
											onclick={() => dismiss(rule.id, 'rules')}
											disabled={busy}
											class="shrink-0 underline cursor-pointer disabled:opacity-50"
										>Got it</button>
									</span>
								{/if}
							</div>
							<Toggle
								size="sm"
								checked={rule.enabled}
								disabled={busy}
								ariaLabel={rule.name || 'Untitled rule'}
								onChange={() => toggleRule(rule, 'rules')}
							/>
						</li>
					{/each}
				</ul>
			{:else}
				<p class="px-5 max-md:px-4 py-4 text-sm text-text-tertiary">No rules</p>
			{/if}
			<div class="px-5 max-md:px-4 py-3">
				<button type="button" onclick={(e) => newRule(undefined, e.currentTarget)} class="btn btn-secondary btn-sm">
					<Icon name="add" size={14} />
					New rule
				</button>
			</div>
		{/if}
	</div>
</section>

<!-- Managed by the mail server: nothing here is renamed, moved or deleted,
     so they have no handle and no menu. Rules can file into some of them. -->
<section id="system" class="mb-8 scroll-mt-6" aria-labelledby="system-heading">
	<div class="rounded-xl border border-border divide-y divide-border">
		<h2 id="system-heading" tabindex="-1" class="outline-none">
			{@render fold('System folders', systemFolders.length, systemOpen, () => (systemOpen = !systemOpen))}
		</h2>
		{#if systemOpen}
			{#if errors.system}
				<div class="px-5 max-md:px-4 pt-2">{@render alert(errors.system)}</div>
			{/if}
			{#each systemFolders as mailbox (mailbox.id)}
				{@const target = roleTarget(mailbox.role)}
				<MailboxRow
					{mailbox}
					kind="system"
					rules={target ? rulesInto(target) : []}
					{target}
					{busy}
					onOpenRule={openRule}
					onAddRule={newRule}
					onToggleRule={(rule) => toggleRule(rule, 'system')}
					onDismissRule={(rule) => dismiss(rule.id, 'system')}
					onError={(message) => (errors.system = message)}
				/>
			{/each}
		{/if}
	</div>
</section>

{#if dialog}
	{#key dialog}
		<RuleDialog
			rule={dialogRule}
			initialTarget={dialog.target}
			mailboxes={data.mailboxes}
			labels={data.labels}
			{busy}
			error={errors.dialog}
			{onSaved}
			{onDeleted}
			onDismiss={(id) => dismiss(id, 'dialog')}
			onPin={pinInstead}
			onClose={closeDialog}
		/>
	{/key}
{/if}

{#if applying}
	<RuleApplyDialog
		rule={applying}
		onClose={() => {
			applying = null;
			restoreFocus();
		}}
	/>
{/if}

{#if modal}
	<CreateMailboxModal
		kind={modal.kind}
		open={true}
		mailboxes={data.mailboxes}
		editing={modal.editing}
		onClose={() => (modal = null)}
	/>
{/if}

{#if savedToast}
	<div
		class="fixed bottom-[calc(1.5rem-var(--app-under))] left-1/2 -translate-x-1/2 bg-surface border border-border rounded-full px-4 py-2 text-sm text-text shadow-lg z-50"
		transition:fly={{ y: 12, duration: 200 }}
	>
		Saved
	</div>
{/if}
