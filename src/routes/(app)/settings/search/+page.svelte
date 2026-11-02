<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import { pageTitle } from '$lib/utils/title';
	import SettingRow, { type SaveState } from '$lib/components/settings/SettingRow.svelte';
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

	let model = $state<string | null>(null);
	let accounts = $state<Account[]>([]);
	let loaded = $state(false);
	const states = $state<Record<string, SaveState>>({});
	const errors = $state<Record<string, string>>({});
	let timer: ReturnType<typeof setTimeout> | null = null;

	async function load() {
		const res = await fetch('/api/search/index').catch(() => null);
		if (res?.ok) {
			const data = await res.json();
			model = data.model;
			accounts = data.accounts;
			loaded = true;
		}
		// Progress moves on its own while an index is being built.
		if (timer) clearTimeout(timer);
		timer = accounts.some((a) => a.enabled && !a.ready) ? setTimeout(load, 5000) : null;
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
		await load();
	}

	function progress(a: Account): string {
		if (!a.enabled) return '';
		if (a.ready) return 'Ready';
		if (a.total === 0) return 'Starting…';
		return `${a.indexed.toLocaleString()} / ${a.total.toLocaleString()}`;
	}

	onMount(load);
	onDestroy(() => timer && clearTimeout(timer));
</script>

<svelte:head><title>{pageTitle({ page: 'Search', subtitle: 'Settings' })}</title></svelte:head>

<header class="mb-6">
	<h1 class="text-xl font-semibold text-text">Search</h1>
</header>

{#if loaded}
	<section class="mb-8">
		<h2 class="text-sm font-medium text-text mb-1">Semantic search</h2>
		<SettingRow title="Model">
			{#snippet control()}
				<span class="text-sm text-text-secondary">{model ?? 'Not set'}</span>
			{/snippet}
		</SettingRow>
		{#each accounts as account (account.id)}
			<SettingRow
				title={account.email}
				state={states[account.id] === 'error' || (account.enabled && account.lastError) ? 'error' : (states[account.id] ?? 'idle')}
				errorMessage={errors[account.id] ?? account.lastError ?? undefined}
			>
				{#snippet control()}
					<span class="text-xs text-text-tertiary tabular-nums">{account.lastError && account.enabled ? 'Paused' : progress(account)}</span>
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
