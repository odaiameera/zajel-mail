<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import { pageTitle } from '$lib/utils/title';
	import { fetchWithStepUp } from '$lib/auth/step-up';
	import SettingRow, { type SaveState } from '$lib/components/settings/SettingRow.svelte';
	import TextInput from '$lib/components/settings/TextInput.svelte';
	import Toggle from '$lib/components/settings/Toggle.svelte';

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

	let url = $state('');
	let model = $state('');
	let accounts = $state<Account[]>([]);
	let loaded = $state(false);
	const states = $state<Record<string, SaveState>>({});
	const errors = $state<Record<string, string>>({});
	let timer: ReturnType<typeof setTimeout> | null = null;

	/** The values last loaded, so an unchanged field isn't saved again on blur. */
	let saved = { url: '', model: '' };

	/** `fields` refills the endpoint and model; the progress refresh leaves them, in case one is being typed in. */
	function apply(data: { url: string | null; model: string | null; accounts: Account[] }, fields: boolean) {
		if (fields) {
			saved = { url: data.url ?? '', model: data.model ?? '' };
			url = saved.url;
			model = saved.model;
		}
		accounts = data.accounts;
		loaded = true;
		// Progress moves on its own while an index is being built.
		if (timer) clearTimeout(timer);
		timer = accounts.some((a) => a.enabled && !a.ready) ? setTimeout(() => load(false), 5000) : null;
	}

	async function load(fields: boolean) {
		const res = await fetch('/api/search/index').catch(() => null);
		if (res?.ok) apply(await res.json(), fields);
	}

	async function saveSetting(key: 'url' | 'model', value: string) {
		if (value.trim() === saved[key]) return;
		states[key] = 'saving';
		delete errors[key];
		const res = await fetchWithStepUp('/api/search/index', {
			method: 'PUT',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ [key]: value })
		}).catch(() => null);
		const data = await res?.json().catch(() => null);
		if (!res?.ok) {
			// A cancelled re-check leaves things as they were.
			if (data?.stepUp) states[key] = 'idle';
			else {
				errors[key] = data?.message ?? data?.error ?? 'That didn’t save';
				states[key] = 'error';
			}
			if (key === 'url') url = saved.url;
			else model = saved.model;
			return;
		}
		apply(data, true);
		states[key] = 'saved';
		setTimeout(() => { if (states[key] === 'saved') states[key] = 'idle'; }, 1800);
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
		<SettingRow title="Ollama endpoint" state={states.url ?? 'idle'} errorMessage={errors.url}>
			{#snippet control()}
				<TextInput bind:value={url} ariaLabel="Ollama endpoint" width="260px" onSave={(next) => saveSetting('url', next)} />
			{/snippet}
		</SettingRow>
		<SettingRow title="Model" state={states.model ?? 'idle'} errorMessage={errors.model}>
			{#snippet control()}
				<TextInput bind:value={model} ariaLabel="Model" width="260px" onSave={(next) => saveSetting('model', next)} />
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
						onChange={(next) => toggle(account, next)}
					/>
				{/snippet}
			</SettingRow>
		{/each}
	</section>
{/if}
