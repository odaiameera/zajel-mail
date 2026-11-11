<script lang="ts">
	import { onDestroy, onMount } from 'svelte';

	/**
	 * "Sort the mail already in your Inbox": how much is unsorted and what it
	 * would cost, then progress while the new-mail pass judges it in the background.
	 */
	let { accountEmail }: { accountEmail: string } = $props();

	interface Progress {
		pending: number;
		done: number;
		failed: number;
		skipped: number;
	}
	interface Status {
		ready: boolean;
		mock: boolean;
		unsorted: number;
		estimate: { inputTokens: number; costUsd: number };
		progress: Progress;
	}

	let status = $state<Status | null>(null);
	let busy = $state(false);
	let error = $state('');
	let timer: ReturnType<typeof setTimeout> | undefined;

	const running = $derived((status?.progress.pending ?? 0) > 0);
	const handled = $derived(status ? status.progress.done + status.progress.failed : 0);
	const total = $derived(status ? handled + status.progress.pending : 0);

	/** The full picture: what's unsorted, the estimate, and progress. */
	async function load() {
		const res = await fetch('/api/jev/backfill').catch(() => null);
		if (res?.ok) status = await res.json();
		schedulePoll();
	}

	/** While a run goes, read progress alone; count again once it's over. */
	function schedulePoll() {
		clearTimeout(timer);
		if ((status?.progress.pending ?? 0) === 0) return;
		timer = setTimeout(async () => {
			const res = await fetch('/api/jev/backfill?progress=1').catch(() => null);
			const body = res?.ok ? await res.json() : null;
			if (body && status) status = { ...status, progress: body.progress };
			if ((status?.progress.pending ?? 0) > 0) schedulePoll();
			else await load();
		}, 4000);
	}

	async function act(method: 'POST' | 'DELETE') {
		busy = true;
		error = '';
		try {
			const res = await fetch('/api/jev/backfill', { method });
			const body = await res.json().catch(() => null);
			if (!res.ok) throw new Error(body?.error ?? 'That didn’t work. Try again.');
			await load();
		} catch (err) {
			error = err instanceof Error ? err.message : 'That didn’t work. Try again.';
		} finally {
			busy = false;
		}
	}

	function formatTokens(n: number): string {
		if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
		if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
		return String(n);
	}
	const formatCost = (usd: number) => (usd < 0.01 ? 'under $0.01' : `about $${usd.toFixed(2)}`);

	onMount(load);
	onDestroy(() => clearTimeout(timer));
</script>

<div class="mt-4 rounded-xl border border-border p-4">
	<div class="flex items-start gap-4">
		<div class="flex-1 min-w-0">
			<p class="text-sm font-medium text-text">Sort the mail already in your Inbox</p>
			{#if !status}
				<p class="text-xs text-text-tertiary mt-1">Counting…</p>
			{:else if running}
				<p class="text-xs text-text-tertiary mt-1">
					Sorting {accountEmail}’s Inbox in the background — {handled.toLocaleString()} of
					{total.toLocaleString()} so far. It goes faster while the app is open.
				</p>
			{:else}
				<p class="text-xs text-text-tertiary mt-1">
					{#if status.unsorted === 0}
						Nothing left in Important to sort.
					{:else}
						{status.unsorted.toLocaleString()} emails in {accountEmail}’s Important tab haven’t been
						sorted. Jev judges each once, for its tab only — your rules don’t run on old mail, and
						your pins still apply.
						{#if status.mock}
							Mock answers — nothing is sent.
						{:else}
							That sends them to TypeSafe once: ≈ {formatTokens(status.estimate.inputTokens)} tokens,
							{formatCost(status.estimate.costUsd)}.
						{/if}
					{/if}
					{#if status.progress.done > 0}
						Sorted so far: {status.progress.done.toLocaleString()}.
					{/if}
				</p>
			{/if}
			{#if status && !status.ready}
				<p class="text-xs text-warning mt-1">Turn on Inbox tabs and “Let Jev read new mail” first.</p>
			{/if}
		</div>
		{#if running}
			<button
				type="button"
				onclick={() => act('DELETE')}
				disabled={busy}
				class="btn btn-secondary shrink-0"
			>
				Cancel
			</button>
		{:else}
			<button
				type="button"
				onclick={() => act('POST')}
				disabled={busy || !status?.ready || !status?.unsorted}
				class="btn btn-primary shrink-0"
			>
				{busy ? 'Starting…' : status?.unsorted ? `Sort ${status.unsorted.toLocaleString()} emails` : 'Sort'}
			</button>
		{/if}
	</div>
	{#if running && total > 0}
		<div class="mt-3 h-1.5 bg-surface-hover rounded-full overflow-hidden">
			<div class="h-full bg-accent transition-all duration-500" style="width: {Math.round((handled / total) * 100)}%"></div>
		</div>
	{/if}
	{#if error}
		<p class="text-xs text-danger mt-2">{error}</p>
	{/if}
</div>
