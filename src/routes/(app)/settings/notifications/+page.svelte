<script lang="ts">
	import { pageTitle } from '$lib/utils/title';
	import { invalidateAll } from '$app/navigation';
	import SettingRow from '$lib/components/settings/SettingRow.svelte';
	import { useDraft } from '$lib/settings/draft.svelte';
	import { saveEach, sendJson, type SaveStep } from '$lib/settings/send';
	import Toggle from '$lib/components/settings/Toggle.svelte';
	import { findLabelsParentId, isLabelMailbox, isLabelsParent } from '$lib/types/labels';
	import {
		canNotify,
		currentPushSubscription,
		notificationSupport,
		pushWantedHere,
		setPushWantedHere,
		subscribePush,
		unsubscribePush
	} from '$lib/notifications';
	import { relativeTime } from '$lib/devices';
	import { onMount, untrack } from 'svelte';
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
		if (!res.ok) return;
		telegram = await res.json();
		// Its switches come in as saved; one already changed here keeps its choice.
		if (telegram?.linked) draft.seed({ telegramUrgent: telegram.urgent, telegramPaused: telegram.paused });
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
			// Its two switches are gone with it, saved or not.
			draft.forget(['telegramUrgent', 'telegramPaused']);
			await loadTelegram();
		}
	}

	async function testTelegram() {
		testState = 'sending';
		testState = (await telegramAction({ action: 'test' })) ? 'sent' : 'idle';
	}

	onMount(loadTelegram);

	let { data }: { data: LayoutData } = $props();

	type Values = {
		enabled: boolean;
		folders: string[];
		calendarEvents: boolean;
		eventReminders: boolean;
		/** Push on this device, kept on the device. Known once the page has asked the browser. */
		pushHere?: boolean;
		/** Telegram's switches, once it is linked. */
		telegramUrgent?: boolean;
		telegramPaused?: boolean;
	};

	/*
	 * Every switch and choice here waits for Save in the bar at the foot of
	 * the page. What acts at once: asking the browser for permission (it
	 * only shows its prompt in answer to a click), linking and unlinking
	 * Telegram, and its test alert.
	 */
	const draft = useDraft<Values>({
		// What the page opened with; later reloads of `data` leave the form alone.
		initial: untrack(() => ({
			enabled: data.notificationsEnabled,
			// Kept sorted, so ticking a box and unticking it again reads as no change.
			folders: [...data.notificationFolders].sort(),
			calendarEvents: data.notifyCalendarEvents,
			eventReminders: data.notifyEventReminders
		})),
		async persist(changed, all, stored) {
			const steps: SaveStep<Values>[] = [];
			const prefs: Partial<Values> = {};
			for (const key of ['enabled', 'folders', 'calendarEvents', 'eventReminders'] as const) {
				if (changed[key] !== undefined) (prefs as Record<string, unknown>)[key] = changed[key];
			}
			if (Object.keys(prefs).length > 0) {
				steps.push({
					label: 'Notifications',
					values: prefs,
					// The keys are the endpoint's own.
					run: async () => {
						await sendJson('/api/preferences/notifications', prefs);
						await invalidateAll();
					}
				});
			}
			// Switching notifications on or off takes this device along: on
			// subscribes it for push so notifications arrive while the app is
			// closed, off stops them.
			const followsMain = changed.enabled !== undefined;
			if (changed.pushHere !== undefined || followsMain) {
				const wanted = all.pushHere ?? all.enabled;
				steps.push({
					label: 'This device',
					// Whatever this device ended up with.
					values: () => ({ pushHere }),
					run: async () => {
						// Push is extra (without it notifications still show while the
						// app is open), so with the main switch a device that can't take
						// it just reads off; switched on its own, it says so.
						if (!(await setPushHere(wanted)) && !followsMain) {
							throw new Error('Push couldn’t be turned on for this device.');
						}
					}
				});
			}
			const flags: { urgent?: boolean; paused?: boolean } = {};
			const telegramValues: Partial<Values> = {};
			if (changed.telegramUrgent !== undefined) flags.urgent = telegramValues.telegramUrgent = changed.telegramUrgent;
			if (changed.telegramPaused !== undefined) flags.paused = telegramValues.telegramPaused = changed.telegramPaused;
			if (Object.keys(flags).length > 0) {
				steps.push({
					label: 'Telegram',
					values: telegramValues,
					run: async () => {
						await sendJson('/api/telegram', { action: 'set', ...flags }, { stepUp: true });
						await loadTelegram();
					}
				});
			}
			await saveEach(stored, steps);
		}
	});

	// Notifications are on for the account, but each device needs its own
	// permission: on one that hasn't given it (a phone added later), the
	// switch reads off so turning it on asks there.
	let deviceAllowed = $state(true);
	onMount(() => { deviceAllowed = canNotify(); });
	// The rows under the main switch follow it as it is on screen, saved or
	// not, so the folders can be picked before Save.
	const on = $derived(draft.value.enabled && deviceAllowed);

	let permissionError = $state('');

	/**
	 * Asks this browser for permission, straight from the tap (Safari only
	 * shows the prompt for a user gesture). The message when it can't notify.
	 */
	async function askPermission(): Promise<string | null> {
		const support = notificationSupport();
		if (support !== 'supported') {
			return support === 'needs-home-screen'
				? 'On iPhone and iPad, add Zajel Mail to your Home Screen and turn notifications on there.'
				: 'This browser can’t show notifications.';
		}
		const perm = await Notification.requestPermission();
		if (perm !== 'granted') {
			return 'Browser denied notification permission. Adjust it in your browser settings, then try again.';
		}
		return null;
	}

	// --- Push on this device, and the devices that have it ---
	// Push is what reaches a device while the app is closed. The account
	// switch above is for everyone; each device also has its own, kept on
	// the device, so a phone turned off stays off when the app opens there.
	type PushDevice = { label: string; current: boolean; createdAt: string; lastSentAt: string | null };
	let devices = $state<PushDevice[]>([]);
	/** Whether this device is subscribed now. */
	let pushHere = $state(false);
	let pushError = $state('');

	async function loadDevices() {
		const res = await fetch('/api/push/devices').catch(() => null);
		if (res?.ok) devices = ((await res.json()) as { devices: PushDevice[] }).devices;
	}

	onMount(async () => {
		pushHere = pushWantedHere() && (await currentPushSubscription().catch(() => null)) !== null;
		draft.seed({ pushHere });
		await loadDevices();
	});

	/** Subscribe or unsubscribe this device, remembering the choice here. True when it took. */
	async function setPushHere(next: boolean): Promise<boolean> {
		setPushWantedHere(next);
		if (next) pushHere = await subscribePush().catch(() => false);
		else {
			await unsubscribePush();
			pushHere = false;
		}
		await loadDevices();
		return pushHere === next;
	}

	/** This device's switch waits for Save, but a browser permission it needs is asked for now. */
	async function togglePushHere(next: boolean) {
		pushError = '';
		if (next && !canNotify()) {
			const problem = await askPermission();
			if (problem) {
				pushError = problem;
				return;
			}
			deviceAllowed = true;
		}
		draft.value.pushHere = next;
		pushChosen = true;
	}

	/**
	 * "This device" as it was when the main switch left its saved value, so
	 * that switching it back puts the device back too; and whether the
	 * person set "This device" themselves since, which then stands.
	 */
	let pushBeforeMain: boolean | undefined;
	let pushChosen = false;

	/**
	 * The main switch waits for Save like the rest. Turning it on asks the
	 * browser for permission there and then, as browsers only show their
	 * prompt in answer to a click; refused, nothing changes and the reason
	 * shows beside it. This device follows the switch: on subscribes it for
	 * push, off stops it.
	 */
	async function toggleEnabled(next: boolean) {
		permissionError = '';
		// On for the account but never allowed here, the switch reads off on
		// this device, and turning it on is turning it on here.
		const onHereAlready = deviceAllowed;
		if (next) {
			const problem = await askPermission();
			if (problem) {
				permissionError = problem;
				return;
			}
			deviceAllowed = true;
		}
		// This device goes along only while the main switch differs from what
		// is saved: off to on subscribes it, on to off stops it. Back where it
		// was saved, the device is back to how it was before (or how the
		// person has since set it), so there is nothing to save.
		if (draft.value.enabled === draft.baseline.enabled) {
			pushBeforeMain = draft.value.pushHere;
			pushChosen = false;
		}
		draft.value.enabled = next;
		if (next !== draft.baseline.enabled || (next && !onHereAlready)) draft.value.pushHere = next;
		// (Not known yet when the main switch moved: as saved, once it is.)
		else if (!pushChosen) draft.value.pushHere = pushBeforeMain ?? draft.baseline.pushHere;
	}

	function toggleFolder(id: string, checked: boolean) {
		const next = new Set(draft.value.folders);
		if (checked) next.add(id);
		else next.delete(id);
		draft.value.folders = [...next].sort();
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
		state={permissionError ? 'error' : 'idle'}
		errorMessage={permissionError}
	>
		{#snippet control()}
			<Toggle checked={on} ariaLabel="Enable notifications" onChange={toggleEnabled} />
		{/snippet}
	</SettingRow>

	<SettingRow
		title="This device"
		description="Push reaches this device while the app is closed. Off, this device shows notifications only while the app is open, and stays off when the app opens here again."
		state={pushError ? 'error' : 'idle'}
		errorMessage={pushError}
	>
		{#snippet control()}
			<Toggle
				checked={(draft.value.pushHere ?? pushHere) && on}
				disabled={!on}
				ariaLabel="This device"
				onChange={togglePushHere}
			/>
		{/snippet}
	</SettingRow>

	{#if devices.length > 0}
		<div class="py-4 border-b border-border last:border-b-0">
			<p class="text-sm font-medium text-text">Devices receiving push</p>
			<p class="text-xs text-text-tertiary mt-1 mb-2">
				Each browser that turned push on. Signing a device out in Settings → Security stops its push too.
			</p>
			{#each devices as d}
				<div class="flex items-center gap-3 py-2 border-t border-border/60 first:border-t-0">
					<div class="flex-1 min-w-0">
						<p class="text-sm text-text truncate">
							{d.label}
							{#if d.current}
								<span class="ml-2 text-3xs uppercase tracking-wide text-accent-fg font-semibold">This device</span>
							{/if}
						</p>
						<p class="text-xs text-text-tertiary mt-0.5">
							{d.lastSentAt ? `Last notified ${relativeTime(d.lastSentAt)}` : 'Nothing sent yet'} · added {relativeTime(d.createdAt)}
						</p>
					</div>
				</div>
			{/each}
		</div>
	{/if}

	<div class="py-4 border-b border-border last:border-b-0">
		<p class="text-sm font-medium text-text">Notify for folders</p>
		<p class="text-xs text-text-tertiary mt-1 mb-3">Choose which folders should trigger a notification.</p>
		<div class="flex flex-col gap-1.5 max-w-[420px]">
			{#each notifiableFolders as mb (mb.id)}
				<label class="flex items-center gap-2.5 px-3 py-2 rounded-lg bg-surface-hover/50 border border-border/60 cursor-pointer hover:bg-surface-hover transition-colors">
					<input
						type="checkbox"
						disabled={!on}
						checked={draft.value.folders.includes(mb.id)}
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
	>
		{#snippet control()}
			<Toggle
				checked={draft.value.calendarEvents && on}
				disabled={!on}
				ariaLabel="New & updated events"
				onChange={(next) => (draft.value.calendarEvents = next)}
			/>
		{/snippet}
	</SettingRow>

	<SettingRow
		title="Event reminders"
		description="Fire each event's reminders (e.g. 10 minutes before it starts), like Google or Apple Calendar."
	>
		{#snippet control()}
			<Toggle
				checked={draft.value.eventReminders && on}
				disabled={!on}
				ariaLabel="Event reminders"
				onChange={(next) => (draft.value.eventReminders = next)}
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
			{@const urgent = urgentState(telegram.accounts, draft.value.telegramUrgent ?? telegram.urgent)}
			{@const only = telegram.accounts.length === 1 ? urgent.skipped[0] : undefined}
			<SettingRow title="Urgent mail">
				{#snippet control()}
					{#if only?.blocked}
						<a href={fixFor(only.blocked).href} class="btn btn-secondary btn-sm">{fixFor(only.blocked).label}</a>
					{/if}
					<Toggle
						checked={urgent.checked}
						disabled={urgent.disabled}
						ariaLabel="Urgent mail"
						onChange={(next) => (draft.value.telegramUrgent = next)}
					/>
				{/snippet}
			</SettingRow>
			{#if telegram.accounts.length > 1}
				{#each urgent.skipped as account (account.email)}
					<SettingRow title={account.email}>
						{#snippet control()}
							{#if account.blocked}
								<a href={fixFor(account.blocked).href} class="btn btn-secondary btn-sm">{fixFor(account.blocked).label}</a>
							{/if}
							<Toggle checked={false} disabled ariaLabel="Urgent mail for {account.email}" />
						{/snippet}
					</SettingRow>
				{/each}
			{/if}
			<SettingRow title="Paused">
				{#snippet control()}
					<Toggle
						checked={draft.value.telegramPaused ?? telegram!.paused}
						ariaLabel="Paused"
						onChange={(next) => (draft.value.telegramPaused = next)}
					/>
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
