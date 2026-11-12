<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import { pageTitle } from '$lib/utils/title';
	import SettingRow, { type SaveState } from '$lib/components/settings/SettingRow.svelte';
	import TextInput from '$lib/components/settings/TextInput.svelte';
	import Toggle from '$lib/components/settings/Toggle.svelte';
	import { useDraft } from '$lib/settings/draft.svelte';
	import { sendJson } from '$lib/settings/send';

	interface Account {
		id: string;
		email: string;
		isActive: boolean;
		configured: boolean;
		enabled: boolean;
		ready: boolean;
		total: number;
		indexed: number;
		lastError: string | null;
	}
	interface Overview {
		url: string | null;
		model: string | null;
		accounts: Account[];
	}

	let accounts = $state<Account[]>([]);
	let loaded = $state(false);
	const states = $state<Record<string, SaveState>>({});
	const errors = $state<Record<string, string>>({});
	let timer: ReturnType<typeof setTimeout> | null = null;

	// The endpoint and model wait for Save in the bar at the foot of the
	// page. They decide where every message's text is sent, so the server
	// asks for a fresh sign-in check first; closing that dialog saves
	// nothing and leaves what was typed in place. The per-account switches
	// below start or delete an index, and act at once.
	const draft = useDraft({
		// Filled by the first load below: this page fetches its own values.
		initial: { url: '', model: '' },
		async persist(changed) {
			const data = (await sendJson('/api/search/index', changed, { method: 'PUT', stepUp: true })) as Overview;
			showAccounts(data.accounts);
			// As the server keeps them: tidied up, or back to its own default
			// when a field was emptied.
			return { url: data.url ?? '', model: data.model ?? '' };
		}
	});

	function showAccounts(list: Account[]) {
		accounts = list;
		// Progress moves on its own while an index is being built.
		if (timer) clearTimeout(timer);
		timer = accounts.some((a) => a.enabled && !a.ready) ? setTimeout(() => load(false), 5000) : null;
	}

	/** `fields` fills the endpoint and model; the progress refresh leaves them, in case one is being typed in. */
	async function load(fields: boolean) {
		const res = await fetch('/api/search/index').catch(() => null);
		if (!res?.ok) return;
		const data = (await res.json()) as Overview;
		if (fields) draft.seed({ url: data.url ?? '', model: data.model ?? '' });
		showAccounts(data.accounts);
		loaded = true;
	}

	async function toggle(account: Account, enabled: boolean) {
		states[account.id] = 'saving';
		delete errors[account.id];
		try {
			const res = await fetch('/api/search/index', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ accountId: account.id, enabled })
			});
			if (!res.ok) {
				const body = await res.json().catch(() => null);
				throw new Error(body?.error ?? 'Couldn’t save. Try again.');
			}
			states[account.id] = 'idle';
		} catch (err) {
			errors[account.id] = err instanceof Error ? err.message : 'Couldn’t save. Try again.';
			states[account.id] = 'error';
		}
		await load(false);
	}

	function progress(a: Account): string {
		if (!a.enabled) return '';
		if (a.ready) return 'Ready';
		if (a.total === 0) return 'Starting…';
		return `${a.indexed.toLocaleString()} / ${a.total.toLocaleString()}`;
	}

	onMount(() => load(true));
	onDestroy(() => timer && clearTimeout(timer));
</script>

<svelte:head><title>{pageTitle({ page: 'Search', subtitle: 'Settings' })}</title></svelte:head>

<header class="mb-6">
	<h1 class="text-xl font-semibold text-text">Search</h1>
</header>

{#if loaded}
	<section class="mb-8">
		<h2 class="text-sm font-medium text-text mb-1">Semantic search</h2>
		<SettingRow
			title="Ollama endpoint"
			description="Reached from the server, not your browser. It receives the text of every message it indexes."
		>
			{#snippet control()}
				<TextInput bind:value={draft.value.url} ariaLabel="Ollama endpoint" width="260px" />
			{/snippet}
		</SettingRow>
		<SettingRow title="Model">
			{#snippet control()}
				<TextInput bind:value={draft.value.model} ariaLabel="Model" width="260px" />
			{/snippet}
		</SettingRow>
		{#each accounts as account (account.id)}
			<SettingRow
				title={account.email}
				state={states[account.id] === 'error' || (account.enabled && account.lastError) ? 'error' : (states[account.id] ?? 'idle')}
				errorMessage={errors[account.id] ?? account.lastError ?? undefined}
			>
				{#snippet control()}
					<!-- An error doesn't stop the indexer: it tries again every minute. -->
					<span class="text-xs text-text-tertiary tabular-nums">{progress(account)}{account.lastError ? ' · retrying' : ''}</span>
					<Toggle
						checked={account.enabled}
						disabled={!account.configured || states[account.id] === 'saving'}
						ariaLabel="Index {account.email}"
						onChange={(next) => toggle(account, next)}
					/>
				{/snippet}
			</SettingRow>
		{/each}
	</section>
{/if}
