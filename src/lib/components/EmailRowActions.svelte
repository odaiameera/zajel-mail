<script lang="ts">
	import Icon from '$lib/components/Icon.svelte';
	import { invalidateAll } from '$app/navigation';
	import { showToast } from '$lib/stores/toast';
	import RemindMeLaterPicker from './RemindMeLaterPicker.svelte';
	import CategoryPicker from './CategoryPicker.svelte';
	import { moveToCategory } from '$lib/categories/api';
	import type { InboxCategory } from '$lib/types/categories';

	let {
		emailId,
		isUnread,
		sourceMailboxId,
		hasReminder = false,
		category = null,
		trashIsPermanent = false
	}: {
		emailId: string;
		isUnread: boolean;
		/** The folder the row is shown in, as a hint for where a snoozed message comes back to. */
		sourceMailboxId: string;
		/**
		 * The row is in the Trash list itself: Trash there deletes for good.
		 * Never from a label, Search, Starred or any other list.
		 */
		trashIsPermanent?: boolean;
		/** Email is parked in Remind Me Later — offer Unsnooze instead of the picker. */
		hasReminder?: boolean;
		/** The row's Inbox tab; null when the list isn't a tabbed Inbox. */
		category?: InboxCategory | null;
	} = $props();

	let loading = $state<string>('');
	let pickerOpen = $state(false);
	let categoryPickerOpen = $state(false);
	let categoryTriggerEl = $state<HTMLButtonElement | undefined>(undefined);

	async function pickCategory(next: InboxCategory) {
		categoryPickerOpen = false;
		if (loading || !category) return;
		loading = 'setCategory';
		try {
			await moveToCategory([emailId], next, category);
		} finally {
			loading = '';
		}
	}

	async function act(action: string) {
		if (loading) return;
		loading = action;
		try {
			const res = await fetch(`/api/email/${emailId}`, {
				method: 'PATCH',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ action, ...(action === 'trash' && trashIsPermanent ? { permanent: true } : {}) })
			});
			if (!res.ok) {
				const data = await res.json().catch(() => ({}));
				showToast({ message: data.error ?? 'That didn’t work. Try again.' });
			}
			await invalidateAll();
		} catch {
			showToast({ message: 'Network error' });
		} finally {
			loading = '';
		}
	}

	async function unsnooze() {
		if (loading) return;
		loading = 'unsnooze';
		try {
			const res = await fetch(`/api/reminders/${emailId}`, { method: 'DELETE' });
			if (!res.ok) showToast({ message: await errorText(res, 'Could not cancel the reminder') });
			await invalidateAll();
		} catch {
			showToast({ message: 'Network error' });
		} finally {
			loading = '';
		}
	}

	async function scheduleReminder(remindAt: string) {
		pickerOpen = false;
		if (loading) return;
		loading = 'rml';
		try {
			const res = await fetch('/api/reminders', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ emailId, remindAt, sourceMailboxId })
			});
			if (!res.ok) showToast({ message: await errorText(res, 'Could not set the reminder') });
			await invalidateAll();
		} catch {
			showToast({ message: 'Network error' });
		} finally {
			loading = '';
		}
	}

	async function errorText(res: Response, fallback: string): Promise<string> {
		const data = (await res.json().catch(() => null)) as { error?: string } | null;
		return data?.error ?? fallback;
	}

	/**
	 * Block the wrapping <a href="/email/id"> from grabbing the click.
	 * The anchor's default navigation happens on the click event, so we
	 * cancel at both mousedown (in case the browser reacts earlier) and
	 * click, and stop propagation so the anchor's own onclick never runs.
	 */
	function stop(e: Event) {
		e.preventDefault();
		e.stopPropagation();
	}
</script>

<!-- Sits on the row's first line in the timestamp's slot (the row hides the
     time on hover), on the row's own hover colour so it reads as part of the
     row rather than a card floating across two lines of text. The fade on its
     left lets a long sender name run under it instead of being cut off. -->
<div
	class="email-row-actions absolute right-0 top-1/2 -translate-y-1/2 flex items-center gap-0.5 opacity-0 transition-opacity bg-surface-hover rounded-md z-10"
	onmousedown={stop}
	role="presentation"
