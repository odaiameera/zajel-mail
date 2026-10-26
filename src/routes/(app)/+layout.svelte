<script lang="ts">
	import Icon from '$lib/components/Icon.svelte';
	import CornerActions from '$lib/components/CornerActions.svelte';
	import Sidebar from '$lib/components/Sidebar.svelte';
	import AppRail from '$lib/components/AppRail.svelte';
	import AIAssistantRail from '$lib/components/AIAssistantRail.svelte';
	import ComposerShell from '$lib/components/composer/ComposerShell.svelte';
	import ProfileCard from '$lib/components/ProfileCard.svelte';
	import ToastContainer from '$lib/components/ToastContainer.svelte';
	import SearchInput from '$lib/components/SearchInput.svelte';
	import { goto, afterNavigate, onNavigate } from '$app/navigation';
	import { page } from '$app/state';
	import { PHONE_QUERY, sidebarIsDrawer } from '$lib/stores/viewport';
	import { composer, openCompose, setMode } from '$lib/stores/compose';
	import { onMount, setContext, untrack, type Snippet } from 'svelte';
	import { APP_PANEL, type AppPanelContext } from '$lib/app-panel';
	import { createReadingPaneStore } from '$lib/stores/readingPane';
	import { profilePhoto } from '$lib/stores/profilePhoto';
	import { realtime } from '$lib/stores/realtime';
	import { calendarNotify } from '$lib/stores/calendarNotify';
	import { canNotify, showNotification, subscribePush } from '$lib/notifications';
	import { showToast } from '$lib/stores/toast';
	import { loadUserState } from '$lib/stores/userState';
	import { AI_ASSISTANT_CONTEXT, type AIAssistantContext } from '$lib/types/assistant';
	import type { LayoutData } from './$types';

	let { data, children }: { data: LayoutData; children: any } = $props();

	// eslint-disable-next-line -- intentionally capturing initial values from server cookies
	let { readingPaneDefault } = data;
	const readingPane = createReadingPaneStore(readingPaneDefault);
	setContext('readingPane', readingPane);
	setContext('labels', data.labels ?? []);
	setContext('rules', data.rules ?? []);

	let searchQuery = $state(page.url.searchParams.get('q') ?? '');

	$effect(() => {
		// Keep the search box in sync with the URL. Navigating to /inbox,
		// /folder/*, etc. clears the chips; /search hydrates them from `q`.
		if (page.url.pathname === '/search') {
			searchQuery = page.url.searchParams.get('q') ?? '';
		} else {
			searchQuery = '';
		}
	});
	let profileOpen = $state(false);
	let profileCardEl = $state<HTMLDivElement | undefined>(undefined);
	let sidebarCollapsed = $state(false);
	let assistantOpen = $state(page.url.searchParams.get('assistant') === 'open');
	let currentEmailId = $state<string | null>(null);

	// The composer and the agent open in the same spot above the corner
	// buttons, so one gives way to the other: opening the agent folds a
	// message being written down to its bar, and bringing the composer up
	// (or starting a new message) closes the agent.
	function openAssistant() {
		if ($composer.mode === 'popup' || $composer.mode === 'fullscreen') setMode('minimized');
		assistantOpen = true;
	}
	$effect(() => {
		const mode = $composer.mode;
		if (mode === 'popup' || mode === 'fullscreen') untrack(() => { assistantOpen = false; });
	});

	setContext<AIAssistantContext>(AI_ASSISTANT_CONTEXT, {
		open: openAssistant,
		setCurrentEmail: (id) => { currentEmailId = id; },
		clearCurrentEmail: (id) => {
			if (currentEmailId === id) currentEmailId = null;
		}
	});

	const avatarLetter = $derived((data.displayName ?? 'O')[0].toUpperCase());
	// An account's colour (the stripe along the top, the avatar and its ring)
	// is there to tell linked accounts apart. With only one it is just a
	// second accent competing with the real one, so it waits for a second.
	const accountColor = $derived(
		(data.accounts?.length ?? 0) > 1 ? (data.activeAccountColor ?? null) : null
	);

	// The left column is the open app's own navigation (see $lib/app-panel):
	// folders anywhere in Mail, otherwise whatever panel the page hosts, and
	// nothing but a gutter for a page that hosts none.
	let appPanel = $state.raw<Snippet | null>(null);
	// Ownership is checked against a plain variable, not the state. Going
	// from one panel-hosting page to another (Calendar → Contacts), the new
	// page registers before the old one's onDestroy runs, and inside that
	// navigation's update the state can still read as the old panel — so a
	// check against it cleared the panel that had just been set.
	let ownPanel: Snippet | null = null;
	setContext<AppPanelContext>(APP_PANEL, {
		set: (panel) => { ownPanel = panel; appPanel = panel; },
		clear: (panel) => {
			if (ownPanel !== panel) return;
			ownPanel = null;
			appPanel = null;
		},
		closeDrawer: () => { drawerOpen = false; }
	});
	const inMail = $derived(/^\/(inbox|folder|email|search|flagged)(\/|$)/.test(page.url.pathname));
	// Apps that always host a panel get their column from the start. The
	// shell's own markup (the column width) is written before the page has
	// registered its panel, so going by `appPanel` alone rendered these
	// pages with no column on a full load, and the panel slid in only once
	// the page's script ran.
	const panelRoute = $derived(/^\/(calendar|contacts|settings)(\/|$)/.test(page.url.pathname));
	const panelKind = $derived<'mail' | 'app' | 'none'>(
		inMail ? 'mail' : appPanel || panelRoute ? 'app' : 'none'
	);
	const railCollapsed = $derived(panelKind === 'mail' && sidebarCollapsed && !$sidebarIsDrawer);
	// Only the mail sidebar collapses to an icon strip; app panels are
	// always full width.
	const sidebarWidth = $derived(
		panelKind === 'mail' ? (sidebarCollapsed ? '48px' : '224px') : panelKind === 'app' ? '224px' : '8px'
	);
	// Settings on a phone opens on its own section list (/settings), with a
	// way back to it from every section, so the drawer has nothing to add.
	const settingsRoute = $derived(page.url.pathname.startsWith('/settings'));

	// Below `lg` the left column becomes a drawer opened from the header,
	// and it closes itself once you pick somewhere to go.
	let drawerOpen = $state(false);
	afterNavigate(() => { drawerOpen = false; });

	// Dragging the open drawer (or the dimmed page beside it) to the left
	// moves it with the finger. Let go past a third of its width, or with a
	// flick, and it closes; otherwise it springs back. Touch and pen only —
	// a mouse closes it with a click.
	let drawerEl = $state<HTMLDivElement | undefined>(undefined);
	let dragX = $state(0);
	let dragWidth = $state(280);
	let dragging = $state(false);
	let drag: { x: number; y: number; axis: 'x' | 'y' | null; lastX: number; lastT: number; vx: number } | null = null;
	let suppressClick = false;

	function onDrawerPointerDown(e: PointerEvent) {
		if (!drawerOpen || !$sidebarIsDrawer || e.pointerType === 'mouse') return;
		drag = { x: e.clientX, y: e.clientY, axis: null, lastX: e.clientX, lastT: e.timeStamp, vx: 0 };
	}

	function onDrawerPointerMove(e: PointerEvent) {
		if (!drag) return;
		const dx = e.clientX - drag.x;
		if (!drag.axis) {
			const dy = e.clientY - drag.y;
			if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
			// Mostly vertical: a scroll, not a drag.
			if (Math.abs(dy) >= Math.abs(dx)) {
				drag = null;
				return;
			}
			drag.axis = 'x';
			dragWidth = drawerEl?.offsetWidth || 280;
			dragging = true;
			try {
				(e.currentTarget as Element).setPointerCapture(e.pointerId);
			} catch {
				// The pointer is already gone.
			}
		}
		const dt = Math.max(1, e.timeStamp - drag.lastT);
		drag.vx = 0.8 * ((e.clientX - drag.lastX) / dt) + 0.2 * drag.vx;
		drag.lastX = e.clientX;
		drag.lastT = e.timeStamp;
		dragX = Math.min(0, dx);
	}

	function onDrawerPointerEnd(e: PointerEvent) {
		const ended = drag;
		drag = null;
		if (!ended?.axis) return;
		// px/ms, and only if the finger was still moving when it lifted.
		const flick = e.type === 'pointerup' && e.timeStamp - ended.lastT < 100 && ended.vx < -0.4;
		if (e.type === 'pointerup' && (dragX < -dragWidth / 3 || flick)) drawerOpen = false;
		dragging = false;
		dragX = 0;
		// The lifted finger can still produce a click on whatever is under
		// it; a drag isn't a tap.
		suppressClick = true;
		setTimeout(() => { suppressClick = false; }, 50);
	}

	function onDrawerClickCapture(e: MouseEvent) {
		if (!suppressClick) return;
		e.preventDefault();
		e.stopPropagation();
	}

	// Moving between apps on a phone (Mail, Calendar, Contacts, Settings),
	// the page content fades out and the next app fades in; the header and
	// tab bar stay put. Uses the View Transitions API where there is one
	// (Safari 18, Chrome); elsewhere the switch is instant, as it is on
	// wider screens and with reduced motion. The name that picks out the
	// content is set only for the transition (see .app-switching in
	// layout.css): permanently, it would make the content a stacking context
	// and trap the pages' own modals beneath the tab bar.
	function appOf(pathname: string): string {
		if (/^\/(inbox|folder|email|search|flagged)(\/|$)/.test(pathname)) return 'mail';
		return pathname.split('/')[1] ?? '';
	}

	onNavigate((navigation) => {
		if (!navigation.from || !navigation.to) return;
		if (appOf(navigation.from.url.pathname) === appOf(navigation.to.url.pathname)) return;
		if (
			typeof document.startViewTransition !== 'function' ||
			!window.matchMedia(PHONE_QUERY).matches ||
			window.matchMedia('(prefers-reduced-motion: reduce)').matches
		) {
			return;
		}
		const root = document.documentElement;
		root.classList.add('app-switching');
		return new Promise<void>((resolve) => {
			const transition = document.startViewTransition(async () => {
				resolve();
				await navigation.complete.catch(() => {});
			});
			transition.finished.finally(() => root.classList.remove('app-switching')).catch(() => {});
		});
	});
	// Mail lists, where the phone layout floats a Compose button. Not an open
	// message: there the button would sit on top of the text being read.
	const onMailRoute = $derived(
		/^\/(inbox|folder|search|flagged)(\/|$)/.test(page.url.pathname)
	);

	onMount(() => {
		// Phase 13: avatar / labels / signatures live server-side now.
		// Wipe leftover localStorage + cookie state from earlier phases on
		// the first load after deploy so stale browser data can't shadow
		// the canonical SQLite values.
		const PHASE_13_CLEARED_KEY = 'ameera.phase13.cleared';
		try {
			if (!localStorage.getItem(PHASE_13_CLEARED_KEY)) {
				localStorage.removeItem('profile_photo_v2');
				localStorage.removeItem('profile_photo');
				localStorage.removeItem('ameera_signature');
				localStorage.removeItem('label_meta');
				localStorage.removeItem('folder_meta');
				localStorage.setItem(PHASE_13_CLEARED_KEY, '1');
			}
		} catch {
			// Private mode / quota errors — best-effort.
		}
		document.cookie = 'label_meta=; Path=/; Max-Age=0';
		document.cookie = 'folder_meta=; Path=/; Max-Age=0';
		// Phase 15a: legacy plain-text signature cookie is replaced by the
		// SQLite-backed Signatures page. Wipe it so stale browser data
		// can't reappear in any future export.
		document.cookie = 'signature=; Path=/; Max-Age=0';

		loadUserState();
		profilePhoto.hydrate();

		// Offer this app as the system handler for mailto: links, so it can be
		// set as the default mail app the way Gmail/Outlook web can. Browsers
		// gate this behind a user gesture / prior engagement and only prompt
		// once, so a quiet best-effort call here is enough.
		try {
			navigator.registerProtocolHandler?.('mailto', '/mailto?to=%s');
		} catch {
			// Unsupported browser or blocked by policy — non-fatal.
		}

		const handler = () => readingPane.setFromViewport(window.innerWidth);
		window.addEventListener('resize', handler);

		// Real-time push: keep the SSE connection open for the lifetime of
		// the (app) layout. We deliberately don't disconnect on
		// `document.hidden` — screen lock, App Nap, Spaces switch, or just
		// looking away can flip visibility for arbitrary durations, and
		// the user expects new mail to be live the moment they look back,
		// not after a fresh handshake.
		realtime.connect();

		return () => {
			window.removeEventListener('resize', handler);
			realtime.disconnect();
			calendarNotify.stop();
		};
	});

	// A device with a push subscription gets new mail and reminders from the
	// server (see $lib/server/push), so the open app leaves those system
	// notifications to it rather than showing each one twice. Each load
	// renews the subscription, which also re-links it after a new sign-in.
	let pushActive = $state(false);
	// A primitive, so the effect below runs when notifications are turned on
	// or off, not on every data refresh.
	const notificationsOn = $derived(data.notificationsEnabled);
	$effect(() => {
		if (!notificationsOn || !canNotify()) {
			pushActive = false;
			return;
		}
		subscribePush()
			.then((ok) => { pushActive = ok; })
			.catch(() => { pushActive = false; });
	});

	// Calendar push: poll CalDAV change tokens + VALARM reminders while any
	// notification channel is on. Reacts to settings changes live.
	$effect(() => {
		const wantsCalendar =
			data.notificationsEnabled && (data.notifyCalendarEvents || data.notifyEventReminders);
		const options = {
			newEvents: data.notifyCalendarEvents,
			reminders: data.notifyEventReminders,
			remindersByPush: pushActive
		};
		if (wantsCalendar) {
			calendarNotify.start(options);
			calendarNotify.setOptions(options);
		} else {
			calendarNotify.stop();
		}
	});

	// Watch the inbox unread count for new mail. Kept as a plain `let`
	// (not `$state`) so writes don't re-trigger the effect that reads it.
	// `-1` is the "no baseline yet" sentinel — first effect run captures
	// the starting value without firing a toast.
	let lastInboxUnread = -1;

	$effect(() => {
		const inbox = data.mailboxes.find((m) => m.role === 'inbox');
		if (!inbox) return;

		const current = inbox.unreadEmails;
		if (lastInboxUnread === -1) {
			lastInboxUnread = current;
			return;
		}

		if (current > lastInboxUnread) {
			const delta = current - lastInboxUnread;
			const onInbox = page.url.pathname === '/inbox';

			if (!onInbox) {
				showToast({
					message: `${delta} new message${delta === 1 ? '' : 's'}`,
					action: { label: 'View', onClick: () => goto('/inbox') }
				});
			}

			if (data.notificationsEnabled && !pushActive) {
				void showNotification(delta === 1 ? 'New message' : `${delta} new messages`, {
					body: 'Your inbox has new mail.',
					tag: 'ameera-mail-new',
					url: '/inbox'
				});
			}
		}

		lastInboxUnread = current;
	});

	function submitSearch(raw: string) {
		goto(`/search?q=${encodeURIComponent(raw)}`);
	}

	function handleClickOutside(e: MouseEvent) {
		if (profileOpen && profileCardEl && !profileCardEl.contains(e.target as Node)) {
			profileOpen = false;
		}
	}
