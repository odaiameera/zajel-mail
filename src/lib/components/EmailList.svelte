<script lang="ts">
	import Icon from '$lib/components/Icon.svelte';
	import EmailListItem from './EmailListItem.svelte';
	import EmailDetail from './EmailDetail.svelte';
	import MailboxPicker from './MailboxPicker.svelte';
	import ListFilterBar from './ListFilterBar.svelte';
	import InboxTabs from './InboxTabs.svelte';
	import CategoryPicker from './CategoryPicker.svelte';
	import { moveToCategory } from '$lib/categories/api';
	import { INBOX_CATEGORIES, type InboxCategory, type InboxTabsState } from '$lib/types/categories';
	import { tabContentIn } from '$lib/transitions';
	import { LIST_WIDTH, MIN_READING_PANE, listWidth, nudgeWidth, startWidthDrag } from '$lib/stores/paneWidths';
	import { invalidateAll, goto } from '$app/navigation';
	import { page } from '$app/state';
	import { getContext, setContext, untrack } from 'svelte';
	import { get } from 'svelte/store';
	import type { Email, Mailbox } from '$lib/jmap/types';
	import { LABELS_CONTEXT, type Label, type LabelsContext } from '$lib/types/labels';
	import { browser } from '$app/environment';
	import { isPhone } from '$lib/stores/viewport';
	import { isScheduledMailbox } from '$lib/jmap/mailbox';
	import { isRemindMeLaterMailbox } from '$lib/mailboxes';

	let {
		emails,
		total,
		title,
		mailboxId = '',
		page: currentPage = 1,
		pageSize = 50,
		totalPages = 1,
		showFilters = false,
		inboxTabs = null,
	}: {
		emails: Email[];
		total: number;
		title: string;
		mailboxId?: string;
		page?: number;
		pageSize?: number;
		totalPages?: number;
		showFilters?: boolean;
		/** The Inbox's category tabs; null everywhere else, and when tabs are off. */
		inboxTabs?: InboxTabsState | null;
	} = $props();

	const rangeStart = $derived(total === 0 ? 0 : (currentPage - 1) * pageSize + 1);
	const rangeEnd = $derived(Math.min(currentPage * pageSize, total));

	function goToPage(n: number) {
		const url = new URL(page.url);
		if (n <= 1) url.searchParams.delete('page');
		else url.searchParams.set('page', String(n));
		goto(url.pathname + url.search, { keepFocus: true, noScroll: true });
	}

	const mailboxes = $derived<Mailbox[]>(page.data.mailboxes ?? []);
	const labelsContext = getContext<LabelsContext | undefined>(LABELS_CONTEXT);
	const allLabels: Label[] = $derived(labelsContext?.current ?? []);

	// Expose the current list's mailbox + reminded-id set to nested
	// EmailListItems so they can render per-row hover actions without a
	// long prop chain.
	setContext('listMailboxId', () => mailboxId);
	// Rows offer "Move to tab" only while the list is a tabbed Inbox.
	setContext('inboxTabs', () => inboxTabs);
	// In Sent and Drafts every sender is you, so rows name the recipients
	// instead — otherwise the whole list reads as your own name repeated.
	const listRole = $derived(mailboxes.find((m) => m.id === mailboxId)?.role ?? null);
	const listIsScheduled = $derived(
		mailboxes.some((m) => m.id === mailboxId && isScheduledMailbox(m))
	);
	setContext('showRecipients', () => listRole === 'sent' || listRole === 'drafts' || listIsScheduled);
	// emailId → when it goes out (or that it didn't), for rows in Scheduled.
	setContext(
		'scheduledSends',
		() =>
			new Map<string, { sendAt: string; status: string; error: string | null }>(
				(page.data.scheduled ?? []).map(
					(s: { emailId: string; sendAt: string; status: string; error: string | null }) => [s.emailId, s]
				)
			)
	);
	// Getter so callers always see the current page's marker set even
	// after invalidateAll() refreshes the load data without remounting.
	setContext('remindedIds', () => new Set<string>(page.data.remindedIds ?? []));
	// emailId → ISO return time for parked snoozes — lets rows in the
	// Remind Me Later folder show when each mail comes back + unsnooze.
	setContext(
		'reminderAt',
		() =>
			new Map<string, string>(
				(page.data.reminders ?? []).map((r: { emailId: string; remindAt: string }) => [
					r.emailId,
					r.remindAt
				])
			)
	);

	const readingPane = getContext<{ subscribe: (fn: (v: boolean) => void) => () => void; toggle: () => void }>('readingPane');
	// Read the store synchronously so the pane renders in its real state
	// on first paint instead of flashing closed for ~200ms while waiting
	// for the subscription effect to mount.
	let panePreference = $state(get(readingPane));
	$effect(() => {
		const unsub = readingPane.subscribe((v: boolean) => { panePreference = v; });
		return unsub;
	});
	let selectedIds = $state(new Set<string>());
	let bulkLoading = $state('');
	let previewEmail = $state<Email | null>(null);
	// When the reading pane actually shows. A phone has no room beside the
	// list, so rows open the full message there whatever the saved
	// preference says (the preference is left alone for wider screens; the
	// markup also hides the pane below `md` in CSS, covering the first paint
	// before this store has read the viewport). It doesn't depend on the list
	// having anything in it: it used to close for an empty list, so a filter
	// with no results (Unread on a read tab) made it vanish, and the toggle
	// then appeared to do nothing.
	const paneOpen = $derived(panePreference && !$isPhone);
	// The list's width beside the reading pane is shared by every list (each
	// folder is its own page, so its own list), so switching folders keeps the
	// width you dragged. On the server the page data stands in for the store.
	// It also gives way to the window: the reading pane keeps at least
	// MIN_READING_PANE, so a width set on a big screen doesn't squeeze it out
	// on a small one (the saved width is kept for when there's room again).
	const savedListPx = $derived(browser ? $listWidth : ((page.data.paneListWidth as number | undefined) ?? LIST_WIDTH.fallback));
	let rowWidth = $state(0);
	const DIVIDER_PX = 1; // the divider itself, a hairline (its grab area overhangs both sides)
	// No cap until the row has been measured (0 before the first layout).
	const listRoom = () => (rowWidth > 0 ? Math.max(LIST_WIDTH.min, rowWidth - MIN_READING_PANE - DIVIDER_PX) : Infinity);
	const listPx = $derived(rowWidth > 0 ? Math.min(savedListPx, listRoom()) : savedListPx);
	let dragging = $state(false);
	let loadingPreview = $state(false);
	let showMovePicker = $state(false);
	let moveTriggerEl = $state<HTMLButtonElement | undefined>(undefined);
	let showCategoryPicker = $state(false);
	let categoryTriggerEl = $state<HTMLButtonElement | undefined>(undefined);

	// A selection belongs to the list it was made in. Every folder, label,
	// page and tab reuses this component, and Trash in Trash destroys what is
	// selected, so start again when the place or the account changes, and let
	// go of rows that a refresh took out of the list.
	const listKey = $derived(
		`${page.data.activeAccountId ?? ''} ${mailboxId} ${page.url.pathname}${page.url.search}`
	);
	let selectionKey = '';
	$effect(() => {
		const key = listKey;
		const visible = new Set(emails.map((e) => e.id));
		untrack(() => {
			if (key !== selectionKey) {
				selectionKey = key;
				showMovePicker = false;
				showCategoryPicker = false;
				if (selectedIds.size > 0) selectedIds = new Set();
				return;
			}
			const kept = [...selectedIds].filter((id) => visible.has(id));
			if (kept.length !== selectedIds.size) selectedIds = new Set(kept);
		});
	});

	// Switching Inbox tabs slides the new tab's mail in from the side of the
	// tab you moved to. Only a change of tab does: the realtime layer re-runs
	// the load all the time, and a refresh, a page turn or a filter keeps the
	// tab and so keeps still; the first paint has nothing to move from. The
	// new tab starts at its top, as a new list should, rather than wherever
	// the last one was scrolled to — set before the browser paints it.
	let listScroller = $state<HTMLElement>();
	let listBody = $state<HTMLElement>();
	let tabShown: InboxCategory | null = null;
	let tabMotion: Animation[] = [];
	$effect(() => {
		const tab = inboxTabs?.active ?? null;
		untrack(() => {
			const from = tabShown;
			tabShown = tab;
			if (!from || !tab || from === tab) return;
			for (const a of tabMotion) a.cancel();
			tabMotion = [];
			if (listScroller) listScroller.scrollTop = 0;
			if (!listBody) return;
			const order = (key: InboxCategory) => INBOX_CATEGORIES.findIndex((c) => c.key === key);
			tabMotion = tabContentIn(listBody, order(tab) > order(from) ? 1 : -1);
		});
	});

	async function bulkMoveToCategory(category: InboxCategory) {
		if (selectedIds.size === 0 || !inboxTabs) return;
		showCategoryPicker = false;
		bulkLoading = 'setCategory';
		try {
			// Every selected row is in the active tab — the list shows no other.
			await moveToCategory([...selectedIds], category, inboxTabs.active);
			selectedIds = new Set();
		} finally {
			bulkLoading = '';
		}
	}

	/**
	 * Build the payload for a dragstart on a list row. If the dragged email
	 * is part of a multi-selection, move all selected ids; otherwise drag
	 * just this one so users can drag a row without selecting it first.
	 */
	function handleRowDragStart(email: Email, e: DragEvent) {
		if (!e.dataTransfer) return;
		const ids = selectedIds.has(email.id) && selectedIds.size > 1
			? [...selectedIds]
			: [email.id];
		e.dataTransfer.setData('application/x-email-ids', JSON.stringify(ids));
		e.dataTransfer.effectAllowed = 'move';
	}

	/**
	 * Move the selection to a folder, or add a label to it: the server tells
	 * them apart ("Move to" a label adds the label and moves nothing).
	 */
	async function bulkMoveTo(targetMailboxId: string) {
		if (selectedIds.size === 0) return;
		showMovePicker = false;
		bulkLoading = 'moveTo';
		try {
			await fetch('/api/email/bulk', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					ids: [...selectedIds],
					action: 'moveTo',
					targetMailboxId
				})
			});
			selectedIds = new Set();
			await invalidateAll();
		} finally {
			bulkLoading = '';
		}
	}

	function startDrag(e: PointerEvent) {
		// Start from the width as drawn, which may be less than the saved one
		// on a small window.
		listWidth.set(listPx);
		startWidthDrag(e, listWidth, { max: listRoom, onDragging: (d) => (dragging = d) });
	}

	const allSelected = $derived(emails.length > 0 && selectedIds.size === emails.length);

	// What an empty list says, per place: a title, no explaining.
	const emptyTitle = $derived.by<string>(() => {
		if (inboxTabs) {
			const label = INBOX_CATEGORIES.find((c) => c.key === inboxTabs.active)?.label;
			return inboxTabs.active === 'important' ? "You're all caught up" : `Nothing in ${label}`;
		}
		if (title === 'Starred') return 'No starred messages';
		if (title === 'Search results') return 'No matches';
		switch (listRole) {
			case 'drafts': return 'No drafts';
			case 'sent': return 'Nothing sent yet';
			case 'junk': return 'No junk mail';
			case 'trash': return 'Trash is empty';
			case 'archive': return 'Nothing archived';
		}
		const listMailbox = mailboxes.find((m) => m.id === mailboxId);
		if (listMailbox && isRemindMeLaterMailbox(listMailbox)) return 'Nothing snoozed';
		if (listIsScheduled) return 'Nothing scheduled';
		return 'This folder is empty';
	});

	function toggleSelect(id: string, checked: boolean) {
		const next = new Set(selectedIds);
		if (checked) next.add(id); else next.delete(id);
		selectedIds = next;
	}

	function toggleAll() {
		selectedIds = allSelected ? new Set() : new Set(emails.map((e) => e.id));
	}

	function clearSelection() { selectedIds = new Set(); }

	async function bulkAction(action: string) {
		if (selectedIds.size === 0) return;
		bulkLoading = action;
		try {
			await fetch('/api/email/bulk', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ ids: [...selectedIds], action, sourceMailboxId: mailboxId })
			});
			selectedIds = new Set();
			await invalidateAll();
		} finally { bulkLoading = ''; }
	}

	async function refresh() { await invalidateAll(); }

	// Stale-while-revalidate for the reading pane: the previous message (or
	// a cached copy of the clicked one) stays visible while the fresh detail
	// loads, so switching messages never blanks the pane. The request id
	// guards against out-of-order responses on rapid clicks.
	const previewCache = new Map<string, Email>();
	let previewReqId = 0;

	let previewSelectedId = $state<string | null>(null);

	async function handlePaneClick(email: Email) {
		const reqId = ++previewReqId;
		previewSelectedId = email.id;
		const cached = previewCache.get(email.id);
		if (cached) previewEmail = cached;
		loadingPreview = true;
		try {
			const res = await fetch(`/api/email/${email.id}/detail`);
			if (res.ok && reqId === previewReqId) {
				const detail = (await res.json()) as Email;
				previewCache.set(email.id, detail);
				previewEmail = detail;
			}
		} finally {
			if (reqId === previewReqId) loadingPreview = false;
		}
	}

	// The open message's place (its tab, its labels, read or starred) follows
	// the list as the list refreshes. The pane holds its own copy, fetched
	// when the row was clicked, so without this a tab Jev chose a few seconds
	// later, or a move to another tab, never reached it: the list changed and
	// the message beside it didn't. A row still in the list carries what is
	// needed; one that left it (moved to another tab, say) is read again.
	// Only keywords and mailboxIds are taken, so the body isn't redrawn.
	type Place = Pick<Email, 'keywords' | 'mailboxIds'>;
	function takePlace(target: Email, from: Place) {
		target.keywords = { ...from.keywords };
		target.mailboxIds = { ...from.mailboxIds };
	}
	$effect(() => {
		const rows = new Map(emails.map((e) => [e.id, e]));
		untrack(() => {
			for (const [id, cached] of previewCache) {
				const row = rows.get(id);
				if (row) takePlace(cached, row);
				else if (id !== previewEmail?.id) previewCache.delete(id);
			}
			const open = previewEmail;
			if (!open) return;
			const row = rows.get(open.id);
			if (row) {
				takePlace(open, row);
				return;
			}
			void fetch(`/api/email/${open.id}/detail`)
				.then((res) => (res.ok ? (res.json() as Promise<Email>) : null))
				.then((fresh) => {
					if (fresh?.keywords && fresh.mailboxIds && previewEmail?.id === open.id) {
						takePlace(previewEmail, fresh);
						previewCache.set(open.id, fresh);
					}
				})
				.catch(() => {});
		});
	});

	// Warm the server-side avatar cache for this page's senders so the
	// background worker resolves them before the user scrolls. Deduped across
	// renders so navigating / invalidateAll doesn't re-post the same addresses.
	const prefetchedSenders = new Set<string>();
	$effect(() => {
		if (!browser) return;
		const fresh: string[] = [];
		for (const e of emails) {
			const addr = e.from?.[0]?.email?.trim().toLowerCase();
			if (addr && !prefetchedSenders.has(addr)) {
				prefetchedSenders.add(addr);
				fresh.push(addr);
			}
		}
		if (fresh.length === 0) return;
		void fetch('/api/avatar/prefetch', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ emails: fresh })
		}).catch(() => {});
	});
