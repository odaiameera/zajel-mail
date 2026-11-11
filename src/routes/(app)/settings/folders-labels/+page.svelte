<script lang="ts">
	import Icon from '$lib/components/Icon.svelte';
	import CreateMailboxModal, { type EditingMailbox } from '$lib/components/modals/CreateMailboxModal.svelte';
	import MailboxRow from '$lib/components/settings/MailboxRow.svelte';
	import RuleDialog from '$lib/components/settings/RuleDialog.svelte';
	import RuleApplyDialog from '$lib/components/settings/RuleApplyDialog.svelte';
	import Toggle from '$lib/components/settings/Toggle.svelte';
	import { page } from '$app/state';
	import { fly } from 'svelte/transition';
	import { pageTitle } from '$lib/utils/title';
	import { colorByHex } from '$lib/constants/colors';
	import { buildFolderTree, flattenFolderTree } from '$lib/utils/folder-tree';
	import { hasRowNote, rowNote, ruleSummary } from '$lib/rules/describe';
	import { needsRewrite, RULE_ROLES, type Rule, type RuleRole, type RuleTarget } from '$lib/types/rules';
	import type { Mailbox } from '$lib/jmap/types';
	import type { Label } from '$lib/types/labels';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	// The saved rules, in the order they run, as the server last listed them.
	// Every change is saved at once through /api/rules and the list read back.
	// svelte-ignore state_referenced_locally
	let rules = $state<Rule[]>(data.rules ?? []);

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
	 * Move a rule one place up or down "All rules, in order": it changes
	 * places with its neighbour there, and nothing else moves. The rules
	 * waiting under "Needs your attention" keep their places in the real
	 * order between them.
	 */
	async function move(rule: Rule, by: -1 | 1) {
		const at = mainRules.findIndex((r) => r.id === rule.id);
		const other = at === -1 ? undefined : mainRules[at + by];
		if (!other) return;
		const ids = rules.map((r) => r.id);
		const i = ids.indexOf(rule.id);
		const j = ids.indexOf(other.id);
		[ids[i], ids[j]] = [ids[j], ids[i]];
		await send('/api/rules/reorder', { method: 'POST', body: JSON.stringify({ ids }) }, 'rules');
	}

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
		if (dialog?.ruleId && !dialogRule) dialog = null;
	});

	function openRule(rule: Rule) {
		errors.dialog = '';
		dialog = { ruleId: rule.id };
	}
	function newRule(target?: RuleTarget) {
		errors.dialog = '';
		dialog = { ruleId: null, target };
	}

	/** The rule "Save & apply" is running, while its progress shows. */
	let applying = $state<Rule | null>(null);

	async function onSaved(rule: Rule, apply: boolean) {
		await refresh();
		dialog = null;
		if (apply) {
			applying = rule;
		} else {
			savedToast = true;
			setTimeout(() => (savedToast = false), 1600);
		}
	}

	async function onDeleted() {
		await refresh();
		dialog = null;
	}

	// --- "All rules, in order" ---

	let rulesOpen = $state(false);
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
		<p class="mb-2 px-3 py-2 rounded-lg bg-danger/10 border border-danger/20 text-danger text-xs" role="alert">{message}</p>
	{/if}
{/snippet}