>
	<span aria-hidden="true" class="absolute right-full inset-y-0 w-6 bg-linear-to-l from-surface-hover to-transparent pointer-events-none"></span>
	<button
		type="button"
		onmousedown={stop}
		onclick={(e) => { stop(e); act('archive'); }}
		disabled={!!loading}
		title="Archive"
		aria-label="Archive"
		class="p-1 rounded-md hover:bg-surface text-text-secondary hover:text-text transition-colors cursor-pointer disabled:opacity-50"
	>
		<Icon name="archive" size={16} />
	</button>

	{#if hasReminder}
		<button
			type="button"
			onmousedown={stop}
			onclick={(e) => { stop(e); unsnooze(); }}
			disabled={!!loading}
			title="Unsnooze — return to inbox now"
			aria-label="Unsnooze"
			class="p-1 rounded-md hover:bg-surface text-accent-fg hover:text-text transition-colors cursor-pointer disabled:opacity-50"
		>
			<Icon name="unsnooze" size={16} />
		</button>
	{:else}
		<div class="relative">
			<button
				type="button"
				onmousedown={stop}
				onclick={(e) => { stop(e); pickerOpen = !pickerOpen; }}
				disabled={!!loading}
				title="Remind me later"
				aria-label="Remind me later"
				class="p-1 rounded-md hover:bg-surface transition-colors cursor-pointer disabled:opacity-50 {pickerOpen ? 'text-accent-fg bg-accent/10' : 'text-text-secondary hover:text-text'}"
			>
				<Icon name="remind-later" size={16} />
			</button>
			{#if pickerOpen}
				<div onclick={stop} onmousedown={stop} onkeydown={(e) => e.stopPropagation()} role="presentation">
					<RemindMeLaterPicker
						onPick={scheduleReminder}
						onClose={() => (pickerOpen = false)}
					/>
				</div>
			{/if}
		</div>
	{/if}

	{#if category}
		<button
			bind:this={categoryTriggerEl}
			type="button"
			onmousedown={stop}
			onclick={(e) => { stop(e); categoryPickerOpen = !categoryPickerOpen; }}
			disabled={!!loading}
			title="Move to tab"
			aria-label="Move to tab"
			aria-haspopup="menu"
			aria-expanded={categoryPickerOpen}
			class="p-1 rounded-md hover:bg-surface transition-colors cursor-pointer disabled:opacity-50 {categoryPickerOpen ? 'text-accent-fg bg-accent/10' : 'text-text-secondary hover:text-text'}"
		>
			<Icon name="move-to-tab" size={16} />
		</button>
		{#if categoryPickerOpen}
			<!-- Rendered on <body>, so its clicks never reach the row link. -->
			<CategoryPicker
				current={category}
				anchor={categoryTriggerEl ?? null}
				onPick={pickCategory}
				onClose={() => (categoryPickerOpen = false)}
			/>
		{/if}
	{/if}

	<button
		type="button"
		onmousedown={stop}
		onclick={(e) => { stop(e); act(isUnread ? 'markRead' : 'markUnread'); }}
		disabled={!!loading}
		title={isUnread ? 'Mark as read' : 'Mark as unread'}
		aria-label={isUnread ? 'Mark as read' : 'Mark as unread'}
		class="p-1 rounded-md hover:bg-surface text-text-secondary hover:text-text transition-colors cursor-pointer disabled:opacity-50"
	>
		{#if isUnread}
			<Icon name="mark-read" size={16} />
		{:else}
			<Icon name="mark-unread" size={16} />
		{/if}
	</button>

	<button
		type="button"
		onmousedown={stop}
		onclick={(e) => { stop(e); act('trash'); }}
		disabled={!!loading}
		title="Delete"
		aria-label="Delete"
		class="p-1 rounded-md hover:bg-surface text-text-secondary hover:text-danger transition-colors cursor-pointer disabled:opacity-50"
	>
		<Icon name="delete" size={16} />
	</button>
</div>

<style>
	/* Hidden toolbar must not swallow clicks meant for row content under it. */
	.email-row-actions {
		pointer-events: none;
	}
	:global(.email-row:hover) .email-row-actions,
	.email-row-actions:focus-within {
		opacity: 1;
		pointer-events: auto;
	}
</style>