</script>

<div class="h-full flex overflow-hidden" bind:clientWidth={rowWidth}>
	<!-- Email list column -->
	<div class="flex flex-col shrink-0 min-w-0 overflow-hidden max-md:w-full! max-md:flex-1"
		style={paneOpen ? `width: ${listPx}px` : 'flex: 1 1 0%; min-width: 0'}>
		<!-- 48px, the height of every pane's top bar, so this lines up with the
		     reading pane's toolbar across the divider. -->
		<header class="@container ribbon h-12 px-4 border-b border-border flex items-center gap-2 shrink-0">
			{#if selectedIds.size > 0}
				<div class="w-8 flex justify-center shrink-0">
						<div
							class="w-5 h-5 rounded-md border-2 flex items-center justify-center cursor-pointer transition-colors
								{allSelected ? 'bg-accent border-accent' : 'border-text-tertiary hover:border-text-secondary'}"
							onclick={toggleAll}
							onkeydown={(e) => e.key === ' ' && toggleAll()}
							role="checkbox"
							aria-checked={allSelected}
							tabindex={0}
						>
							{#if allSelected}
								<Icon name="check" size={14} />
							{/if}
						</div>
				</div>
				<!-- Just the count when the column is narrow, so the actions fit. -->
				<span class="text-sm text-text-secondary whitespace-nowrap">{selectedIds.size}<span class="sr-only @md:not-sr-only"> selected</span></span>
				<div class="flex items-center gap-1 ml-2">
					<button onclick={() => bulkAction('markRead')} title="Mark Read" disabled={!!bulkLoading} class="p-1.5 rounded-md hover:bg-surface-hover text-text-secondary hover:text-text transition-colors cursor-pointer disabled:opacity-50">
						<Icon name="mark-read" size={16} />
					</button>
					<button onclick={() => bulkAction('markUnread')} title="Mark Unread" disabled={!!bulkLoading} class="p-1.5 rounded-md hover:bg-surface-hover text-text-secondary hover:text-text transition-colors cursor-pointer disabled:opacity-50">
						<Icon name="mark-unread" size={16} />
					</button>
					<button
						bind:this={moveTriggerEl}
						onclick={(e) => { e.stopPropagation(); showMovePicker = !showMovePicker; }}
						title="Move to…"
						disabled={!!bulkLoading}
						class="p-1.5 rounded-md hover:bg-surface-hover transition-colors cursor-pointer disabled:opacity-50
							{showMovePicker ? 'text-accent-fg bg-accent/10' : 'text-text-secondary hover:text-text'}"
					>
						<Icon name="move-to-folder" size={16} />
					</button>
					{#if showMovePicker}
						<MailboxPicker
							{mailboxes}
							labels={allLabels}
							excludeIds={mailboxId ? [mailboxId] : []}
							anchor={moveTriggerEl ?? null}
							align="left"
							onMove={bulkMoveTo}
							onAddLabel={bulkMoveTo}
							onClose={() => { showMovePicker = false; }}
						/>
					{/if}
					{#if inboxTabs}
						<button
							bind:this={categoryTriggerEl}
							onclick={(e) => { e.stopPropagation(); showCategoryPicker = !showCategoryPicker; }}
							title="Move to tab…"
							aria-label="Move to tab"
							aria-haspopup="menu"
							aria-expanded={showCategoryPicker}
							disabled={!!bulkLoading}
							class="p-1.5 rounded-md hover:bg-surface-hover transition-colors cursor-pointer disabled:opacity-50
								{showCategoryPicker ? 'text-accent-fg bg-accent/10' : 'text-text-secondary hover:text-text'}"
						>
							<Icon name="move-to-tab" size={16} />
						</button>
						{#if showCategoryPicker}
							<CategoryPicker
								current={inboxTabs.active}
								anchor={categoryTriggerEl ?? null}
								align="left"
								onPick={bulkMoveToCategory}
								onClose={() => { showCategoryPicker = false; }}
							/>
						{/if}
					{/if}
					<button onclick={() => bulkAction('archive')} title="Archive" disabled={!!bulkLoading} class="p-1.5 rounded-md hover:bg-surface-hover text-text-secondary hover:text-text transition-colors cursor-pointer disabled:opacity-50">
						<Icon name="archive" size={16} />
					</button>
					<button onclick={() => bulkAction('trash')} title="Trash" disabled={!!bulkLoading} class="p-1.5 rounded-md hover:bg-surface-hover text-text-secondary hover:text-danger transition-colors cursor-pointer disabled:opacity-50">
						<Icon name="delete" size={16} />
					</button>
					<button onclick={() => bulkAction('spam')} title="Spam" disabled={!!bulkLoading} class="p-1.5 rounded-md hover:bg-surface-hover text-text-secondary hover:text-text transition-colors cursor-pointer disabled:opacity-50">
						<Icon name="spam" size={16} />
					</button>
				</div>
				<div class="flex-1"></div>
				<button onclick={clearSelection} class="btn btn-ghost btn-sm">
					Cancel
				</button>
			{:else}
				<div class="w-8 flex justify-center shrink-0">
						<div
							class="w-5 h-5 rounded-md border-2 flex items-center justify-center cursor-pointer transition-colors border-text-tertiary hover:border-text-secondary"
							onclick={toggleAll}
							onkeydown={(e) => e.key === ' ' && toggleAll()}
							role="checkbox"
							aria-checked={false}
							tabindex={0}
						></div>
				</div>
				<!-- The count is in the pager at the foot of the list. -->
				<span class="text-sm font-medium text-text">{title}</span>
				<div class="flex-1"></div>
				{#if showFilters}
					<ListFilterBar />
				{/if}
				<button onclick={() => readingPane.toggle()} title="Toggle reading pane"
					class="max-md:hidden p-1.5 rounded-md hover:bg-surface-hover transition-colors cursor-pointer {paneOpen ? 'text-accent-fg' : 'text-text-secondary hover:text-text'}">
					<Icon name="reading-pane" size={16} />
				</button>
				<button onclick={refresh} title="Refresh" class="p-1.5 rounded-md hover:bg-surface-hover text-text-secondary hover:text-text transition-colors cursor-pointer">
					<Icon name="refresh" size={16} />
				</button>
			{/if}
		</header>

		{#if inboxTabs}
			<InboxTabs tabs={inboxTabs} />
		{/if}

		<!-- Clipped sideways rather than scrolling (overflow-y alone would make
		     that auto), so the slide between tabs can't flash a horizontal
		     scrollbar. -->
		<div bind:this={listScroller} class="flex-1 overflow-y-auto overflow-x-hidden">
			<!-- What slides when you switch tabs, inside the scroller, so the
			     scrollbar stays put. At least as tall as the scroller so the empty
			     state can still centre itself in it, and as tall as the list
			     otherwise, so the date headers stick all the way down. -->
			<div bind:this={listBody} class="min-h-full flex flex-col">
				{#if emails.length === 0}
					<div class="flex-1 grid place-items-center px-6 text-center">
						<div class="max-w-xs">
							<div class="w-12 h-12 mx-auto mb-3 rounded-2xl bg-surface-hover grid place-items-center text-text-tertiary">
								<Icon name="inbox" size={20} />
							</div>
							<p class="text-sm font-medium text-text">{emptyTitle}</p>
						</div>
					</div>
				{:else}
					<!-- No date headings: each row carries its own date (see
					     list-date), today's as the time it arrived. -->
					{#each emails as email (email.id)}
						<EmailListItem
							{email}
							selected={selectedIds.has(email.id)}
							onSelect={toggleSelect}
							onClick={paneOpen ? handlePaneClick : undefined}
							onDragStart={handleRowDragStart}
							active={paneOpen && (previewSelectedId ?? previewEmail?.id) === email.id}
						/>
					{/each}
				{/if}
			</div>
		</div>

		{#if total > 0}
			<footer class="flex items-center justify-between h-10 px-4 border-t border-border text-xs text-text-tertiary shrink-0">
				<span class="tabular-nums">{rangeStart}–{rangeEnd} of {total.toLocaleString()}</span>
				<!-- Just previous / next beside the range: the range already says
				     where you are, so "Page 1 of 14" and jump-to-ends buttons were
				     the same information twice. -->
				<div class="flex items-center gap-0.5">
					<button
						onclick={() => goToPage(currentPage - 1)}
						disabled={currentPage === 1}
						class="p-1.5 rounded-md hover:bg-surface-hover hover:text-text disabled:opacity-40 disabled:hover:bg-transparent disabled:cursor-not-allowed cursor-pointer"
						title="Newer"
						aria-label="Previous page"
					>
						<Icon name="previous" size={16} />
					</button>
					<button
						onclick={() => goToPage(currentPage + 1)}
						disabled={currentPage >= totalPages}
						class="p-1.5 rounded-md hover:bg-surface-hover hover:text-text disabled:opacity-40 disabled:hover:bg-transparent disabled:cursor-not-allowed cursor-pointer"
						title="Older"
						aria-label="Next page"
					>
						<Icon name="next" size={16} />
					</button>
				</div>
			</footer>
		{/if}
	</div>

	{#if paneOpen}
		<!-- Drag to share the room between the list and the reading pane;
		     arrow keys when focused, a double-click for the default. A hairline,
		     with a wider grab area (the ::before) over both sides. -->
		<!-- A focusable separator is ARIA's window splitter: an interactive control. -->
		<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
		<div
			role="separator"
			aria-orientation="vertical"
			aria-label="Resize the message list"
			aria-valuemin={LIST_WIDTH.min}
			aria-valuemax={LIST_WIDTH.max}
			aria-valuenow={listPx}
			tabindex="0"
			class="max-md:hidden relative z-10 w-px shrink-0 outline-none cursor-col-resize touch-none transition-colors
				before:absolute before:inset-y-0 before:-left-1 before:-right-1 before:content-['']
				{dragging ? 'bg-accent' : 'bg-border hover:bg-accent/70 focus-visible:bg-accent'}"
			onpointerdown={startDrag}
			onkeydown={(e) => {
				if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
				listWidth.set(listPx);
				nudgeWidth(e, listWidth, LIST_WIDTH, listRoom());
			}}
			ondblclick={() => listWidth.reset()}
		></div>

		<div class="max-md:hidden flex-1 overflow-hidden min-w-0 flex flex-col relative">
			{#if loadingPreview}
				<!-- Thin indeterminate bar — the current message stays visible
				     underneath while the next one loads. -->
				<div class="absolute top-0 left-0 right-0 h-0.5 bg-accent/70 animate-pulse z-20"></div>
			{/if}
			{#if previewEmail}
				{#key previewEmail.id}
					<EmailDetail
						email={previewEmail}
						compact
						onRemoved={() => {
							previewEmail = null;
							previewSelectedId = null;
						}}
					/>
				{/key}
			{:else if loadingPreview}
				<div class="flex items-center justify-center h-full text-text-tertiary text-sm">Loading…</div>
			{:else}
				<div class="h-full grid place-items-center px-6 text-center">
					<div>
						<div class="w-12 h-12 mx-auto mb-3 rounded-2xl bg-surface-hover grid place-items-center text-text-tertiary">
							<Icon name="mail" size={20} />
						</div>
						<p class="text-sm font-medium text-text">No message selected</p>
					</div>
				</div>
			{/if}
		</div>
	{/if}
</div>
