<script lang="ts">
	import Icon from '$lib/components/Icon.svelte';
	import { pageTitle } from '$lib/utils/title';
	import { invalidateAll } from '$app/navigation';
	import SettingRow, { type SaveState } from '$lib/components/settings/SettingRow.svelte';
	import Toggle from '$lib/components/settings/Toggle.svelte';
	import { INBOX_CATEGORIES, type InboxCategory } from '$lib/types/categories';
	import { CATEGORY_ICON } from '$lib/components/category-icons';
	import JevBackfill from '$lib/components/JevBackfill.svelte';
	import JevSpamReport from '$lib/components/JevSpamReport.svelte';
	import Select from '$lib/components/settings/Select.svelte';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	type Key = 'inboxTabs' | 'jevEnabled';

	// Switch positions not yet confirmed by a reload, keyed by account id —
	// so a toggle moves at once, and falls back to the loaded value on error.
	const pending = $state<Record<string, Partial<Record<Key, boolean>>>>({});
	const states = $state<Record<string, SaveState>>({});
	const errors = $state<Record<string, string>>({});

	function current(account: (typeof data.jevAccounts)[number], key: Key): boolean {
		return pending[account.id]?.[key] ?? account[key];
	}

	async function save(accountId: string, patch: Partial<Record<Key, boolean>>, stateKey: string) {
		pending[accountId] = { ...pending[accountId], ...patch };
		delete errors[stateKey];
		states[stateKey] = 'saving';
		try {
			const res = await fetch('/api/jev/settings', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ accountId, ...patch })
			});
			if (!res.ok) {
				const body = await res.json().catch(() => null);
				throw new Error(body?.error ?? 'Couldn’t save. Try again.');
			}
			states[stateKey] = 'saved';
			setTimeout(() => { if (states[stateKey] === 'saved') states[stateKey] = 'idle'; }, 1800);
			await invalidateAll();
		} catch (err) {
			errors[stateKey] = err instanceof Error ? err.message : 'Couldn’t save. Try again.';
			states[stateKey] = 'error';
		}
		delete pending[accountId];
	}


	const configured = $derived(data.jev.mode !== 'off');

	function formatTokens(n: number): string {
		if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
		if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
		return String(n);
	}

	function formatCost(usd: number): string {
		if (usd === 0) return '$0';
		return usd < 0.01 ? '< $0.01' : `$${usd.toFixed(2)}`;
	}

	function monthLine(m: (typeof data.jevAccounts)[number]['month']): string {
		if (m.sorted === 0 && m.inputTokens === 0) return 'Nothing sorted yet this month.';
		const parts = [`This month: ${m.sorted} sorted`];
		if (m.sorted > 0) parts[0] += `, ${m.corrected} moved by you`;
		if (m.inputTokens > 0) parts.push(`${formatTokens(m.inputTokens)} tokens ≈ ${formatCost(m.costUsd)}`);
		return `${parts.join(' · ')}.`;
	}

	// --- Spam checks ---

	const spamModes = $state<Record<string, string>>({});

	async function saveSpamMode(accountId: string, mode: string) {
		const key = `${accountId}:spam`;
		spamModes[accountId] = mode;
		delete errors[key];
		states[key] = 'saving';
		try {
			const res = await fetch('/api/jev/settings', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ accountId, spamMode: mode })
			});
			if (!res.ok) {
				const body = await res.json().catch(() => null);
				throw new Error(body?.error ?? 'Couldn’t save. Try again.');
			}
			states[key] = 'saved';
			setTimeout(() => { if (states[key] === 'saved') states[key] = 'idle'; }, 1800);
			await invalidateAll();
		} catch (err) {
			errors[key] = err instanceof Error ? err.message : 'Couldn’t save. Try again.';
			states[key] = 'error';
		}
		delete spamModes[accountId];
	}

	// --- Pinned senders ---

	const newPinSender = $state<Record<string, string>>({});
	const newPinTab = $state<Record<string, InboxCategory>>({});
	let pinError = $state<Record<string, string>>({});

	async function savePin(accountId: string, sender: string, category: InboxCategory, method: 'POST' | 'DELETE' = 'POST') {
		pinError = { ...pinError, [accountId]: '' };
		const res = await fetch('/api/jev/pins', {
			method,
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ accountId, sender, category })
		}).catch(() => null);
		if (!res?.ok) {
			const body = await res?.json().catch(() => null);
			pinError = { ...pinError, [accountId]: body?.error ?? 'Couldn’t save the pin. Try again.' };
			return false;
		}
		await invalidateAll();
		return true;
	}

	async function addPin(accountId: string) {
		const sender = (newPinSender[accountId] ?? '').trim();
		if (!sender) return;
		if (await savePin(accountId, sender, newPinTab[accountId] ?? 'updates')) newPinSender[accountId] = '';
	}

	// --- Preview ---

	interface PreviewRow {
		id: string;
		from: string;
		subject: string;
		current: InboxCategory;
		pick: InboxCategory | null;
		confidence: number | null;
		tab: InboxCategory | null;
		error: string | null;
	}
	interface PreviewResult {
		total: number;
		counts: Record<InboxCategory, number>;
		failed: number;
		inputTokens: number;
		costUsd: number;
		mock: boolean;
		rows: PreviewRow[];
	}

	let preview = $state<PreviewResult | null>(null);
	let previewing = $state(false);
	let previewError = $state('');

	const activeAccount = $derived(data.jevAccounts.find((a) => a.isActive));
	const labelOf = (key: string | null) => INBOX_CATEGORIES.find((c) => c.key === key)?.label ?? '—';

	async function runPreview() {
		previewing = true;
		previewError = '';
		try {
			const res = await fetch('/api/jev/preview', { method: 'POST' });
			const body = await res.json().catch(() => null);
			if (!res.ok) throw new Error(body?.error ?? 'The preview failed. Try again.');
			preview = body as PreviewResult;
			await invalidateAll(); // usage changed
		} catch (err) {
			previewError = err instanceof Error ? err.message : 'The preview failed. Try again.';
		} finally {
			previewing = false;
		}
	}
