<script lang="ts">
	import { pageTitle } from '$lib/utils/title';
	import { invalidateAll } from '$app/navigation';
	import SettingRow, { type SaveState } from '$lib/components/settings/SettingRow.svelte';
	import Toggle from '$lib/components/settings/Toggle.svelte';
	import { findLabelsParentId, isLabelMailbox, isLabelsParent } from '$lib/types/labels';
	import { canNotify, notificationSupport, subscribePush, unsubscribePush } from '$lib/notifications';
	import { onMount } from 'svelte';
	import { fetchWithStepUp } from '$lib/auth/step-up';
	import type { LayoutData } from '../$types';
	import { fixFor, urgentState, type AccountReach } from '$lib/telegram/urgent-state';

	// --- Telegram (the agent's own bot) ---
	type TelegramStatus = {
		configured: boolean;
		linked: boolean;
		username: string | null;
		urgent: boolean;
		paused: boolean;
		accounts: AccountReach[];
	};
	let telegram = $state<TelegramStatus | null>(null);
	let telegramLink = $state<string | null>(null);
	let telegramError = $state<string | null>(null);
	let testState = $state<'idle' | 'sending' | 'sent'>('idle');

	async function loadTelegram() {
		const res = await fetch('/api/telegram');
		if (res.ok) telegram = await res.json();
	}

	async function telegramAction(body: Record<string, unknown>) {
		telegramError = null;
		const res = await fetchWithStepUp('/api/telegram', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(body)
		});
		const data = await res.json().catch(() => null);
		if (!res.ok) {
			if (!data?.stepUp) telegramError = data?.message ?? 'That didn’t work';
			return null;
		}
		return data;
	}

	async function linkTelegram() {
		const data = await telegramAction({ action: 'link' });
		if (data?.url) telegramLink = data.url;
	}

	async function unlinkTelegram() {
		if (await telegramAction({ action: 'unlink' })) {
			telegramLink = null;
			await loadTelegram();
		}
	}

	async function setTelegram(flags: { urgent?: boolean; paused?: boolean }) {
		if (await telegramAction({ action: 'set', ...flags })) await loadTelegram();
	}

	async function testTelegram() {
		testState = 'sending';
		testState = (await telegramAction({ action: 'test' })) ? 'sent' : 'idle';
	}

	onMount(loadTelegram);

	let { data }: { data: LayoutData } = $props();

	let enabled = $state(data.notificationsEnabled);
	// Notifications are on for the account, but each device needs its own
	// permission: on one that hasn't given it (a phone added later), the
	// switch reads off so turning it on asks there.
	let deviceAllowed = $state(true);
	onMount(() => { deviceAllowed = canNotify(); });
	const on = $derived(enabled && deviceAllowed);
	let selectedFolders = $state<Set<string>>(new Set(data.notificationFolders));
	let calendarEvents = $state(data.notifyCalendarEvents);
	let eventReminders = $state(data.notifyEventReminders);

	const states = $state<Record<string, SaveState>>({});
	function flash(key: string, ok: boolean) {
		states[key] = ok ? 'saved' : 'error';
		if (ok) setTimeout(() => { if (states[key] === 'saved') states[key] = 'idle'; }, 1800);
	}

	async function save(body: unknown, key: string) {
		states[key] = 'saving';
		try {
			const res = await fetch('/api/preferences/notifications', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(body)
			});
			flash(key, res.ok);
			if (res.ok) await invalidateAll();
		} catch {
			flash(key, false);
		}
	}

	let permissionError = $state('');

	async function toggleEnabled(next: boolean) {
		permissionError = '';
		if (next) {
			const support = notificationSupport();
			if (support !== 'supported') {
				permissionError =
					support === 'needs-home-screen'
						? 'On iPhone and iPad, add Zajel Mail to your Home Screen and turn notifications on there.'
						: 'This browser can’t show notifications.';
				states.enabled = 'error';
				enabled = false;
				return;
			}
			// Asked first, straight from the tap: Safari only shows the prompt
			// for a user gesture.
			const perm = await Notification.requestPermission();
			if (perm !== 'granted') {
				permissionError = 'Browser denied notification permission. Adjust it in your browser settings, then try again.';
				states.enabled = 'error';
				enabled = false;
				return;
			}
		}
		if (next) deviceAllowed = true;
		enabled = next;
		await save({ enabled: next }, 'enabled');
		// This device: subscribe for push so notifications arrive while the
		// app is closed, or stop them. Without push they still show while the
		// app is open.
		if (next) await subscribePush().catch(() => false);
		else await unsubscribePush();
	}

	function toggleFolder(id: string, checked: boolean) {
		const next = new Set(selectedFolders);
		if (checked) next.add(id);
		else next.delete(id);
		selectedFolders = next;
		save({ folders: [...next] }, `folder:${id}`);
	}

	const labelsParentId = $derived(findLabelsParentId(data.mailboxes));
	const notifiableFolders = $derived(
		data.mailboxes.filter(
			(m) =>
				!isLabelMailbox(m, labelsParentId) &&
				!isLabelsParent(m, labelsParentId) &&
				m.role !== 'drafts' &&
				m.role !== 'sent'
		)
	);
</script>

<svelte:head><title>{pageTitle({ page: 'Notifications', subtitle: 'Settings' })}</title></svelte:head>

<header class="mb-6">
	<h1 class="text-xl font-semibold text-text">Notifications</h1>
	<p class="text-sm text-text-tertiary mt-1">
		New mail and calendar activity.
	</p>
</header>

