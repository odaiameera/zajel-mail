<script lang="ts">
	import { onMount } from 'svelte';
	import { pageTitle } from '$lib/utils/title';
	import SettingRow from '$lib/components/settings/SettingRow.svelte';
	import Toggle from '$lib/components/settings/Toggle.svelte';

	interface Job {
		id: string;
		title: string;
		what: string;
		when: string;
		enabled: boolean;
		nextRunAt: string | null;
		lastRunAt: string | null;
		lastResult: string | null;
	}
	interface Activity {
		tool: string;
		tier: string;
		summary: string;
		outcome: string;
		source: string;
		createdAt: string;
	}

	let paused = $state(false);
	let jobs = $state<Job[]>([]);
	let activity = $state<Activity[]>([]);
	let loaded = $state(false);

	async function load() {
		const res = await fetch('/api/agent');
		if (!res.ok) return;
		const data = await res.json();
		paused = data.paused;
		jobs = data.jobs;
		activity = data.activity;
		loaded = true;
	}

	async function patch(body: Record<string, unknown>) {
		await fetch('/api/agent', {
			method: 'PATCH',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(body)
		});
		await load();
	}

	async function remove(id: string) {
		await fetch(`/api/agent?id=${encodeURIComponent(id)}`, { method: 'DELETE' });
		await load();
	}

	function when(iso: string): string {
		const t = new Date(iso.includes('T') ? iso : iso.replace(' ', 'T') + 'Z');
		return t.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
	}

	const SOURCE: Record<string, string> = { chat: 'Chat', telegram: 'Telegram', job: 'Job' };

	onMount(load);
</script>

<svelte:head><title>{pageTitle({ page: 'Agent', subtitle: 'Settings' })}</title></svelte:head>

<header class="mb-6">
	<h1 class="text-xl font-semibold text-text">Agent</h1>
</header>

<section class="mb-8">
	<h2 class="text-sm font-medium text-text mb-1">Scheduled jobs</h2>
	<SettingRow title="Pause all jobs">
		{#snippet control()}
			<Toggle checked={paused} onChange={(next) => patch({ paused: next })} />
		{/snippet}
	</SettingRow>

	{#if loaded && jobs.length === 0}
		<p class="text-xs text-text-tertiary py-3">No jobs</p>
	{/if}
	{#each jobs as job (job.id)}
		<div class="flex items-start gap-3 py-3 border-b border-border last:border-b-0">
			<div class="flex-1 min-w-0">
				<p class="text-sm text-text truncate">{job.title}</p>
				<p class="text-xs text-text-tertiary mt-0.5">{job.when}</p>
				<p class="text-xs text-text-tertiary">{job.what}</p>
				{#if job.lastRunAt}
					<p class="text-xs text-text-tertiary mt-0.5">Last run {when(job.lastRunAt)}{job.lastResult ? ` · ${job.lastResult}` : ''}</p>
				{/if}
			</div>
			<Toggle checked={job.enabled} onChange={(next) => patch({ id: job.id, enabled: next })} />
			<button type="button" onclick={() => remove(job.id)}
				class="px-2.5 py-1.5 text-xs text-text-tertiary hover:text-danger transition-colors cursor-pointer">Delete</button>
		</div>
	{/each}
</section>

<section>
	<h2 class="text-sm font-medium text-text mb-3">Activity</h2>
	{#if loaded && activity.length === 0}
		<p class="text-xs text-text-tertiary">Nothing yet</p>
	{/if}
	{#each activity as entry, i (i)}
		<div class="flex items-start gap-3 py-2 border-b border-border last:border-b-0">
			<span class="text-3xs uppercase tracking-wide text-text-tertiary w-16 shrink-0 pt-0.5">{SOURCE[entry.source] ?? entry.source}</span>
			<p class="text-xs text-text flex-1 min-w-0 {entry.outcome === 'failed' ? 'text-danger' : ''}">{entry.summary}</p>
			<span class="text-3xs text-text-tertiary shrink-0">{when(entry.createdAt)}</span>
		</div>
	{/each}
</section>
