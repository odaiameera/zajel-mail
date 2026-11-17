<script lang="ts">
	import Icon from '$lib/components/Icon.svelte';
	import EmailDetail from './EmailDetail.svelte';
	import SenderAvatar from './SenderAvatar.svelte';
	import MailboxPicker from './MailboxPicker.svelte';
	import { getContext, onMount, tick, untrack } from 'svelte';
	import { goto, invalidateAll } from '$app/navigation';
	import { page } from '$app/state';
	import type { Email, Mailbox } from '$lib/jmap/types';
	import type { OpenThread } from '$lib/jmap/threads';
	import { LABELS_CONTEXT, type Label, type LabelsContext } from '$lib/types/labels';
	import { actionIds, expandedByDefault, foldedRuns, summariseThread, type ThreadScope } from '$lib/threads';
	import { formatFullDate, formatListDate } from '$lib/utils/list-date';
	import { now } from '$lib/stores/now';
	import { showToast } from '$lib/stores/toast';

	/**
	 * An open conversation: the messages of one thread, oldest first, under
	 * one subject. See docs/conversations-plan.md for the behaviour.
	 *
	 * Each open message is the ordinary message view (EmailDetail) in its
	 * embedded mode, so everything a message can show outside a conversation
	 * (attachments, an invitation, a sign-in code, blocked pictures) it shows
	 * inside one. This component is what is around them: the header, the
	 * folded lines, and the actions that take the conversation as a whole.
	 */
	let {
		thread,
		focusId = null,
		compact = false,
		onRemoved
	}: {
		thread: OpenThread;
		/** The message that was asked for (a search result, a link); it opens expanded. */
		focusId?: string | null;
		compact?: boolean;
		/** Reading pane: the conversation left the list (archived, trashed, moved). */
		onRemoved?: () => void;
	} = $props();

	const mailboxes = $derived<Mailbox[]>(page.data.mailboxes ?? []);
	const labelsContext = getContext<LabelsContext | undefined>(LABELS_CONTEXT);
	const allLabels: Label[] = $derived(labelsContext?.current ?? []);
	const getListMailboxId = getContext<(() => string) | undefined>('listMailboxId');
	const getListIsTrash = getContext<(() => boolean) | undefined>('listIsTrash');

	// Messages sent to Trash from here, gone before the list has caught up.
	let removed = $state(new Set<string>());
	const messages = $derived(thread.messages.filter((m) => !removed.has(m.id)));

	// The whole of each message that has been opened. Seeded with what came
	// with the conversation; the rest are read when their line is clicked.
	// Kept across refreshes of `thread`, so an open message isn't redrawn
	// (and its pictures reloaded) each time the list behind it reloads: only
	// where it is filed and what it is marked with are taken from the new copy.
	let details = $state<Record<string, Email>>({});
	let expanded = $state(new Set<string>());
	let loading = $state(new Set<string>());
	let known = new Set<string>();
	let unfolded = $state(false);

	$effect(() => {
		const incoming = thread;
		untrack(() => {
			const first = known.size === 0;
			for (const [id, detail] of Object.entries(incoming.details)) {
				if (!details[id]) details[id] = detail;
			}
			for (const message of incoming.messages) {
				const mine = details[message.id];
				if (mine) {
					mine.keywords = { ...message.keywords };
					mine.mailboxIds = { ...message.mailboxIds };
				}
			}
			if (first) {
				expanded = expandedByDefault(incoming.messages, focusId);
			} else {
				// A reply that arrived while the conversation was open opens itself.
				const fresh = incoming.messages.filter((m) => !known.has(m.id));
				if (fresh.length > 0) expanded = new Set([...expanded, ...fresh.map((m) => m.id)]);
			}
			known = new Set(incoming.messages.map((m) => m.id));
			// One that is to be open but came without its body: read it.
			for (const id of expanded) if (!details[id]) void load(id);
		});
	});

	async function load(id: string) {
		if (details[id] || loading.has(id)) return;
		loading = new Set([...loading, id]);
		try {
			const res = await fetch(`/api/email/${id}/detail`);
			if (res.ok) details[id] = (await res.json()) as Email;
			else showToast({ message: 'That message could not be opened' });
		} catch {
			showToast({ message: 'Network error' });
		} finally {
			const next = new Set(loading);
			next.delete(id);
			loading = next;
		}
	}

	function toggle(id: string) {
		const next = new Set(expanded);
		if (next.has(id)) next.delete(id);
		else {
			next.add(id);
			void load(id);
		}
		expanded = next;
	}

	const allOpen = $derived(messages.every((m) => expanded.has(m.id)));
	function setAll(open: boolean) {
		unfolded = true;
		expanded = open ? new Set(messages.map((m) => m.id)) : new Set();
		if (open) for (const m of messages) void load(m.id);
	}

	// A long run of read messages folds its middle into one line.
	const folds = $derived(unfolded ? [] : foldedRuns(messages, expanded));
	type Item = { kind: 'message'; message: Email } | { kind: 'fold'; count: number };
	const items = $derived.by<Item[]>(() => {
		const out: Item[] = [];
		messages.forEach((message, i) => {
			const fold = folds.find(([start, end]) => i >= start && i < end);
			if (!fold) out.push({ kind: 'message', message });
			else if (i === fold[0]) out.push({ kind: 'fold', count: fold[1] - fold[0] });
		});
		return out;
	});

	// --- What the conversation is ---

	const first = $derived(messages[0]);
	const last = $derived(messages[messages.length - 1]);
	const isDraft = (m: Email) => '$draft' in m.keywords;
	const isUnread = (m: Email) => !('$seen' in m.keywords) && !isDraft(m);
	// The last message that was actually sent or received: what Reply answers.
	const lastSent = $derived([...messages].reverse().find((m) => !isDraft(m)) ?? null);

	const roleId = (role: string) => mailboxes.find((m) => m.role === role)?.id ?? null;
	// Which mailbox the conversation is being read in, for the actions that
	// take only what is there (Archive, Move, Spam): the list beside it, or
	// opened by itself, the Inbox if any of it is there, else wherever the
	// message asked for is filed.
	const hereId = $derived.by<string | null>(() => {
		const listed = getListMailboxId?.();
		if (listed) return listed;
		const inbox = roleId('inbox');
		if (inbox && messages.some((m) => m.mailboxIds[inbox])) return inbox;
		const asked = messages.find((m) => m.id === focusId) ?? last;
		const labelIds = new Set(allLabels.map((l) => l.id));
		return Object.keys(asked?.mailboxIds ?? {}).find((id) => !labelIds.has(id)) ?? null;
	});
	const scope = $derived<ThreadScope>({
		hereId,
		trashId: roleId('trash'),
		junkId: roleId('junk'),
		draftsId: roleId('drafts')
	});
	const summary = $derived(summariseThread(thread.threadId, messages, scope));
	const anyUnread = $derived(summary.unreadIds.length > 0);
	const inTrash = $derived(!!scope.trashId && hereId === scope.trashId);
	const inJunk = $derived(!!scope.junkId && hereId === scope.junkId);
	// Trash deletes for good only when the conversation was opened from the Trash list.
	const trashIsPermanent = $derived(
		getListIsTrash ? getListIsTrash() : page.url.searchParams.get('from') === 'trash'
	);
	const appliedLabels = $derived(allLabels.filter((l) => summary.mailboxIds[l.id] === true));

	const here = $derived(mailboxes.find((m) => m.id === hereId));
	const backHref = $derived(!here || here.role === 'inbox' ? '/inbox' : `/folder/${here.id}`);
	const backLabel = $derived(here?.name ?? 'Inbox');

	function textColorForBg(hex: string): string {
		const r = parseInt(hex.slice(1, 3), 16);
		const g = parseInt(hex.slice(3, 5), 16);
		const b = parseInt(hex.slice(5, 7), 16);
		return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.55 ? '#000000' : '#ffffff';
	}

	// --- Actions on the whole conversation ---

	let busy = $state('');
	let showMovePicker = $state(false);
	let moveTriggerEl = $state<HTMLButtonElement | undefined>();

	/**
	 * Whether the action closes the conversation: it has left the list it was
	 * being read in, or (Mark unread) it is being put back for later, and
	 * staying on screen would only mark it read again.
	 */
	const LEAVES = new Set(['archive', 'trash', 'spam', 'notSpam', 'moveTo', 'markUnread']);

	// `as`: what the server is asked to do, when it differs from what the
	// action is here. A label is added through "moveTo" (the server tells a
	// label from a folder), but it reaches every message and moves none.
	async function act(action: string, extra: Record<string, unknown> = {}, as = action) {
		if (busy) return;
		const ids = actionIds(summary, action);
		if (ids.length === 0) return;
		busy = action;
		try {
			const res = await fetch('/api/email/bulk', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ ids, action: as, ...extra, ...(action === 'trash' && trashIsPermanent ? { permanent: true } : {}) })
			});
			const data = (await res.json().catch(() => ({}))) as { failed?: unknown[]; error?: string };
			if (!res.ok || (data.failed?.length ?? 0) > 0) {
				showToast({ message: data.error ?? 'Some of the conversation couldn’t be changed. Try again.' });
			}
			if (LEAVES.has(action) && res.ok) {
				if (onRemoved) {
					await invalidateAll();
					onRemoved();
				} else {
					await goto(backHref);
				}
			} else {
				await invalidateAll();
			}
		} catch {
			showToast({ message: 'Network error' });
		} finally {
			busy = '';
		}
	}

	async function moveTo(targetMailboxId: string) {
		showMovePicker = false;
		await act('moveTo', { targetMailboxId });
	}

	async function addLabel(labelId: string) {
		showMovePicker = false;
		await act('label', { targetMailboxId: labelId }, 'moveTo');
	}

	/** One message changed from its own buttons. */
	function messageChanged(id: string, action: string) {
		if (action !== 'trash') return;
		removed = new Set([...removed, id]);
		// The last of it: nothing left to show.
		if (thread.messages.every((m) => removed.has(m.id))) {
			if (onRemoved) onRemoved();
			else void goto(backHref);
		}
	}

	// --- Reply, at the end of the conversation ---

	let views = $state<Record<string, EmailDetail | undefined>>({});

	async function answer(kind: 'reply' | 'replyAll' | 'forward') {
		const target = lastSent;
		if (!target) return;
		if (!expanded.has(target.id)) {
			expanded = new Set([...expanded, target.id]);
			await load(target.id);
		}
		// Its view mounts once its body has arrived.
		for (let i = 0; i < 40 && !views[target.id]; i++) await new Promise((r) => setTimeout(r, 50));
		await tick();
		const view = views[target.id];
		if (!view) return;
		if (kind === 'forward') view.forwardThis();
		else view.replyToThis(kind === 'replyAll');
	}

	// --- Where it opens ---

	// At the first unread message, or the last one: what there is to read.
	let scroller = $state<HTMLElement>();
	let cards = $state<Record<string, HTMLElement | undefined>>({});
	onMount(() => {
		const target = messages.find((m) => isUnread(m))?.id ?? (focusId && messages.some((m) => m.id === focusId) ? focusId : last?.id);
		if (!target || target === first?.id) return;
		// After the first layout, and again once the messages above have
		// taken their real height (each is a frame sized after it loads).
		const settle = () => {
			const card = cards[target];
			if (!card || !scroller) return;
			// Just under the subject, which stays at the top.
			const head = scroller.querySelector('header')?.getBoundingClientRect().height ?? 0;
			scroller.scrollTop = Math.max(0, card.offsetTop - head - 4);
		};
		const timers = [0, 150, 500].map((ms) => setTimeout(settle, ms));
		return () => timers.forEach(clearTimeout);
	});

	const preview = (m: Email) => (!m.preview || /^[A-Z_]+$/.test(m.preview.trim()) ? '' : m.preview);
	const senderName = (m: Email) => m.from?.[0]?.name || m.from?.[0]?.email || 'Unknown';
