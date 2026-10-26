<script lang="ts">
	import Icon from '$lib/components/Icon.svelte';
	import { tick } from 'svelte';

	type AgentAction =
		| 'chat'
		| 'summarize_today'
		| 'calendar_tomorrow'
		| 'summarize_current'
		| 'propose_task'
		| 'propose_event';
	type TaskProvider = 'todoist' | 'linear' | 'notion' | 'webhook';

	type SessionSummary = {
		id: string;
		title: string;
		createdAt: number;
		updatedAt: number;
		messageCount: number;
	};

	type CalendarProposal = {
		action: 'create' | 'delete';
		summary: string;
		event: {
			title: string;
			start: string;
			end: string;
			allDay: boolean;
			timeZone: string;
			location: string;
			description: string;
			calendarId: string | null;
		} | null;
		target: { id: string; title: string; start: string } | null;
	};

	type TaskProposal = {
		title: string;
		description: string;
		dueDate: string | null;
		destination: 'todoist' | 'linear' | 'notion' | null;
	};

	type ChatMessage = {
		id: string;
		role: 'assistant' | 'user';
		content: string;
		/** Sanitised HTML for assistant replies; plain `content` is the fallback. */
		html?: string;
		proposal?: TaskProposal;
		taskProviders?: TaskProvider[];
		selectedProvider?: TaskProvider;
		taskStatus?: 'creating' | 'created' | 'failed';
		calendarProposal?: CalendarProposal;
		calendarStatus?: 'applying' | 'applied' | 'failed';
		link?: string;
	};

	let {
		open,
		aiEnabled,
		currentEmailId = null,
		onClose
	}: {
		open: boolean;
		aiEnabled: boolean;
		currentEmailId?: string | null;
		onClose: () => void;
	} = $props();

	let input = $state('');
	let busy = $state(false);
	let error = $state('');
	let scrollEl = $state<HTMLDivElement | undefined>(undefined);
	let sequence = 0;

	/**
	 * The server owns the transcript. This is null until the first reply comes
	 * back, which is when the session is created and named.
	 */
	let conversationId = $state<string | null>(null);
	let sessions = $state<SessionSummary[]>([]);
	let historyOpen = $state(false);
	let loadingHistory = $state(false);
	let retentionDays = $state(7);
	let messages = $state<ChatMessage[]>([]);

	const hasConversation = $derived(messages.some((message) => message.role === 'user'));

	// Starting points for an empty conversation, as plain prompts.
	const prompts = $derived<{ action: AgentAction; label: string; prompt: string }[]>([
		{ action: 'summarize_today', label: 'Summarize today’s mail', prompt: "Summarize today's email and highlight anything that needs my attention." },
		{ action: 'calendar_tomorrow', label: 'What’s on tomorrow?', prompt: 'Check my calendar for tomorrow and help me prepare.' },
		...(currentEmailId
			? [{ action: 'summarize_current' as AgentAction, label: 'Summarize this email', prompt: 'Summarize this email and tell me what I need to do.' }]
			: []),
		{ action: 'propose_task', label: 'Create a task', prompt: 'Create a task from this conversation and the relevant email context.' }
	]);

	function id(): string {
		sequence += 1;
		return `agent-${Date.now()}-${sequence}`;
	}

	function dayRange(offset: number): { start: string; end: string } {
		const start = new Date();
		start.setHours(0, 0, 0, 0);
		start.setDate(start.getDate() + offset);
		const end = new Date(start);
		end.setDate(end.getDate() + 1);
		return { start: start.toISOString(), end: end.toISOString() };
	}

	async function scrollToLatest() {
		await tick();
		scrollEl?.scrollTo({ top: scrollEl.scrollHeight, behavior: 'smooth' });
	}

	function relativeTime(timestamp: number): string {
		const minutes = Math.round((Date.now() - timestamp) / 60_000);
		if (minutes < 1) return 'just now';
		if (minutes < 60) return `${minutes}m ago`;
		const hours = Math.round(minutes / 60);
		if (hours < 24) return `${hours}h ago`;
		return `${Math.round(hours / 24)}d ago`;
	}

	async function loadSessions() {
		loadingHistory = true;
		try {
			const response = await fetch('/api/ai/conversations');
			const data = (await response.json().catch(() => null)) as {
				conversations?: SessionSummary[];
				retentionDays?: number;
			} | null;
			if (response.ok) {
				sessions = data?.conversations ?? [];
				retentionDays = data?.retentionDays ?? retentionDays;
			}
		} catch {
			// A history list that will not load should not break the chat
			// itself; the panel just shows no past sessions.
		} finally {
			loadingHistory = false;
		}
	}

	function startNewChat() {
		conversationId = null;
		historyOpen = false;
		error = '';
		messages = [];
	}

	async function openSession(sessionId: string) {
		historyOpen = false;
		error = '';
		busy = true;
		try {
			const response = await fetch(`/api/ai/conversations/${encodeURIComponent(sessionId)}`);
			const data = (await response.json().catch(() => null)) as {
				messages?: { id: string; role: 'user' | 'assistant'; content: string; html: string }[];
				error?: string;
			} | null;
			if (!response.ok) throw new Error(data?.error ?? 'That conversation could not be opened');

			conversationId = sessionId;
			messages = (data?.messages ?? []).map((message) => ({
				id: message.id,
				role: message.role,
				content: message.content,
				html: message.html || undefined
			}));
		} catch (err) {
			error = err instanceof Error ? err.message : 'That conversation could not be opened';
		} finally {
			busy = false;
			await scrollToLatest();
		}
	}

	async function removeSession(sessionId: string) {
		try {
			const response = await fetch(`/api/ai/conversations/${encodeURIComponent(sessionId)}`, {
				method: 'DELETE'
			});
			if (!response.ok) return;
			sessions = sessions.filter((session) => session.id !== sessionId);
			// Deleting the open session leaves the panel showing a transcript
			// that no longer exists, so reset to a fresh one.
			if (conversationId === sessionId) startNewChat();
		} catch {
			// Leave the row in place; a retry is one click away.
		}
	}

	// Refresh the session list whenever the panel is opened, so it reflects
	// conversations held in another tab or on another device.
	$effect(() => {
		if (open) void loadSessions();
	});

	async function ask(action: AgentAction, suggestedPrompt?: string) {
		const prompt = (suggestedPrompt ?? input).trim();
		if (busy || !prompt) return;

		messages = [...messages, { id: id(), role: 'user', content: prompt }];
		input = '';
		busy = true;
		error = '';
		await scrollToLatest();

		const today = dayRange(0);
		const tomorrow = dayRange(1);

		try {
			const response = await fetch('/api/ai/agent', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					action,
					message: prompt,
					// The transcript itself lives on the server; this only says
					// which one to continue.
					conversationId,
					currentEmailId,
					timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
					todayStart: today.start,
					todayEnd: today.end,
					tomorrowStart: tomorrow.start,
					tomorrowEnd: tomorrow.end
				})
			});
			const data = (await response.json().catch(() => null)) as {
				message?: string;
				html?: string;
				conversationId?: string;
				error?: string;
				taskProposal?: TaskProposal;
				taskProviders?: TaskProvider[];
				calendarProposal?: CalendarProposal;
			} | null;
			if (!response.ok || !data?.message) {
				throw new Error(data?.error ?? 'The mail agent could not answer');
			}
			const providers = data.taskProviders ?? [];
			const preferred = data.taskProposal?.destination ?? undefined;
			const selectedProvider =
				preferred && providers.includes(preferred) ? preferred : providers[0];
			// The first reply is what creates the session, so adopt the id the
			// server assigned and refresh the list it now appears in.
			if (data.conversationId && data.conversationId !== conversationId) {
				conversationId = data.conversationId;
			}
			messages = [
				...messages,
				{
					id: id(),
					role: 'assistant',
					content: data.message,
					html: data.html,
					proposal: data.taskProposal,
					calendarProposal: data.calendarProposal,
					taskProviders: providers,
					selectedProvider
				}
			];
			void loadSessions();
		} catch (err) {
			error = err instanceof Error ? err.message : 'The mail agent could not answer';
		} finally {
			busy = false;
			await scrollToLatest();
		}
	}

	/**
	 * Apply a calendar change. Nothing reaches the calendar until this runs,
	 * and it only runs from the button below the proposal.
	 */
	async function confirmCalendar(messageId: string, proposal: CalendarProposal) {
		messages = messages.map((message) =>
			message.id === messageId ? { ...message, calendarStatus: 'applying' } : message
		);
		error = '';
		try {
			const response = await fetch('/api/ai/calendar', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					confirmed: true,
					proposal,
					timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone
				})
			});
			const data = (await response.json().catch(() => null)) as {
				message?: string;
				error?: string;
			} | null;
			if (!response.ok) throw new Error(data?.error ?? 'The calendar change failed');

			messages = messages.map((message) =>
				message.id === messageId ? { ...message, calendarStatus: 'applied' } : message
			);
			messages = [
				...messages,
				{ id: id(), role: 'assistant', content: data?.message ?? 'Calendar updated.' }
			];
		} catch (err) {
			messages = messages.map((message) =>
				message.id === messageId ? { ...message, calendarStatus: 'failed' } : message
			);
			error = err instanceof Error ? err.message : 'The calendar change failed';
		} finally {
			await scrollToLatest();
		}
	}

	function selectProvider(messageId: string, provider: TaskProvider) {
		messages = messages.map((message) =>
			message.id === messageId ? { ...message, selectedProvider: provider } : message
		);
	}

	function providerLabel(provider: TaskProvider): string {
		if (provider === 'webhook') return 'Webhook';
		return provider[0].toUpperCase() + provider.slice(1);
	}

	async function createTask(messageId: string, proposal: TaskProposal, provider: TaskProvider) {
		messages = messages.map((message) =>
			message.id === messageId ? { ...message, taskStatus: 'creating' } : message
		);
		error = '';
		try {
			const response = await fetch('/api/ai/tasks', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ confirmed: true, task: proposal, provider })
			});
			const data = (await response.json().catch(() => null)) as {
				message?: string;
				error?: string;
				url?: string;
			} | null;
			if (!response.ok) throw new Error(data?.error ?? 'The task could not be created');
			messages = messages.map((message) =>
				message.id === messageId ? { ...message, taskStatus: 'created' } : message
			);
			messages = [
				...messages,
				{
					id: id(),
					role: 'assistant',
					content: data?.message ?? 'Task created.',
					link: data?.url
				}
			];
		} catch (err) {
			messages = messages.map((message) =>
				message.id === messageId ? { ...message, taskStatus: 'failed' } : message
			);
			error = err instanceof Error ? err.message : 'The task could not be created';
		} finally {
			await scrollToLatest();
		}
	}