{#snippet sectionHeading(id: string, title: string, description?: string)}
	<h2 {id} class="text-sm font-semibold text-text mb-1">{title}</h2>
	{#if description}
		<p class="text-xs text-text-tertiary mb-2">{description}</p>
	{/if}
{/snippet}

<header class="mb-8 flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
	<div class="min-w-0 flex-1 basis-72">
		<h1 class="text-xl font-semibold text-text">Folders &amp; labels</h1>
		<p class="text-sm text-text-tertiary mt-1 max-w-prose">
			A folder is where a message lives, and a label is a tag it can carry as well. Rules file new
			mail into either.
		</p>
	</div>
	<div class="flex items-center gap-2 shrink-0">
		<button type="button" onclick={() => (modal = { kind: 'folder', editing: null })} class="btn btn-secondary">
			<Icon name="add" size={14} />
			New folder
		</button>
		<button type="button" onclick={() => (modal = { kind: 'label', editing: null })} class="btn btn-secondary">
			<Icon name="add" size={14} />
			New label
		</button>
	</div>
</header>

{#if attentionRules.length > 0}
	<section class="mb-8" aria-labelledby="attention-heading">
		{@render sectionHeading(
			'attention-heading',
			'Needs your attention',
			'An upgrade switched these rules off. Open one to see why, and what you can do.'
		)}
		{@render alert(errors.attention)}
		<ul class="border-y border-border divide-y divide-border">
			{#each attentionRules as rule (rule.id)}
				<li>
					<button
						type="button"
						onclick={() => openRule(rule)}
						class="w-full flex items-center gap-3 py-2.5 text-left cursor-pointer group"
					>
						<span class="shrink-0 text-warning" title="Switched off until you rewrite it">
							<Icon name="error" size={14} aria-label="Switched off until you rewrite it" />
						</span>
						<span class="flex-1 min-w-0">
							<span class="block truncate text-sm text-text group-hover:text-accent-fg transition-colors">{rule.name || 'Untitled rule'}</span>
							<span class="block truncate text-2xs text-text-tertiary">{summary(rule)}</span>
						</span>
						<Icon name="next" size={14} class="text-text-tertiary" />
					</button>
				</li>
			{/each}
		</ul>
	</section>
{/if}

<section class="mb-8" aria-labelledby="folders-heading">
	{@render sectionHeading('folders-heading', 'Folders', 'They show up in every mail app connected to this account. Open one to see the rules that file into it.')}
	{@render alert(errors.folders)}
	{#if folders.length === 0}
		<p class="text-sm text-text-tertiary py-2">No folders yet.</p>
	{:else}
		<div class="border-y border-border divide-y divide-border">
			{#each folders as { mailbox, depth } (mailbox.id)}
				{@const meta = data.mailboxMeta[mailbox.id]}
				{@const target = { kind: 'folder', mailboxId: mailbox.id } as RuleTarget}
				<MailboxRow
					{mailbox}
					kind="folder"
					mailboxes={data.mailboxes}
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
					onError={(message) => (errors.folders = message)}
					onChanged={refresh}
				/>
			{/each}
		</div>
	{/if}
</section>

<section class="mb-8" aria-labelledby="labels-heading">
	{@render sectionHeading('labels-heading', 'Labels', 'Other mail apps show them as folders under Labels/. A message keeps its folder when it gets a label.')}
	{@render alert(errors.labels)}
	{#if labels.length === 0}
		<p class="text-sm text-text-tertiary py-2">No labels yet.</p>
	{:else}
		<div class="border-y border-border divide-y divide-border">
			{#each labels as { label, mailbox } (label.id)}
				{@const target = { kind: 'label', mailboxId: label.id } as RuleTarget}
				<MailboxRow
					{mailbox}
					kind="label"
					mailboxes={data.mailboxes}
					color={label.color}
					iconNode={label.iconNode ?? null}
					rules={rulesInto(target)}
					{target}
					{busy}
					onEdit={() => editLabel(label)}
					onOpenRule={openRule}
					onAddRule={newRule}
					onToggleRule={(rule) => toggleRule(rule, 'labels')}
					onError={(message) => (errors.labels = message)}
					onChanged={refresh}
				/>
			{/each}
		</div>
	{/if}
</section>

<section class="mb-8" aria-labelledby="system-heading">
	{@render sectionHeading('system-heading', 'System folders', 'Managed by the mail server: they can’t be renamed, moved or deleted. Rules can file into Archive, Junk and Trash.')}
	{@render alert(errors.system)}
	<div class="border-y border-border divide-y divide-border">
		{#each systemFolders as mailbox (mailbox.id)}
			{@const target = roleTarget(mailbox.role)}
			<MailboxRow
				{mailbox}
				kind="system"
				mailboxes={data.mailboxes}
				rules={target ? rulesInto(target) : []}
				{target}
				{busy}
				onOpenRule={openRule}
				onAddRule={newRule}
				onToggleRule={(rule) => toggleRule(rule, 'system')}
				onError={(message) => (errors.system = message)}
			/>
		{/each}
	</div>
</section>

<section id="rules" class="mb-8 scroll-mt-6" aria-labelledby="rules-heading">
	<h2 id="rules-heading" class="text-sm font-semibold text-text">
		<button
			type="button"
			onclick={() => (rulesOpen = !rulesOpen)}
			aria-expanded={rulesOpen}
			class="inline-flex items-center gap-1.5 cursor-pointer hover:text-accent-fg transition-colors"
		>
			All rules, in order
			<Icon name="next" size={12} class="text-text-tertiary transition-transform duration-150 {rulesOpen ? 'rotate-90' : ''}" />
		</button>
	</h2>
	<p class="text-xs text-text-tertiary mt-1 mb-2">
		{mainRules.length} {mainRules.length === 1 ? 'rule' : 'rules'} that can run, top first. Labels add up; the first rule that
		moves a message decides its folder.
	</p>
	{#if rulesOpen}
		{@render alert(errors.rules)}
		{#if mainRules.length > 0}
			<ul class="border-y border-border divide-y divide-border">
				{#each mainRules as rule, index (rule.id)}
					<li class="flex items-center gap-3 py-2">
						<Toggle
							checked={rule.enabled}
							disabled={busy}
							ariaLabel={rule.name || 'Untitled rule'}
							onChange={() => toggleRule(rule, 'rules')}
						/>
						<div class="flex-1 min-w-0">
							<button type="button" class="block w-full min-w-0 text-left cursor-pointer group" onclick={() => openRule(rule)}>
								<span class="block truncate text-sm text-text group-hover:text-accent-fg transition-colors">{rule.name || 'Untitled rule'}</span>
								<span class="block truncate text-2xs text-text-tertiary">{summary(rule)}</span>
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
						<button
							type="button"
							onclick={() => move(rule, -1)}
							disabled={busy || index === 0}
							title="Move up"
							aria-label="Move {rule.name || 'Untitled rule'} up"
							class="p-1 rounded-md text-text-tertiary hover:text-text hover:bg-surface-hover transition-colors cursor-pointer disabled:opacity-30 disabled:cursor-default disabled:hover:bg-transparent"
						><Icon name="move-up" size={14} /></button>
						<button
							type="button"
							onclick={() => move(rule, 1)}
							disabled={busy || index === mainRules.length - 1}
							title="Move down"
							aria-label="Move {rule.name || 'Untitled rule'} down"
							class="p-1 rounded-md text-text-tertiary hover:text-text hover:bg-surface-hover transition-colors cursor-pointer disabled:opacity-30 disabled:cursor-default disabled:hover:bg-transparent"
						><Icon name="move-down" size={14} /></button>
					</li>
				{/each}
			</ul>
		{:else}
			<p class="text-sm text-text-tertiary py-2">No rules yet.</p>
		{/if}
		<button type="button" onclick={() => newRule()} class="btn btn-secondary btn-sm mt-3">
			<Icon name="add" size={14} />
			New rule
		</button>
	{/if}
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
			onClose={() => (dialog = null)}
		/>
	{/key}
{/if}

{#if applying}
	<RuleApplyDialog rule={applying} onClose={() => (applying = null)} />
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