</script>

<svelte:window
	onclick={handleClickOutside}
	onkeydown={(e) => { if (e.key === 'Escape' && drawerOpen) drawerOpen = false; }}
/>

<!--
	Two layouts from one grid. From `md` up: header across the top, then
	sidebar | content | agent anchor | app rail. Below `md` (phones): a single
	column of header, content, and the app rail turned into a bottom tab bar;
	the sidebar leaves the grid as a slide-in drawer and the agent drawer goes
	full-width. The desktop columns ride in a custom property so the same
	element can drop them below `md` — an inline grid-template-columns would
	win over any class.

	Between `md` and `lg` (phones in landscape, tablets in portrait) the
	desktop layout keeps everything but the left column, which is the
	drawer there too: a 224px column left the mail list and reading pane a
	sliver each at those widths.

	Added to the Home Screen on iOS, the page runs under the status bar
	(black-translucent, viewport-fit=cover), so the shell pads itself by the
	safe-area insets: the chrome colour runs up behind the clock and the
	header starts below it. In a browser tab the insets are 0. Its height is
	--app-height, not 100dvh, which iOS reports a status bar short there
	until something is dragged (see layout.css).
-->
<!--
	Behind the status bar on the Home Screen: a fixed, opaque strip in the
	chrome colour. iOS 27 blurs the top of an installed web app unless it
	finds a fixed element along the top edge to take the colour from. WebKit
	(LocalFrameView::fixedContainerEdges) hit-tests the middle of the top
	edge 4px down and wants a fixed or sticky box at least 90% of the width,
	over 10px tall and mostly opaque. The shell itself isn't fixed, so
	without this the blur smeared the account-colour border into a fade. Not
	pointer-events-none: when the closed drawer's dimmer (invisible, above
	this) is hit first, WebKit retries honouring pointer-events and must land
	here. Under the dimmer and the drawer so both still cover it; 0 tall in a
	browser tab.