</script>

<!--
	A card that opens above the bottom-right corner buttons (CornerActions),
	in the composer popup's style; on phones it fills the space between the
	header and the tab bar.

	z-[35] clears in-pane dropdowns (z-30) while staying under the composer
	backdrop (z-40). While closed, `pointer-events-none` and `inert` let clicks
	and focus reach whatever it covers.
-->
<aside
	aria-label="Zajel"
	aria-hidden={!open}
	inert={!open}
	class="fixed z-[35] overflow-hidden bg-bg origin-bottom-right transition-[opacity,transform] will-change-[opacity,transform]
		md:right-[var(--corner-window-right)] md:bottom-[var(--corner-window-bottom)] md:w-[var(--corner-window-width)] md:max-w-[calc(100vw-96px)] md:h-[var(--corner-window-height)] md:rounded-xl md:border md:border-border md:shadow-[0_16px_48px_rgba(0,0,0,0.5)]
		max-md:inset-x-0 max-md:top-[calc(3.5rem+env(safe-area-inset-top))] max-md:bottom-[calc(3.5rem+env(safe-area-inset-bottom)-var(--app-under))] max-md:border-t max-md:border-border
		{open
			? 'opacity-100 scale-100 duration-200 ease-[cubic-bezier(0.16,1,0.3,1)]'
			: 'opacity-0 scale-95 pointer-events-none duration-[140ms] ease-[cubic-bezier(0.16,1,0.3,1)]'}"
