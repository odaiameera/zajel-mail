<script lang="ts">
	import { onMount } from 'svelte';
	import { pageTitle } from '$lib/utils/title';
	import PageHeader from '$lib/components/settings/PageHeader.svelte';
	import Section from '$lib/components/settings/Section.svelte';
	import RowMenu from '$lib/components/settings/RowMenu.svelte';
	import SearchSection from './SearchSection.svelte';
	import SettingRow from '$lib/components/settings/SettingRow.svelte';
	import Select from '$lib/components/settings/Select.svelte';
	import Toggle from '$lib/components/settings/Toggle.svelte';
	import { useDraft } from '$lib/settings/draft.svelte';
	import { sendJson } from '$lib/settings/send';

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
	let modelsFor: Provider | null = null;
	let checking = $state(false);
	let check = $state<{ ok: boolean; error?: string } | null>(null);
	let paused = $state(false);
	let jobs = $state<Job[]>([]);
	let activity = $state<Activity[]>([]);
	let loaded = $state(false);

	type Choice = { provider: string; agentModel: string; writerModel: string; agentEffort: string };

	/** The saved choice as the pickers hold it: '' for nothing chosen, and the effort a provider without one of its own starts from. */
	function choiceOf(a: Assistant | null): Choice {
		return {
			provider: a?.provider ?? '',
			agentModel: a?.agentModel ?? '',
			writerModel: a?.writerModel ?? '',
			agentEffort: a?.agentEffort ?? 'medium'
		};
	}

	// The provider, its models and the effort wait for Save in the bar at the
	// foot of the page. The provider decides where mail content is sent, so
	// the server asks for a fresh sign-in check first; closing that dialog
	// saves nothing and leaves the pickers as they were set. Jobs and the
	// connection check below act at once.
	const draft = useDraft<Choice>({
		// Filled by the first load below: this page fetches its own values.
		initial: choiceOf(null),
		async persist(changed, all) {
			let body: Record<string, string>;
			if (changed.provider !== undefined) {
				// A new provider is saved on its own. Its models are only known
				// (and offered) once it is the one in use.
				body = { provider: changed.provider };
			} else if (all.provider === 'anthropic') {
				body = { ...changed };
			} else {
				// OpenAI and Ollama use one model for everything, sent as `model`.
				body = changed.agentModel !== undefined ? { model: changed.agentModel } : {};
			}
			const data = (await sendJson('/api/agent/assistant', body, { method: 'PUT', stepUp: true })) as Assistant;
			const providerChanged = data.provider !== assistant?.provider;
			assistant = data;
			// The last check was of the old setup.
			check = null;
			if (providerChanged && data.provider) void loadModels(data.provider);
			return choiceOf(data);
		}
	});

	// Whether the provider picked is the one in use. A different one hasn't
	// been saved yet, so there are no models of its own to choose from.
	const providerSaved = $derived(draft.value.provider === draft.baseline.provider);

	function pickProvider(next: string) {
		draft.value.provider = next;
		// Model choices belong to the provider they were made for.
		draft.value.agentModel = draft.baseline.agentModel;
		draft.value.writerModel = draft.baseline.writerModel;
		draft.value.agentEffort = draft.baseline.agentEffort;
	}

	let seeded = false;

	async function load() {
		const res = await fetch('/api/agent');
		if (!res.ok) return;
		const data = await res.json();
		const providerChanged = data.assistant?.provider !== assistant?.provider;
		assistant = data.assistant;
		// The pickers are filled once. This also runs after every job change,
		// and must not put back a choice that is waiting for Save.
		if (!seeded) {
			seeded = true;
			draft.seed(choiceOf(assistant));
		}
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

	/** The listed models, with the one in use (`current`) first if the list doesn't have it. */
	function modelOptions(current: string): { value: string; label: string }[] {
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

<svelte:head><title>{pageTitle({ page: 'Assistant', subtitle: 'Settings' })}</title></svelte:head>

<PageHeader title="Assistant" />

{#if assistant}
	<Section title="Provider and model" id="assistant">
		{#if !assistant.available.length}
			<SettingRow title="Provider">
				{#snippet control()}
					<span class="text-sm text-text-secondary">Off</span>
				{/snippet}
			</SettingRow>
		{:else}
			<SettingRow
				title="Provider"
				description={providerSaved ? undefined : `Save to switch to ${PROVIDER[draft.value.provider] ?? draft.value.provider}. Its models can be chosen once it is the one in use.`}
			>
				{#snippet control()}
					<Select
						ariaLabel="Provider"
						value={draft.value.provider}
						options={[
							...(draft.baseline.provider ? [] : [{ value: '', label: 'Off' }]),
							...(assistant?.available ?? []).map((p) => ({ value: p, label: PROVIDER[p] }))
						]}
						onchange={pickProvider}
					/>
				{/snippet}
			</SettingRow>
			<!-- The model rows are for the provider in use; a provider picked but
			     not yet saved has none to show (see pickProvider). -->
			{#if providerSaved && draft.baseline.provider === 'anthropic'}
				<SettingRow title="Agent model">
					{#snippet control()}
						<Select ariaLabel="Agent model" value={draft.value.agentModel} options={modelOptions(draft.baseline.agentModel)} onchange={(next) => (draft.value.agentModel = next)} />
					{/snippet}
				</SettingRow>
				<SettingRow title="Writing model">
					{#snippet control()}
						<Select ariaLabel="Writing model" value={draft.value.writerModel} options={modelOptions(draft.baseline.writerModel)} onchange={(next) => (draft.value.writerModel = next)} />
					{/snippet}
				</SettingRow>
				<SettingRow title="Agent effort">
					{#snippet control()}
						<Select ariaLabel="Agent effort" value={draft.value.agentEffort} options={EFFORTS} onchange={(next) => (draft.value.agentEffort = next)} />
					{/snippet}
				</SettingRow>
			{:else if providerSaved && draft.baseline.provider}
				<SettingRow title="Model">
					{#snippet control()}
						<Select ariaLabel="Model" value={draft.value.agentModel} options={modelOptions(draft.baseline.agentModel)} onchange={(next) => (draft.value.agentModel = next)} />
					{/snippet}
				</SettingRow>
			{/if}
			<SettingRow title="Connection" state={check && !check.ok ? 'error' : 'idle'} errorMessage={check?.error}>
				{#snippet control()}
					{#if check?.ok}
						<span class="text-[0.8125rem] text-success">Working</span>
					{/if}
					<button type="button" class="btn btn-secondary btn-sm" disabled={checking} onclick={runCheck}>
						{checking ? 'Checking…' : 'Check'}
					</button>
				{/snippet}
			</SettingRow>
		{/if}
	</Section>
{/if}

<Section title="Scheduled jobs" id="jobs">
	<SettingRow title="Pause all jobs">
		{#snippet control()}
			<Toggle checked={paused} ariaLabel="Pause all jobs" onChange={(next) => patch({ paused: next })} />
		{/snippet}
	</SettingRow>

	{#if loaded && jobs.length === 0}
		<p class="px-5 max-md:px-4 py-4 text-sm text-text-tertiary">No jobs</p>
	{/if}
	{#each jobs as job (job.id)}
		<div class="flex items-center gap-3 min-h-14 pl-5 pr-3 max-md:pl-4 max-md:pr-2 py-2.5">
			<div class="flex-1 min-w-0">
				<p class="text-sm font-medium text-text truncate">{job.title}</p>
				<p class="text-[0.8125rem] text-text-tertiary mt-0.5">{job.when} · {job.what}</p>
				{#if job.lastRunAt}
					<p class="text-[0.8125rem] text-text-tertiary">Last run {when(job.lastRunAt)}{job.lastResult ? ` · ${job.lastResult}` : ''}</p>
				{/if}
			</div>
			<Toggle checked={job.enabled} ariaLabel="Run {job.title}" onChange={(next) => patch({ id: job.id, enabled: next })} />
			<RowMenu ariaLabel="{job.title} options" items={[{ label: 'Delete', danger: true, onSelect: () => remove(job.id) }]} />
		</div>
	{/each}
</Section>

<SearchSection />

<Section title="Activity" id="activity">
	{#if loaded && activity.length === 0}
		<p class="px-5 max-md:px-4 py-4 text-sm text-text-tertiary">Nothing yet</p>
	{/if}
	{#each activity as entry, i (i)}
		<div class="flex items-baseline gap-3 px-5 max-md:px-4 py-2.5 text-[0.8125rem]">
			<span class="text-text-tertiary w-16 shrink-0">{SOURCE[entry.source] ?? entry.source}</span>
			<p class="flex-1 min-w-0 {entry.outcome === 'failed' ? 'text-danger' : 'text-text'}">{entry.summary}</p>
			<span class="text-text-tertiary shrink-0">{when(entry.createdAt)}</span>
		</div>
	{/each}
</Section>