</script>

<div class="h-full flex flex-col relative overflow-hidden">
	<!-- Ribbon: the same height and place as a single message's, so the pane's
	     top bar doesn't move between a message and a conversation. What is on
	     it acts on the conversation as a whole. -->
	<div class="flex items-center justify-between h-12 shrink-0 border-b border-border {compact ? 'px-4' : 'px-6 max-md:px-2'}">
		<div class="flex items-center gap-1 min-w-0">
			{#if !compact}
				<a href={backHref} class="btn btn-ghost btn-sm -ml-2 mr-1" title="Back to {backLabel}">
					<Icon name="back" size={14} />
					{backLabel}
				</a>
				<span class="w-px h-4 bg-border mr-1" aria-hidden="true"></span>
			{/if}
			<button type="button" onclick={() => answer('reply')} title="Reply" aria-label="Reply" class="tool" disabled={!lastSent}>
				<Icon name="reply" size={16} />
			</button>
			<button type="button" onclick={() => answer('replyAll')} title="Reply all" aria-label="Reply all" class="tool" disabled={!lastSent}>
				<Icon name="reply-all" size={16} />
			</button>
			<button type="button" onclick={() => answer('forward')} title="Forward" aria-label="Forward" class="tool" disabled={!lastSent}>
				<Icon name="forward" size={16} />
			</button>
		</div>
		<div class="flex items-center gap-1">
			<button
				type="button"
				onclick={() => setAll(!allOpen)}
				title={allOpen ? 'Collapse all' : 'Expand all'}
				aria-label={allOpen ? 'Collapse all messages' : 'Expand all messages'}
				class="tool"
			>
				<Icon name={allOpen ? 'collapse-all' : 'expand-all'} size={16} />
			</button>
			<span class="w-px h-4 bg-border mx-0.5" aria-hidden="true"></span>
			<button
				type="button"
				onclick={() => act(anyUnread ? 'markRead' : 'markUnread')}
				title={anyUnread ? 'Mark as read' : 'Mark as unread'}
				aria-label={anyUnread ? 'Mark conversation as read' : 'Mark conversation as unread'}
				class="tool"
				disabled={!!busy}
			>
				<Icon name={anyUnread ? 'mark-read' : 'mark-unread'} size={16} />
			</button>
			<button
				bind:this={moveTriggerEl}
				type="button"
				onclick={(e) => { e.stopPropagation(); showMovePicker = !showMovePicker; }}
				title="Move conversation to…"
				aria-label="Move conversation"
				class="tool {showMovePicker ? 'text-accent-fg bg-accent/10' : ''}"
				disabled={!!busy}
			>
				<Icon name="move-to-folder" size={16} />
			</button>
			{#if showMovePicker}
				<MailboxPicker
					{mailboxes}
					labels={allLabels}
					excludeIds={hereId ? [hereId] : []}
					appliedLabelIds={appliedLabels.map((l) => l.id)}
					anchor={moveTriggerEl ?? null}
					align="right"
					onMove={moveTo}
					onAddLabel={addLabel}
					onClose={() => { showMovePicker = false; }}
				/>
			{/if}
			{#if !inTrash}
				<button type="button" onclick={() => act('archive')} title="Archive conversation" aria-label="Archive conversation" class="tool" disabled={!!busy}>
					<Icon name="archive" size={16} />
				</button>
			{/if}
			{#if inJunk}
				<button type="button" onclick={() => act('notSpam')} title="Not spam — move back to the Inbox" aria-label="Not spam" class="tool" disabled={!!busy}>
					<Icon name="not-spam" size={16} />
				</button>
			{:else}
				<button type="button" onclick={() => act('spam')} title="Mark conversation as spam" aria-label="Mark conversation as spam" class="tool" disabled={!!busy}>
					<Icon name="spam" size={16} />
				</button>
			{/if}
			<button
				type="button"
				onclick={() => act('trash')}
				title={trashIsPermanent ? 'Delete conversation for good' : 'Move conversation to Trash'}
				aria-label={trashIsPermanent ? 'Delete conversation for good' : 'Move conversation to Trash'}
				class="tool hover:text-danger"
				disabled={!!busy}
			>
				<Icon name="delete" size={16} />
			</button>
		</div>
	</div>

	<div bind:this={scroller} class="flex-1 min-h-0 overflow-y-auto">
		<!-- The subject, once, for every message under it. -->
		<!-- It stays at the top as the messages scroll under it, so a long
		     conversation never loses its name. -->
		<header class="sticky top-0 z-10 bg-bg/95 backdrop-blur-sm {compact ? 'px-4 pt-3 pb-2' : 'px-6 pt-4 pb-3 max-md:px-4'}">
			<div class="flex flex-wrap items-center gap-x-2 gap-y-1">
				<h1 class="min-w-0 font-semibold leading-snug text-text [text-wrap:balance] {compact ? 'text-base' : 'text-lg'}">
					{first?.subject || '(no subject)'}
				</h1>
				<span class="shrink-0 rounded-full bg-surface-hover px-2 py-0.5 text-xs tabular-nums text-text-secondary" title="{messages.length} messages in this conversation">
					{messages.length}
				</span>
				{#each appliedLabels as label (label.id)}
					<span class="rounded-sm px-1.5 py-0.5 text-2xs font-medium leading-none" style="background-color: {label.color}; color: {textColorForBg(label.color)}">{label.name}</span>
				{/each}
			</div>
			{#if thread.binned > 0}
				<p class="mt-1 text-xs text-text-tertiary">
					{thread.binned === 1 ? 'One message' : `${thread.binned} messages`} of this conversation {thread.binned === 1 ? 'is' : 'are'} in Trash or Junk and not shown.
				</p>
			{/if}
		</header>

		<ol class="{compact ? 'px-2 pb-3' : 'px-4 pb-4 max-md:px-1'} flex flex-col gap-2" aria-label="Messages in this conversation">
			{#each items as item (item.kind === 'message' ? item.message.id : 'fold')}
				{#if item.kind === 'fold'}
					<li>
						<button
							type="button"
							onclick={() => (unfolded = true)}
							class="group flex w-full items-center gap-3 px-3 py-1 cursor-pointer"
							aria-label="Show {item.count} earlier messages"
						>
							<span class="h-px flex-1 bg-border"></span>
							<span class="rounded-full border border-border bg-surface px-3 py-1 text-xs text-text-secondary group-hover:border-text-tertiary group-hover:text-text">
								{item.count} earlier messages
							</span>
							<span class="h-px flex-1 bg-border"></span>
						</button>
					</li>
				{:else}
					{@const message = item.message}
					{@const open = expanded.has(message.id)}
					{@const detail = details[message.id]}
					<li
						bind:this={cards[message.id]}
						class="rounded-lg border bg-bg transition-colors {open ? 'border-border' : 'border-transparent hover:bg-surface-hover'}"
					>
						{#if open && detail}
							<EmailDetail
								bind:this={views[message.id]}
								email={detail}
								{compact}
								embedded
								onCollapse={() => toggle(message.id)}
								onChanged={(action) => messageChanged(message.id, action)}
							/>
						{:else}
							<!-- Folded: one line says who, what and when. -->
							<button
								type="button"
								onclick={() => toggle(message.id)}
								aria-expanded="false"
								class="flex w-full items-center gap-3 px-3 py-2 text-left cursor-pointer"
							>
								<SenderAvatar email={message.from?.[0]?.email} name={message.from?.[0]?.name} size={28} />
								<span class="min-w-0 flex-1">
									<span class="flex items-baseline gap-2">
										<span class="truncate text-sm {isUnread(message) ? 'font-semibold text-text' : 'text-text-secondary'}">{senderName(message)}</span>
										{#if isDraft(message)}
											<span class="shrink-0 text-xs font-medium text-danger">Draft</span>
										{/if}
										{#if message.hasAttachment}
											<Icon name="attachment" size={12} class="shrink-0 text-text-tertiary" aria-label="Has attachment" />
										{/if}
									</span>
									<span class="block truncate text-xs text-text-tertiary">{preview(message)}</span>
								</span>
								{#if open && loading.has(message.id)}
									<Icon name="loading" size={14} class="shrink-0 animate-spin text-text-tertiary" />
								{/if}
								<time
									datetime={message.receivedAt}
									title={formatFullDate(message.receivedAt)}
									class="shrink-0 text-xs tabular-nums text-text-tertiary"
								>
									{formatListDate(message.receivedAt, $now)}
								</time>
							</button>
						{/if}
					</li>
				{/if}
			{/each}
		</ol>

		<!-- The end of the conversation: answer its last message. -->
		{#if lastSent}
			<div class="flex flex-wrap items-center gap-2 {compact ? 'px-4 pb-6' : 'px-6 pb-8 max-md:px-4'}">
				<button type="button" onclick={() => answer('reply')} class="btn btn-secondary">
					<Icon name="reply" size={14} />
					Reply
				</button>
				<button type="button" onclick={() => answer('replyAll')} class="btn btn-secondary">
					<Icon name="reply-all" size={14} />
					Reply all
				</button>
				<button type="button" onclick={() => answer('forward')} class="btn btn-secondary">
					<Icon name="forward" size={14} />
					Forward
				</button>
			</div>
		{/if}
	</div>
</div>

<style>
	.tool {
		padding: 0.375rem;
		border-radius: 0.375rem;
		color: var(--color-text-secondary);
		cursor: pointer;
		transition: color 150ms, background-color 150ms;
	}
	.tool:hover:not(:disabled) {
		background: var(--color-surface-hover);
		color: var(--color-text);
	}
	.tool:disabled {
		opacity: 0.5;
		cursor: default;
	}
</style>