>
	<div class="flex h-full min-h-0 flex-col">
		<header class="flex h-12 shrink-0 items-center gap-2 border-b border-border px-4">
			<div class="relative flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-accent/10 text-accent-fg">
				<!-- Same mark as the corner button that opens it: one feature, one symbol. -->
				<Icon name="assistant" size={20} />
				<span class="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full border-2 border-surface {aiEnabled ? 'bg-success' : 'bg-text-tertiary'}"></span>
			</div>
			<h2 class="min-w-0 flex-1 truncate text-sm font-semibold text-text">Zajel</h2>
			<!--
				Separates the panel's identity from its controls. The drawer now
				shares the reading pane's background, so grouping inside the
				header has to come from a rule rather than a change of shade.
			-->
			<span class="mx-0.5 h-5 w-px shrink-0 bg-border" aria-hidden="true"></span>
			<button
				type="button"
				onclick={startNewChat}
				class="flex h-8 w-8 cursor-pointer items-center justify-center rounded-lg text-text-tertiary transition-colors hover:bg-surface-hover hover:text-text"
				aria-label="New conversation"
				title="New conversation"
			>
				<Icon name="add" size={16} />
			</button>
			<button
				type="button"
				onclick={() => { historyOpen = !historyOpen; }}
				class="flex h-8 w-8 cursor-pointer items-center justify-center rounded-lg transition-colors hover:bg-surface-hover hover:text-text {historyOpen ? 'bg-surface-hover text-text' : 'text-text-tertiary'}"
				aria-label="Conversation history"
				aria-pressed={historyOpen}
				title="Conversation history"
			>
				<Icon name="history" size={16} />
			</button>
			<button type="button" onclick={onClose} class="flex h-8 w-8 cursor-pointer items-center justify-center rounded-lg text-text-tertiary transition-colors hover:bg-surface-hover hover:text-text" aria-label="Close Zajel">
				<Icon name="close" size={16} />
			</button>
		</header>

		{#if historyOpen}
			<div class="min-h-0 flex-1 overflow-y-auto px-3 py-3">
				<p class="px-1 pb-2 text-2xs text-text-tertiary">
					Conversations are kept for {retentionDays} days.
				</p>

				{#if loadingHistory && !sessions.length}
					<p class="px-1 text-xs text-text-tertiary">Loading…</p>
				{:else if !sessions.length}
					<p class="px-1 text-xs text-text-tertiary">No past conversations yet.</p>
				{:else}
					<ul class="space-y-1">
						{#each sessions as session (session.id)}
							<li class="group flex items-center gap-1 rounded-lg {session.id === conversationId ? 'bg-surface-hover' : 'hover:bg-surface-hover'}">
								<button
									type="button"
									onclick={() => openSession(session.id)}
									class="min-w-0 flex-1 cursor-pointer px-2.5 py-2 text-left"
								>
									<span class="block truncate text-xs font-medium text-text">{session.title}</span>
									<span class="block text-2xs text-text-tertiary">
										{relativeTime(session.updatedAt)} · {session.messageCount} message{session.messageCount === 1 ? '' : 's'}
									</span>
								</button>
								<button
									type="button"
									onclick={() => removeSession(session.id)}
									class="mr-1.5 flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-text-tertiary opacity-0 transition-opacity hover:text-danger focus:opacity-100 group-hover:opacity-100"
									aria-label="Delete conversation {session.title}"
								>
									<Icon name="delete" size={14} />
								</button>
							</li>
						{/each}
					</ul>
				{/if}
			</div>
		{:else}
		<div bind:this={scrollEl} class="min-h-0 flex-1 flex flex-col space-y-4 overflow-y-auto px-4 py-4">
			{#each messages as message (message.id)}
				<div class="flex {message.role === 'user' ? 'justify-end' : 'justify-start'}">
					<div class="max-w-[88%] rounded-2xl px-3.5 py-2.5 text-sm leading-5
						{message.role === 'user'
							? 'rounded-br-md bg-accent text-white'
							: 'rounded-bl-md border border-border bg-surface text-text'}">
						{#if message.html}
							<!-- Sanitised on the server by renderAgentMarkdown; see
							     src/lib/server/ai/markdown.ts for the allowlist. -->
							<div class="agent-markdown">{@html message.html}</div>
						{:else}
							<p class="whitespace-pre-wrap">{message.content}</p>
						{/if}
						{#if message.link}
							<a href={message.link} target="_blank" rel="noreferrer" class="mt-2 inline-flex text-xs font-medium text-accent-fg hover:underline">Open task &nearr;</a>
						{/if}
						{#if message.calendarProposal}
							<!--
								A delete is irreversible, so the card names the event and
								its date rather than saying "this event". The button is
								the only path to /api/ai/calendar.
							-->
							<div class="mt-3 rounded-xl border p-3 text-text {message.calendarProposal.action === 'delete' ? 'border-danger/40 bg-danger/5' : 'border-border bg-bg'}">
								<p class="text-3xs font-semibold uppercase tracking-wider {message.calendarProposal.action === 'delete' ? 'text-danger' : 'text-accent-fg'}">
									{message.calendarProposal.action === 'delete' ? 'Delete event' : 'New event'}
								</p>

								{#if message.calendarProposal.action === 'delete' && message.calendarProposal.target}
									<p class="mt-1 font-medium">{message.calendarProposal.target.title}</p>
									<p class="mt-1 text-xs text-text-secondary">{message.calendarProposal.target.start}</p>
									<p class="mt-2 text-2xs text-danger">This cannot be undone.</p>
								{:else if message.calendarProposal.event}
									<p class="mt-1 font-medium">{message.calendarProposal.event.title}</p>
									<p class="mt-1 text-xs text-text-secondary">
										{message.calendarProposal.event.allDay
											? `${message.calendarProposal.event.start} · all day`
											: `${message.calendarProposal.event.start.slice(0, 10)} · ${message.calendarProposal.event.start.slice(11)}–${message.calendarProposal.event.end.slice(11)}`}
									</p>
									{#if message.calendarProposal.event.location}
										<p class="mt-1 text-xs text-text-tertiary">{message.calendarProposal.event.location}</p>
									{/if}
								{/if}

								<button
									type="button"
									disabled={message.calendarStatus === 'applying' || message.calendarStatus === 'applied'}
									onclick={() => confirmCalendar(message.id, message.calendarProposal!)}
									class="btn btn-sm mt-3 w-full {message.calendarProposal.action === 'delete' ? 'btn-danger-solid' : 'btn-primary'}"
								>
									{message.calendarStatus === 'applying'
										? 'Working…'
										: message.calendarStatus === 'applied'
											? 'Done'
											: message.calendarStatus === 'failed'
												? 'Try again'
												: message.calendarProposal.action === 'delete'
													? 'Delete from calendar'
													: 'Add to calendar'}
								</button>
							</div>
						{/if}
						{#if message.proposal}
							<div class="mt-3 rounded-xl border border-border bg-bg p-3 text-text">
								<p class="text-3xs font-semibold uppercase tracking-wider text-accent-fg">Task proposal</p>
								<p class="mt-1 font-medium">{message.proposal.title}</p>
								{#if message.proposal.description}
									<p class="mt-1 text-xs text-text-secondary">{message.proposal.description}</p>
								{/if}
								{#if message.proposal.dueDate}
									<p class="mt-2 text-xs text-text-tertiary">Due {message.proposal.dueDate}</p>
								{/if}
								{#if message.taskProviders?.length}
									<div class="mt-3 flex flex-wrap gap-1.5" aria-label="Task destination">
										{#each message.taskProviders as provider (provider)}
											<button
												type="button"
												onclick={() => selectProvider(message.id, provider)}
												class="cursor-pointer rounded-full border px-2.5 py-1 text-3xs font-medium transition-colors
													{message.selectedProvider === provider
														? 'border-accent bg-accent/10 text-accent-fg'
														: 'border-border text-text-secondary hover:border-accent/50'}"
											>
												{providerLabel(provider)}
											</button>
										{/each}
									</div>
								{/if}
								<button
									type="button"
									disabled={!message.selectedProvider || message.taskStatus === 'creating' || message.taskStatus === 'created'}
									onclick={() => createTask(message.id, message.proposal!, message.selectedProvider!)}
									class="btn btn-primary btn-sm mt-3 w-full"
								>
									{!message.selectedProvider
										? 'No task app connected'
										: message.taskStatus === 'creating'
										? 'Creating…'
										: message.taskStatus === 'created'
											? 'Created'
											: message.taskStatus === 'failed'
												? 'Try again'
												: `Confirm in ${providerLabel(message.selectedProvider)}`}
								</button>
							</div>
						{/if}
					</div>
				</div>
			{/each}

			{#if !hasConversation}
				<div class="mt-auto flex flex-col items-start gap-0.5">
					{#each prompts as p (p.action)}
						<button
							type="button"
							onclick={() => ask(p.action, p.prompt)}
							disabled={busy || !aiEnabled}
							class="-mx-2 cursor-pointer rounded-lg px-2 py-1.5 text-left text-sm text-text-secondary transition-colors hover:bg-surface-hover hover:text-text disabled:cursor-default disabled:opacity-50 disabled:hover:bg-transparent disabled:hover:text-text-secondary"
						>
							{p.label}
						</button>
					{/each}
				</div>
			{/if}

			{#if busy}
				<div class="flex justify-start">
					<div class="flex items-center gap-1.5 rounded-2xl rounded-bl-md border border-border bg-surface px-4 py-3" aria-label="Zajel is thinking">
						<span class="h-1.5 w-1.5 animate-pulse rounded-full bg-accent"></span>
						<span class="h-1.5 w-1.5 animate-pulse rounded-full bg-accent [animation-delay:150ms]"></span>
						<span class="h-1.5 w-1.5 animate-pulse rounded-full bg-accent [animation-delay:300ms]"></span>
					</div>
				</div>
			{/if}
		</div>
		{/if}

		<div class="shrink-0 border-t border-border p-3">
			{#if error}
				<p class="mb-2 rounded-lg bg-danger/10 px-3 py-2 text-xs text-danger">{error}</p>
			{/if}
			<form class="flex items-end gap-2 rounded-2xl border border-border bg-surface p-2 transition-colors focus-within:border-accent/60" onsubmit={(event) => { event.preventDefault(); ask('chat'); }}>
				<textarea bind:value={input} rows="1" maxlength="1500" aria-label="Message Zajel" disabled={busy || !aiEnabled} onkeydown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); ask('chat'); } }} class="max-h-28 min-h-9 flex-1 resize-none bg-transparent px-2 py-2 text-sm text-text outline-none placeholder:text-text-tertiary disabled:opacity-50"></textarea>
				<button type="submit" disabled={busy || !aiEnabled || !input.trim()} aria-label="Send message" class="flex h-9 w-9 shrink-0 cursor-pointer items-center justify-center rounded-xl bg-accent text-white transition-all hover:bg-accent-hover disabled:cursor-default disabled:opacity-40">
					<Icon name="send" size={16} />
				</button>
			</form>
		</div>
	</div>
</aside>

<style>
	/*
	 * Assistant replies are injected with {@html}, which Svelte's style
	 * scoping does not reach — hence :global. Sizes stay close to the
	 * surrounding chat text so a formatted reply reads as part of the
	 * conversation rather than as an embedded document.
	 */
	.agent-markdown :global(> :first-child) {
		margin-top: 0;
	}
	.agent-markdown :global(> :last-child) {
		margin-bottom: 0;
	}
	.agent-markdown :global(p) {
		margin: 0.5rem 0;
	}
	.agent-markdown :global(ul),
	.agent-markdown :global(ol) {
		margin: 0.5rem 0;
		padding-left: 1.15rem;
	}
	.agent-markdown :global(ul) {
		list-style: disc;
	}
	.agent-markdown :global(ol) {
		list-style: decimal;
	}
	.agent-markdown :global(li) {
		margin: 0.2rem 0;
	}
	/*
	 * em, not rem: these size against the bubble's own text rather than the
	 * document root. As rem they came out at ~14px inside a ~15px bubble —
	 * headings smaller than the paragraphs beneath them.
	 *
	 * A chat reply is short enough that weight carries the hierarchy; only h3
	 * steps up in size, and barely.
	 */
	.agent-markdown :global(h3) {
		margin: 0.75rem 0 0.35rem;
		font-size: 1.05em;
		font-weight: 600;
	}
	.agent-markdown :global(h4),
	.agent-markdown :global(h5),
	.agent-markdown :global(h6) {
		margin: 0.75rem 0 0.35rem;
		font-size: 1em;
		font-weight: 600;
	}
	.agent-markdown :global(code) {
		border-radius: 0.25rem;
		background: color-mix(in srgb, currentColor 10%, transparent);
		padding: 0.1em 0.32em;
		font-size: 0.9em;
	}
	.agent-markdown :global(pre) {
		margin: 0.5rem 0;
		border-radius: 0.5rem;
		background: color-mix(in srgb, currentColor 10%, transparent);
		padding: 0.6rem 0.7rem;
		/* Long lines scroll inside the bubble instead of widening the panel. */
		overflow-x: auto;
	}
	.agent-markdown :global(pre code) {
		background: none;
		padding: 0;
	}
	.agent-markdown :global(blockquote) {
		margin: 0.5rem 0;
		border-left: 2px solid color-mix(in srgb, currentColor 30%, transparent);
		padding-left: 0.6rem;
		opacity: 0.85;
	}
	.agent-markdown :global(a) {
		/*
		 * Inherit rather than take the UA's link blue, which is unreadable on
		 * the dark assistant bubble and clashes on the accent-coloured user
		 * one. The underline carries the affordance in both.
		 */
		color: inherit;
		text-decoration: underline;
		text-underline-offset: 2px;
	}
	.agent-markdown :global(hr) {
		margin: 0.75rem 0;
		border: 0;
		border-top: 1px solid color-mix(in srgb, currentColor 20%, transparent);
	}
	.agent-markdown :global(table) {
		margin: 0.5rem 0;
		display: block;
		overflow-x: auto;
		border-collapse: collapse;
		/* Dense data earns a step down, relative to the bubble. */
		font-size: 0.92em;
	}
	.agent-markdown :global(th),
	.agent-markdown :global(td) {
		border: 1px solid color-mix(in srgb, currentColor 20%, transparent);
		padding: 0.25rem 0.45rem;
		text-align: left;
	}
	.agent-markdown :global(strong) {
		font-weight: 600;
	}
</style>
