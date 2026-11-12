<script lang="ts">
	import Icon from '$lib/components/Icon.svelte';
	import { onMount } from 'svelte';
	import { fade, fly } from 'svelte/transition';
	import { invalidateAll } from '$app/navigation';
	import { IDLE_PROGRESS, streamApply, type ApplyProgress } from '$lib/rules/apply';
	import type { Rule } from '$lib/types/rules';
	import { trapFocus } from '$lib/utils/trap-focus';

	/**
	 * "Save & apply": the saved rule run over the Inbox now, with its
	 * progress, Cancel, and "Run in background", which closes this and lets
	 * the run finish. Opens running; `onClose` when it is closed.
	 */
	let { rule, onClose }: { rule: Rule; onClose: () => void } = $props();

	let progress = $state<ApplyProgress>(IDLE_PROGRESS);
	let abortCtrl: AbortController | null = null;

	async function run() {
		abortCtrl = new AbortController();
		try {
			await streamApply(rule.id, (p) => (progress = p), abortCtrl.signal);
		} finally {
			abortCtrl = null;
			// Refresh mailboxes so unread counts reflect mark-read actions etc.
			invalidateAll();
		}
	}

	onMount(() => {
		run();
	});

	function closeOrCancel() {
		if (progress.status === 'running' && abortCtrl) abortCtrl.abort();
		onClose();
	}

	const progressPercent = $derived(
		progress.total > 0 ? Math.min(100, Math.round((progress.scanned / progress.total) * 100)) : 0
	);
</script>

<div class="fixed inset-0 z-[80] flex items-center justify-center bg-black/50" transition:fade={{ duration: 150 }}>
	<div
		class="w-full max-w-[420px] mx-4 bg-surface border border-border rounded-2xl p-5 shadow-[0_16px_64px_rgba(0,0,0,0.5)] outline-none"
		role="dialog"
		aria-modal="true"
		aria-labelledby="rule-apply-title"
		tabindex="-1"
		use:trapFocus
		transition:fly={{ y: 16, duration: 200 }}
	>
		<div class="flex items-center gap-2 mb-3">
			{#if progress.status === 'done'}
				<Icon name="check" size={16} class="text-success" />
				<h2 id="rule-apply-title" class="text-sm font-semibold text-text">Applied</h2>
			{:else if progress.status === 'error'}
				<Icon name="error" size={16} class="text-danger" />
				<h2 id="rule-apply-title" class="text-sm font-semibold text-text">Failed</h2>
			{:else}
				<span class="w-3 h-3 rounded-full border-2 border-accent/40 border-t-accent animate-spin"></span>
				<h2 id="rule-apply-title" class="text-sm font-semibold text-text">Applying rule…</h2>
			{/if}
		</div>

		<div class="h-1.5 bg-surface-hover rounded-full overflow-hidden mb-3">
			<div
				class="h-full bg-accent transition-all duration-300 ease-out"
				style="width: {progress.status === 'done' ? 100 : progressPercent}%;"
			></div>
		</div>

		<div class="flex items-baseline flex-wrap gap-x-3 gap-y-1 text-xs text-text-secondary mb-4">
			<span>Scanned <span class="text-text font-medium tabular-nums">{progress.scanned.toLocaleString()}</span></span>
			<span class="text-text-tertiary">·</span>
			<span>Matched <span class="text-text font-medium tabular-nums">{progress.matched.toLocaleString()}</span></span>
			<span class="text-text-tertiary">·</span>
			<span>Applied <span class="text-text font-medium tabular-nums">{progress.applied.toLocaleString()}</span></span>
			{#if progress.total > 0}
				<span class="text-text-tertiary ml-auto">of {progress.total.toLocaleString()}</span>
			{/if}
		</div>

		{#if progress.status === 'error' && progress.error}
			<p class="px-3 py-2 rounded-lg bg-danger/10 border border-danger/20 text-danger text-xs mb-4">
				{progress.error}
			</p>
		{/if}

		<div class="flex items-center gap-2 justify-end">
			{#if progress.status === 'running' || progress.status === 'idle'}
				<button
					onclick={onClose}
					class="text-xs text-text-tertiary hover:text-text px-3 py-1.5 rounded-lg transition-colors cursor-pointer"
				>
					Run in background
				</button>
				<button onclick={closeOrCancel} class="btn btn-danger btn-sm">Cancel</button>
			{:else if progress.status === 'error'}
				<button
					onclick={closeOrCancel}
					class="text-xs text-text-tertiary hover:text-text px-3 py-1.5 rounded-lg transition-colors cursor-pointer"
				>
					Close
				</button>
				<button onclick={run} class="btn btn-primary btn-sm">Retry</button>
			{:else}
				<button onclick={closeOrCancel} class="btn btn-primary btn-sm">Done</button>
			{/if}
		</div>
	</div>
</div>