</script>

<svelte:head><title>{pageTitle({ page: 'Jev', subtitle: 'Settings' })}</title></svelte:head>

<header class="mb-6">
	<h1 class="text-xl font-semibold text-text">Jev</h1>
	<p class="text-sm text-text-tertiary mt-1">
		Inbox tabs, and Jev — TypeSafe’s decision model — sorting new mail into them for the accounts you
		allow.
	</p>
</header>

<section class="mb-10">
	<h2 class="text-sm font-semibold text-text mb-1">Inbox tabs</h2>
	<p class="text-xs text-text-tertiary mb-3">
		Splits the Inbox into four tabs. Messages stay in the Inbox — a tab only decides where you see
		them — and anything not sorted into one of the other three stays in Important. Drag a message
		onto a tab, or use <span class="text-text-secondary">Move to tab</span>, to sort it yourself.
	</p>

	<ul class="grid grid-cols-2 gap-2 mb-4">
		{#each INBOX_CATEGORIES as c (c.key)}
			<li class="flex items-start gap-2.5 px-3 py-2 rounded-lg bg-surface-hover/50 border border-border/60">
				<span class="mt-0.5 shrink-0 text-text-secondary"><Icon name={CATEGORY_ICON[c.key]} size={14} /></span>
				<span class="min-w-0">
					<span class="block text-sm text-text">{c.label}</span>
					<span class="block text-xs text-text-tertiary">{c.description}</span>
				</span>
			</li>
		{/each}
	</ul>

	{#each data.jevAccounts as account (account.id)}
		<SettingRow
			title={account.displayName ? `${account.displayName} · ${account.email}` : account.email}
			description={account.isActive
				? 'Show tabs in this account’s Inbox. This is the account you’re using now.'
				: 'Show tabs in this account’s Inbox.'}
			state={states[`${account.id}:tabs`] ?? 'idle'}
			errorMessage={errors[`${account.id}:tabs`]}
		>
			{#snippet control()}
				<Toggle
					checked={current(account, 'inboxTabs')}
					onChange={(v) => save(account.id, { inboxTabs: v }, `${account.id}:tabs`)}
				/>
			{/snippet}
		</SettingRow>
	{/each}
</section>

<section>
	<h2 class="text-sm font-semibold text-text mb-1">Letting Jev read new mail</h2>
	{#if data.jev.mode === 'live'}
		<p class="text-xs text-text-tertiary mb-3">
			Connected to TypeSafe with model <span class="font-mono text-text-secondary">{data.jev.model}</span>,
			at ${data.jev.pricePerMillion} per million input tokens (output is free).
		</p>
	{:else if data.jev.mode === 'mock'}
		<p class="text-xs text-warning mb-3">
			Mock mode (JEV_MOCK): answers are worked out on this server from the facts below, and nothing
			is sent to TypeSafe. Picks are a rule of thumb, not Jev.
		</p>
	{:else}
		<p class="text-xs text-text-tertiary mb-3">
			Not configured. Set <span class="font-mono text-text-secondary">TYPESAFE_API_KEY</span> on the
			server to let Jev sort mail.
		</p>
	{/if}

	<div class="rounded-xl border border-border bg-surface-hover/40 p-4 mb-4">
		<p class="text-sm font-medium text-text">What Jev is sent</p>
		<p class="text-xs text-text-tertiary mt-1">
			For each new email in an account you switch on: the sender, every To and Cc address, the subject,
			and the first {data.jev.excerptChars.toLocaleString()} characters of the body as text, with quoted
			replies removed. With them, facts this app works out: whether the sender is in your contacts,
			whether you’ve written to them or in the conversation, whether the email was addressed to you
			directly, its mailing-list, bulk and auto-submitted markers, whether it comes from a no-reply
			address, whether it carries a sign-in code, and where you moved this sender’s mail before. Also,
			while Telegram alerts are on, the question of whether it’s urgent. With spam checks on, for new mail: its authentication results, whether its Reply-To or
			display name points at another domain, up to five domains the body links to (read from its first
			16 KB), and Stalwart’s spam score and rule names. Jev returns only probabilities; the app keeps
			those and the facts, never the email text. TypeSafe says it doesn’t train on customer data; its
			documentation doesn’t say how long requests are kept.
		</p>
	</div>

	{#each data.jevAccounts as account (account.id)}
		{@const tabsOn = current(account, 'inboxTabs')}
		<SettingRow
			title={`Let Jev read new mail · ${account.email}`}
			description={`${tabsOn ? 'Sorts it into tabs' : 'Would sort it into tabs (they’re off)'}. Starts with mail that arrives from now on; Jev never moves mail you’ve put in a tab. ${monthLine(account.month)}`}
			state={states[`${account.id}:sort`] ?? 'idle'}
			errorMessage={errors[`${account.id}:sort`]}
		>
			{#snippet control()}
				<Toggle
					checked={current(account, 'jevEnabled')}
					disabled={!configured}
					onChange={(v) => save(account.id, { jevEnabled: v }, `${account.id}:sort`)}
				/>
			{/snippet}
		</SettingRow>
	{/each}

	<div class="mt-8">
		<h3 class="text-sm font-semibold text-text mb-1">Spam checks</h3>
		<p class="text-xs text-text-tertiary mb-1">
			A second opinion beside Stalwart’s filter, which keeps running. Jev is asked two narrow questions about
			each new email — is it spam, is it phishing — with its authentication results, its Reply-To and links,
			and Stalwart’s own score. Mail in Junk is checked too.
		</p>
		<ul class="text-xs text-text-tertiary mb-3 list-disc pl-5 space-y-0.5">
			<li><span class="text-text-secondary">Watch only</span> records Jev’s verdict and shows it beside Stalwart’s; nothing moves. Start here.</li>
			<li>
				<span class="text-text-secondary">Active</span> moves mail Jev is at least 90% sure is spam or phishing to Junk — never from
				your contacts or people you’ve written to — warns on anything from 60%, and brings mail back from Junk
				when Jev is very sure it’s fine and its sender passed DMARC. Jev’s moves don’t train Stalwart.
			</li>
		</ul>
		{#each data.jevAccounts as account (account.id)}
			<SettingRow
				title={`Spam checks · ${account.email}`}
				description={current(account, 'jevEnabled') ? 'Applies to mail that arrives from now on.' : 'Let Jev read this account’s new mail first.'}
				state={states[`${account.id}:spam`] ?? 'idle'}
				errorMessage={errors[`${account.id}:spam`]}
			>
				{#snippet control()}
					<Select
						value={spamModes[account.id] ?? account.spamMode}
						ariaLabel="Spam checks for {account.email}"
						disabled={!configured || !current(account, 'jevEnabled')}
						onchange={(v) => saveSpamMode(account.id, v)}
						options={[
							{ value: 'off', label: 'Off' },
							{ value: 'watch', label: 'Watch only' },
							{ value: 'active', label: 'Active' }
						]}
					/>
				{/snippet}
			</SettingRow>
			{#if account.isActive && account.spamMode !== 'off'}
				<JevSpamReport />
			{/if}
		{/each}
	</div>

	<div class="mt-8">
		<h3 class="text-sm font-semibold text-text mb-1">Pinned senders</h3>
		<p class="text-xs text-text-tertiary mb-3">
			Mail from a pinned sender always goes to its tab — Jev isn’t asked. Pin one from the message
			that appears after you move an email, or add it here; <span class="font-mono">@domain</span> pins
			everyone at a domain, and an address pin wins over its domain’s. Pins are applied by the same
			pass that sorts new mail, so they act while Inbox tabs and “Let Jev read new mail” are both on.
		</p>
		{#each data.jevAccounts as account (account.id)}
			{#if data.jevAccounts.length > 1}
				<p class="text-xs font-medium text-text-secondary mt-3 mb-1.5">{account.email}</p>
			{/if}
			{#if account.pins.length > 0 && !(current(account, 'inboxTabs') && current(account, 'jevEnabled'))}
				<p class="text-xs text-warning mb-1.5">
					These pins do nothing until Inbox tabs and “Let Jev read new mail” are on for {account.email}.
				</p>
			{/if}
			{#if account.pins.length > 0}
				<ul class="rounded-lg border border-border divide-y divide-border mb-2">
					{#each account.pins as pin (pin.sender)}
						<li class="flex items-center gap-3 px-3 py-2">
							<span class="flex-1 min-w-0 truncate text-sm text-text font-mono">{pin.sender}</span>
							<select
								value={pin.category}
								aria-label="Tab for {pin.sender}"
								onchange={(e) => savePin(account.id, pin.sender, e.currentTarget.value as InboxCategory)}
								class="bg-surface-hover border border-border rounded-lg px-2 py-1 text-xs text-text outline-none focus:border-accent"
							>
								{#each INBOX_CATEGORIES as c (c.key)}
									<option value={c.key}>{c.label}</option>
								{/each}
							</select>
							<button
								type="button"
								onclick={() => savePin(account.id, pin.sender, pin.category, 'DELETE')}
								title="Remove pin"
								aria-label="Remove pin for {pin.sender}"
								class="p-1 rounded-md text-text-tertiary hover:text-danger cursor-pointer"
							>
								<Icon name="close" size={14} />
							</button>
						</li>
					{/each}
				</ul>
			{/if}
			<form class="flex items-center gap-2" onsubmit={(e) => { e.preventDefault(); addPin(account.id); }}>
				<input
					bind:value={newPinSender[account.id]}
					placeholder="sender@example.com or @example.com"
					aria-label="Sender to pin"
					class="flex-1 min-w-0 bg-surface-hover border border-border rounded-lg px-2.5 py-1.5 text-sm text-text outline-none focus:border-accent"
				/>
				<select
					value={newPinTab[account.id] ?? 'updates'}
					aria-label="Tab"
					onchange={(e) => (newPinTab[account.id] = e.currentTarget.value as InboxCategory)}
					class="bg-surface-hover border border-border rounded-lg px-2 py-1.5 text-sm text-text outline-none focus:border-accent"
				>
					{#each INBOX_CATEGORIES as c (c.key)}
						<option value={c.key}>{c.label}</option>
					{/each}
				</select>
				<button
					type="submit"
					class="btn btn-secondary"
				>
					Pin
				</button>
			</form>
			{#if pinError[account.id]}
				<p class="text-xs text-danger mt-1">{pinError[account.id]}</p>
			{/if}
		{/each}
	</div>

	{#if configured && activeAccount}
		<JevBackfill accountEmail={activeAccount.email} />

		<div class="mt-4 rounded-xl border border-border p-4">
			<div class="flex items-start gap-4">
				<div class="flex-1 min-w-0">
					<p class="text-sm font-medium text-text">Try Jev on your last {data.jev.previewLimit} emails</p>
					<p class="text-xs text-text-tertiary mt-1">
						Shows where Jev would put the newest {data.jev.previewLimit} emails in
						{activeAccount.email}’s Inbox. Nothing is moved.
						{#if data.jev.mode === 'live'}
							It sends those emails to TypeSafe once, as described above.
						{/if}
					</p>
				</div>
				<button
					type="button"
					onclick={runPreview}
					disabled={previewing}
					class="btn btn-primary shrink-0"
				>
					{previewing ? 'Asking Jev…' : preview ? 'Run again' : 'Try it'}
				</button>
			</div>

			{#if previewError}
				<p class="text-xs text-danger mt-3">{previewError}</p>
			{/if}

			{#if preview}
				<div class="mt-4 grid grid-cols-4 gap-2">
					{#each INBOX_CATEGORIES as c (c.key)}
						<div class="rounded-lg bg-surface-hover/50 border border-border/60 px-3 py-2">
							<div class="flex items-center gap-1.5 text-xs text-text-secondary">
								<Icon name={CATEGORY_ICON[c.key]} size={14} />
								{c.label}
							</div>
							<div class="text-lg font-semibold text-text tabular-nums mt-0.5">{preview.counts[c.key]}</div>
						</div>
					{/each}
				</div>
				<p class="text-xs text-text-tertiary mt-2">
					{preview.total} emails judged{preview.failed > 0 ? `, ${preview.failed} couldn’t be` : ''}.
					{#if preview.mock}
						Mock answers — nothing was sent.
					{:else}
						Used {formatTokens(preview.inputTokens)} input tokens (≈ {formatCost(preview.costUsd)}).
					{/if}
					Low-confidence picks count as Important.
				</p>

				<ul class="mt-3 max-h-96 overflow-y-auto rounded-lg border border-border divide-y divide-border">
					{#each preview.rows as row (row.id)}
						<li class="flex items-center gap-3 px-3 py-2 text-xs">
							<div class="flex-1 min-w-0">
								<p class="truncate text-text">{row.subject}</p>
								<p class="truncate text-text-tertiary">{row.from}</p>
							</div>
							{#if row.error}
								<span class="shrink-0 text-danger" title={row.error}>No answer</span>
							{:else}
								<span
									class="shrink-0 inline-flex items-center gap-1 {row.tab && row.tab !== 'important' ? 'text-text' : 'text-text-secondary'}"
									title="Jev’s pick: {labelOf(row.pick)}, confidence {Math.round((row.confidence ?? 0) * 100)}%"
								>
									{#if row.tab}<Icon name={CATEGORY_ICON[row.tab]} size={12} />{/if}
									{labelOf(row.tab)}
									{#if row.pick && row.pick !== row.tab}
										<!-- Not sure enough to move it: say where Jev leaned. -->
										<span class="text-text-tertiary">· leaned {labelOf(row.pick)}, confidence {Math.round((row.confidence ?? 0) * 100)}%</span>
									{:else}
										<span class="text-text-tertiary tabular-nums">{Math.round((row.confidence ?? 0) * 100)}%</span>
									{/if}
								</span>
							{/if}
						</li>
					{/each}
				</ul>
			{/if}
		</div>
	{/if}
</section>