<section>
	<SettingRow
		title="Enable notifications"
		description="Request permission from your browser and show a notification when new mail arrives in the selected folders."
		state={states.enabled ?? 'idle'}
		errorMessage={permissionError}
	>
		{#snippet control()}
			<Toggle checked={on} onChange={toggleEnabled} />
		{/snippet}
	</SettingRow>

	<div class="py-4 border-b border-border last:border-b-0">
		<p class="text-sm font-medium text-text">Notify for folders</p>
		<p class="text-xs text-text-tertiary mt-1 mb-3">Choose which folders should trigger a notification.</p>
		<div class="flex flex-col gap-1.5 max-w-[420px]">
			{#each notifiableFolders as mb (mb.id)}
				<label class="flex items-center gap-2.5 px-3 py-2 rounded-lg bg-surface-hover/50 border border-border/60 cursor-pointer hover:bg-surface-hover transition-colors">
					<input
						type="checkbox"
						disabled={!on}
						checked={selectedFolders.has(mb.id)}
						onchange={(e) => toggleFolder(mb.id, (e.currentTarget as HTMLInputElement).checked)}
						class="w-3.5 h-3.5 rounded-md border-border accent-accent cursor-pointer disabled:cursor-not-allowed"
					/>
					<span class="text-sm text-text flex-1 truncate">{mb.name}</span>
					{#if mb.unreadEmails > 0}
						<span class="text-xs text-text-tertiary">{mb.unreadEmails}</span>
					{/if}
				</label>
			{/each}
		</div>
	</div>

	<div class="pt-6 pb-2">
		<p class="text-sm font-semibold text-text">Calendar</p>
	</div>

	<SettingRow
		title="New & updated events"
		description="Notify when an event is added or changed on one of your calendars — including from other devices and CalDAV clients."
		state={states.calendarEvents ?? 'idle'}
	>
		{#snippet control()}
			<Toggle
				checked={calendarEvents && on}
				disabled={!on}
				onChange={(next) => {
					calendarEvents = next;
					save({ calendarEvents: next }, 'calendarEvents');
				}}
			/>
		{/snippet}
	</SettingRow>

	<SettingRow
		title="Event reminders"
		description="Fire each event's reminders (e.g. 10 minutes before it starts), like Google or Apple Calendar."
		state={states.eventReminders ?? 'idle'}
	>
		{#snippet control()}
			<Toggle
				checked={eventReminders && on}
				disabled={!on}
				onChange={(next) => {
					eventReminders = next;
					save({ eventReminders: next }, 'eventReminders');
				}}
			/>
		{/snippet}
	</SettingRow>

	{#if telegram?.configured}
		<div class="pt-6 pb-2">
			<p class="text-sm font-semibold text-text">Telegram</p>
		</div>

		{#if telegramError}
			<div class="bg-danger/10 border border-danger/20 text-danger text-sm rounded-lg px-3 py-2 mb-2">{telegramError}</div>
		{/if}

		{#if telegram.linked}
			<SettingRow title={telegram.username ? `Linked to @${telegram.username}` : 'Linked'}>
				{#snippet control()}
					<button type="button" onclick={unlinkTelegram}
						class="px-2.5 py-1.5 text-xs text-text-tertiary hover:text-danger transition-colors cursor-pointer">Unlink</button>
				{/snippet}
			</SettingRow>
			<!-- Jev decides what is urgent, so the switch is off while it reads no
			     account; with several accounts, the ones it skips are listed. -->
			{@const urgent = urgentState(telegram.accounts, telegram.urgent)}
			{@const only = telegram.accounts.length === 1 ? urgent.skipped[0] : undefined}
			<SettingRow title="Urgent mail">
				{#snippet control()}
					{#if only?.blocked}
						<a href={fixFor(only.blocked).href} class="btn btn-secondary btn-sm">{fixFor(only.blocked).label}</a>
					{/if}
					<Toggle checked={urgent.checked} disabled={urgent.disabled} onChange={(next) => setTelegram({ urgent: next })} />
				{/snippet}
			</SettingRow>
			{#if telegram.accounts.length > 1}
				{#each urgent.skipped as account (account.email)}
					<SettingRow title={account.email}>
						{#snippet control()}
							{#if account.blocked}
								<a href={fixFor(account.blocked).href} class="btn btn-secondary btn-sm">{fixFor(account.blocked).label}</a>
							{/if}
							<Toggle checked={false} disabled />
						{/snippet}
					</SettingRow>
				{/each}
			{/if}
			<SettingRow title="Paused">
				{#snippet control()}
					<Toggle checked={telegram!.paused} onChange={(next) => setTelegram({ paused: next })} />
				{/snippet}
			</SettingRow>
			<SettingRow title="Test alert">
				{#snippet control()}
					{#if testState === 'sent'}
						<span class="text-xs text-success">Sent</span>
					{/if}
					<button type="button" onclick={testTelegram} disabled={testState === 'sending'} class="btn btn-secondary btn-sm">
						{testState === 'sending' ? 'Sending…' : 'Send'}
					</button>
				{/snippet}
			</SettingRow>
		{:else if telegramLink}
			<SettingRow title="Open in Telegram">
				{#snippet control()}
					<a href={telegramLink} target="_blank" rel="noreferrer" class="btn btn-primary btn-sm">Open</a>
				{/snippet}
			</SettingRow>
		{:else}
			<SettingRow title="Link Telegram">
				{#snippet control()}
					<button type="button" onclick={linkTelegram} class="btn btn-primary btn-sm">Link</button>
				{/snippet}
			</SettingRow>
		{/if}
	{/if}
</section>