-->
<div
	aria-hidden="true"
	class="fixed inset-x-0 top-0 z-[38] h-[env(safe-area-inset-top)] bg-surface"
></div>
<div
	class="app-shell h-[var(--app-height)] overflow-hidden bg-surface grid grid-cols-1 grid-rows-[auto_1fr_auto] md:grid-rows-[auto_1fr] md:[grid-template-columns:8px_minmax(0,1fr)_0px_52px] lg:[grid-template-columns:var(--shell-cols)]
		pt-[env(safe-area-inset-top)] pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)] md:pb-[env(safe-area-inset-bottom)]"
	class:density-compact={data.density === 'compact'}
	style="--shell-cols: {sidebarWidth} minmax(0, 1fr) 0px 52px; transition: grid-template-columns 0.3s ease;
		{accountColor ? `border-top: 2px solid ${accountColor};` : ''}"
>
	<!-- Row 1: Full-width header -->
	<div class="col-span-full flex items-center h-14 pl-2 md:pl-4 pr-0 gap-2 md:gap-4">
		<button
			type="button"
			onclick={() => { drawerOpen = true; }}
			class="lg:hidden w-10 h-10 shrink-0 flex items-center justify-center rounded-lg text-text-secondary hover:text-text hover:bg-surface-hover transition-colors cursor-pointer {panelKind === 'none' ? 'invisible' : settingsRoute ? 'max-md:invisible' : ''}"
			aria-label="Open menu"
			aria-expanded={drawerOpen}
		>
			<Icon name="menu" size={20} />
		</button>
		<h1 class="max-md:hidden text-lg font-bold text-text tracking-tight leading-none shrink-0 {railCollapsed ? 'lg:w-4' : 'lg:w-[192px]'} transition-all duration-200 overflow-hidden whitespace-nowrap">
			{railCollapsed ? '' : 'zajel.'}
		</h1>
		<SearchInput bind:value={searchQuery} onSubmit={submitSearch} mailboxes={data.mailboxes} />
		<!-- On phones the search box takes this space instead. -->
		<div class="flex-1 max-md:hidden"></div>
		<!-- 52px wrapper aligns avatar center with the AppRail column below -->
		<div class="w-[52px] shrink-0 flex items-center justify-center">
			<button
				onclick={(e) => { e.stopPropagation(); profileOpen = !profileOpen; }}
				class="w-8 h-8 rounded-full bg-accent text-white flex items-center justify-center text-xs font-semibold select-none shrink-0 cursor-pointer transition-shadow overflow-hidden"
				style={accountColor
					? `background-color: ${accountColor}; box-shadow: 0 0 0 2px var(--color-surface), 0 0 0 4px ${accountColor};`
					: ''}
				title="Accounts — {data.userEmail}"
			>
				{#if $profilePhoto.url}
					<img
						src={$profilePhoto.url}
						alt="Profile"
						class="w-full h-full object-cover origin-center pointer-events-none select-none"
						style="transform: translate({$profilePhoto.offsetX * (32 / 80)}px, {$profilePhoto.offsetY * (32 / 80)}px) scale({$profilePhoto.zoom});"
						draggable="false"
					/>
				{:else}
					{avatarLetter}
				{/if}
			</button>
		</div>
	</div>

	<!--
		Row 2, Col 2: Main content — the tray.

		Mail list and reading pane sit on --color-bg, rounded on all four
		corners and inset from the bottom of the window so the chrome colour
		shows beneath. The chrome around it (sidebar, app rail, header) stays on
		--color-surface and runs to the window edge.

		Note the direction: under the Primer palette the CHROME is the recessed
		tone and the CONTENT is the raised one — #010409 chrome under a #0d1117
		tray in dark, #f6f8fa chrome under a #ffffff tray in light. That is
		GitHub's own model, where the global header and sidebars sit behind the
		page rather than above it, and it holds in both themes. (It is the
		reverse of what this app did before, when the content was the darker
		tone; if the tray ever stops reading as raised, that inversion is the
		first thing to check.)

		Only the bottom is inset: left and right already meet the chrome, so the
		corners alone separate them.
	-->
	<main class="row-start-2 md:col-start-2 md:mb-2 overflow-hidden min-w-0 min-h-0 bg-bg md:rounded-xl">
		<!-- What fades when switching apps on a phone; the tray behind it stays. -->
		<div class="app-content h-full">
			{@render children()}
		</div>
	</main>

	<!-- Row 2, Col 1: the open app's navigation — after <main> in the DOM so
	     the page has registered its panel (if any) before this renders; grid
	     placement puts it back on the left. `lg:contents` keeps the panel
	     itself as the grid item on wide screens; below `lg` this wrapper is
	     the drawer. The mail sidebar's collapse button closes the drawer
	     there, since a 48px icon strip makes no sense as an overlay.
	     The drawer slides on the `translate` property (what Tailwind's
	     translate utilities set), with iOS's sheet curve: quick to start,
	     long to settle, and a little quicker out than in. The backdrop stays
	     in the DOM so it can fade out as well as in. -->
	{#if panelKind !== 'none'}
		<button
			type="button"
			class="lg:hidden fixed inset-0 z-40 bg-black/50 cursor-default touch-none transition-opacity ease-[cubic-bezier(0.32,0.72,0,1)] motion-reduce:transition-none
				{drawerOpen ? 'opacity-100 duration-[320ms]' : 'opacity-0 pointer-events-none duration-[240ms]'}"
			style={dragging ? `opacity: ${Math.max(0, 1 + dragX / dragWidth)}; transition: none;` : undefined}
			aria-label="Close menu"
			aria-hidden={!drawerOpen}
			tabindex={drawerOpen ? 0 : -1}
			onclick={() => { drawerOpen = false; }}
			onpointerdown={onDrawerPointerDown}
			onpointermove={onDrawerPointerMove}
			onpointerup={onDrawerPointerEnd}
			onpointercancel={onDrawerPointerEnd}
		></button>
		<!-- The drag is a touch shortcut; Escape and the backdrop close it otherwise. -->
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<div
			bind:this={drawerEl}
			class="lg:contents max-lg:fixed max-lg:inset-y-0 max-lg:-bottom-[var(--app-under)] max-lg:left-0 max-lg:z-50 max-lg:w-[280px] max-lg:max-w-[85vw] max-lg:bg-surface
				max-lg:transition-[translate,visibility,box-shadow] max-lg:ease-[cubic-bezier(0.32,0.72,0,1)] motion-reduce:transition-none
				max-lg:touch-pan-y max-lg:[&_*]:touch-pan-y
				max-lg:pt-[env(safe-area-inset-top)] max-lg:pb-[env(safe-area-inset-bottom)] max-lg:pl-[env(safe-area-inset-left)]
				{drawerOpen ? 'max-lg:shadow-2xl max-lg:duration-[320ms]' : 'max-lg:-translate-x-full max-lg:invisible max-lg:duration-[240ms]'}"
			style={dragging ? `translate: ${dragX}px 0; transition: none;` : undefined}
			onpointerdown={onDrawerPointerDown}
			onpointermove={onDrawerPointerMove}
			onpointerup={onDrawerPointerEnd}
			onpointercancel={onDrawerPointerEnd}
			onclickcapture={onDrawerClickCapture}
		>
			<div class="lg:col-start-1 lg:row-start-2 h-full min-h-0 overflow-hidden">
				{#if panelKind === 'mail'}
					<Sidebar
						mailboxes={data.mailboxes}
						labels={data.labels ?? []}
						folderExpanded={data.folderExpanded ?? {}}
						hideHeader={!$sidebarIsDrawer}
						collapsed={sidebarCollapsed && !$sidebarIsDrawer}
						onToggleCollapse={() => {
							if ($sidebarIsDrawer) drawerOpen = false;
							else sidebarCollapsed = !sidebarCollapsed;
						}}
					/>
				{:else if appPanel}
					<div class="h-full flex flex-col bg-surface">
						{#if $sidebarIsDrawer}
							<div class="px-4 py-3"><span class="text-lg font-bold text-text tracking-tight leading-none">zajel.</span></div>
						{/if}
						{@render appPanel()}
					</div>
				{/if}
			</div>
		</div>
	{/if}

	<!-- Row 2, Col 4: App rail (row 3 — the bottom tab bar — on phones) -->
	<AppRail />
</div>

<!-- + (new message, event or contact) and Zajel, the AI mail agent: bottom-right, beside the app
     rail on desktop and above the tab bar on phones. The agent opens as a
     card above them. -->
<CornerActions
	{assistantOpen}
	onToggleAssistant={() => { if (assistantOpen) assistantOpen = false; else openAssistant(); }}
	readingOnPhone={inMail && !onMailRoute}
/>
<AIAssistantRail
	open={assistantOpen}
	aiEnabled={data.aiEnabled}
	{currentEmailId}
	onClose={() => { assistantOpen = false; }}
/>

{#if profileOpen}
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<!-- svelte-ignore a11y_click_events_have_key_events -->
	<div bind:this={profileCardEl} class="fixed z-50 top-[calc(3.5rem+env(safe-area-inset-top))] right-2 md:right-16" onclick={(e) => e.stopPropagation()}>
		<ProfileCard
			displayName={data.displayName}
			email={data.userEmail}
			accounts={data.accounts ?? []}
			activeAccountId={data.activeAccountId ?? null}
			accountUnread={data.accountUnread ?? {}}
			onClose={() => { profileOpen = false; }}
		/>
	</div>
{/if}

<ComposerShell />
<ToastContainer />
