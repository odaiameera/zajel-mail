<script lang="ts">
	import { onMount } from 'svelte';
	import { pageTitle } from '$lib/utils/title';
	import SettingRow from '$lib/components/settings/SettingRow.svelte';
	import Select from '$lib/components/settings/Select.svelte';
	import Toggle from '$lib/components/settings/Toggle.svelte';
	import { fetchWithStepUp } from '$lib/auth/step-up';

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
	type Provider = 'anthropic' | 'openai' | 'ollama';
	interface Assistant {
		provider: Provider | null;
		available: Provider[];
		agentModel: string | null;
		writerModel: string | null;
		agentEffort: 'low' | 'medium' | 'high' | null;
	}
	type SaveState = 'idle' | 'saving' | 'saved' | 'error';
	interface Activity {
		tool: string;
		tier: string;
		summary: string;
		outcome: string;
		source: string;
		createdAt: string;
	}

	let assistant = $state<Assistant | null>(null);
	let models = $state<{ id: string; name: string }[]>([]);
	// Which setting is saving, so its own row shows it.
	let saving = $state<{ key: string; state: SaveState; error?: string } | null>(null);
	// Bumped when a save doesn't happen, so the pickers redraw with the saved
	// values instead of keeping the one that was picked.
	let pickers = $state(0);
	let modelsFor: Provider | null = null;
	let checking = $state(false);
	let check = $state<{ ok: boolean; error?: string } | null>(null);
	let paused = $state(false);
	let jobs = $state<Job[]>([]);
	let activity = $state<Activity[]>([]);
	let loaded = $state(false);

	async function load() {
		const res = await fetch('/api/agent');
		if (!res.ok) return;
		const data = await res.json();
		const providerChanged = data.assistant?.provider !== assistant?.provider;
		assistant = data.assistant;
		if (providerChanged && assistant?.provider) void loadModels(assistant.provider);
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

	async function loadModels(provider: Provider) {
		// The old provider's models must never be offered for the new one.
		models = [];
		modelsFor = provider;
		const res = await fetch(`/api/agent/models?provider=${provider}`).catch(() => null);
		const list = res?.ok ? (await res.json()).models : [];
		if (modelsFor === provider) models = list;
	}

	async function save(key: string, value: string) {
		saving = { key, state: 'saving' };
		let res: Response;
		let data: { stepUp?: boolean; message?: string; error?: string } & Assistant;
		try {
			res = await fetchWithStepUp('/api/agent/assistant', {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ [key]: value })
			});
			data = await res.json().catch(() => null);
		} catch {
			saving = { key, state: 'error', error: 'That didn’t save' };
			pickers += 1;
			return;
		}
		if (!res.ok) {
			// A cancelled re-check leaves things as they were.
			saving = data?.stepUp ? null : { key, state: 'error', error: data?.message ?? data?.error ?? 'That didn’t save' };
			pickers += 1;
			return;
		}
		const providerChanged = data.provider !== assistant?.provider;
		assistant = data;
		check = null;
		saving = { key, state: 'saved' };
		if (providerChanged && data.provider) await loadModels(data.provider);
	}

	const rowState = (key: string): SaveState => (saving?.key === key ? saving.state : 'idle');

	/** The listed models, with the one in use first if the list doesn't have it. */
	function modelOptions(current: string | null): { value: string; label: string }[] {
		const options = models.map((m) => ({ value: m.id, label: m.name }));
		if (current && !options.some((o) => o.value === current)) options.unshift({ value: current, label: modelName(current) });
		return options;
	}

	const EFFORTS = [
		{ value: 'low', label: 'Low' },
		{ value: 'medium', label: 'Medium' },
		{ value: 'high', label: 'High' }
	];

	async function runCheck() {
		checking = true;
		check = null;
		try {
			const res = await fetch('/api/agent/check', { method: 'POST' });
			check = res.ok ? await res.json() : { ok: false, error: `Check failed (${res.status})` };
		} catch {
			check = { ok: false, error: 'Check failed' };
		} finally {
			checking = false;
		}
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
	const PROVIDER: Record<string, string> = { anthropic: 'Claude', openai: 'OpenAI', ollama: 'Ollama' };

	/** claude-opus-5-5 → Claude Opus 5.5; other ids as they are. */
	function modelName(id: string): string {
		const m = /^claude-([a-z]+)-(\d+)(?:-(\d+))?$/.exec(id);
		if (!m) return id;
		return `Claude ${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}${m[3] ? `.${m[3]}` : ''}`;
	}

	onMount(load);
</script>

<svelte:head><title>{pageTitle({ page: 'Agent', subtitle: 'Settings' })}</title></svelte:head>

<header class="mb-6">
	<h1 class="text-xl font-semibold text-text">Agent</h1>
</header>

{#if assistant}
	<section class="mb-8">
		<h2 class="text-sm font-medium text-text mb-1">Assistant</h2>
		{#if !assistant.available.length}
			<SettingRow title="Provider">
				{#snippet control()}
					<span class="text-sm text-text-secondary">Off</span>
				{/snippet}
			</SettingRow>
		{:else}
		{#key pickers}
			<SettingRow title="Provider" state={rowState('provider')} errorMessage={saving?.error}>
				{#snippet control()}
					<Select
						ariaLabel="Provider"
						value={assistant?.provider ?? ''}
						options={[
							...(assistant?.provider ? [] : [{ value: '', label: 'Off' }]),
							...(assistant?.available ?? []).map((p) => ({ value: p, label: PROVIDER[p] }))
						]}
						onchange={(next) => save('provider', next)}
					/>
				{/snippet}
			</SettingRow>
			{#if assistant.provider === 'anthropic'}
				<SettingRow title="Agent model" state={rowState('agentModel')} errorMessage={saving?.error}>
					{#snippet control()}
						<Select ariaLabel="Agent model" value={assistant?.agentModel ?? ''} options={modelOptions(assistant?.agentModel ?? null)} onchange={(next) => save('agentModel', next)} />
					{/snippet}
				</SettingRow>
				<SettingRow title="Writing model" state={rowState('writerModel')} errorMessage={saving?.error}>
					{#snippet control()}
						<Select ariaLabel="Writing model" value={assistant?.writerModel ?? ''} options={modelOptions(assistant?.writerModel ?? null)} onchange={(next) => save('writerModel', next)} />
					{/snippet}
				</SettingRow>
				<SettingRow title="Agent effort" state={rowState('agentEffort')} errorMessage={saving?.error}>
					{#snippet control()}
						<Select ariaLabel="Agent effort" value={assistant?.agentEffort ?? 'medium'} options={EFFORTS} onchange={(next) => save('agentEffort', next)} />
					{/snippet}
				</SettingRow>
			{:else if assistant.provider}
				<SettingRow title="Model" state={rowState('model')} errorMessage={saving?.error}>
					{#snippet control()}
						<Select ariaLabel="Model" value={assistant?.agentModel ?? ''} options={modelOptions(assistant?.agentModel ?? null)} onchange={(next) => save('model', next)} />
					{/snippet}
				</SettingRow>
			{/if}
		{/key}
			<SettingRow title="Connection" state={check && !check.ok ? 'error' : 'idle'} errorMessage={check?.error}>
				{#snippet control()}
					{#if check?.ok}
						<span class="text-xs text-success">Working</span>
					{/if}
					<button type="button" class="btn btn-secondary btn-sm" disabled={checking} onclick={runCheck}>
						{checking ? 'Checking…' : 'Check'}
					</button>
				{/snippet}
			</SettingRow>
		{/if}
	</section>
{/if}

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
