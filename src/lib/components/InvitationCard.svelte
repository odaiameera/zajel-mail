<script lang="ts">
	import Icon from '$lib/components/Icon.svelte';
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import type { CalendarInfo, EventAttendee, RecurrenceRule } from '$lib/calendar/types';
	import { describeRRule } from '$lib/calendar/types';
	import { dayKey, formatEventRange, instanceDate } from '$lib/calendar/dates';
	import { apiDeleteEvent, markTouched } from '$lib/calendar/api';
	import { showToast } from '$lib/stores/toast';

	let {
		emailId,
		blobId,
		compact = false
	}: {
		emailId: string;
		blobId: string;
		compact?: boolean;
	} = $props();

	interface Invitation {
		found: boolean;
		uid: string;
		method: string | null;
		/** Set when the file is about one occurrence of a series. */
		recurrenceId: string | null;
		event: {
			title: string;
			allDay: boolean;
			start: string;
			end: string;
			location: string;
			description: string;
			recurring: boolean;
			rrule: RecurrenceRule | null;
		};
		organizer: { email: string; name: string | null } | null;
		attendees: EventAttendee[];
		myStatus: string | null;
		existing: { calendarId: string; eventId: string; myStatus: string | null } | null;
		calendars: CalendarInfo[];
	}

	let invitation = $state<Invitation | null>(null);
	let loading = $state(true);
	let busy = $state<string | null>(null);
	let selectedCalendar = $state('');
	let occurrenceRemoved = $state(false);

	onMount(async () => {
		try {
			const res = await fetch(
				`/api/email/${encodeURIComponent(emailId)}/invitation?blobId=${encodeURIComponent(blobId)}`
			);
			const data = (await res.json()) as Invitation & { error?: string };
			if (res.ok && data.found) {
				invitation = data;
				selectedCalendar =
					data.existing?.calendarId ??
					data.calendars.find((c) => c.isDefault)?.id ??
					data.calendars[0]?.id ??
					'default';
			}
		} catch {
			// Card silently disappears if the part can't be inspected.
		} finally {
			loading = false;
		}
	});

	const startDate = $derived(
		invitation ? instanceDate(invitation.event.start, invitation.event.allDay) : new Date()
	);
	const rangeText = $derived(
		invitation
			? formatEventRange(
					startDate,
					instanceDate(invitation.event.end, invitation.event.allDay),
					invitation.event.allDay
				)
			: ''
	);
	const isCancellation = $derived(invitation?.method === 'CANCEL');
	const isInvite = $derived(!isCancellation && invitation?.myStatus !== null);
	const currentStatus = $derived(invitation?.existing?.myStatus ?? invitation?.myStatus ?? null);
	const onCalendar = $derived(!!invitation?.existing);
	const occurrenceOnly = $derived(!!invitation?.recurrenceId);
	const monthShort = $derived(startDate.toLocaleDateString(undefined, { month: 'short' }));

	/** Send the invitation to the server, which stores it or folds it into the series it belongs to. */
	async function postInvitation(partStat: string | null): Promise<{ ok: boolean; error?: string; eventId?: string }> {
		if (!invitation) return { ok: false };
		const res = await fetch('/api/calendar/invitation', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				blobId,
				calendarId: invitation.existing?.calendarId ?? selectedCalendar,
				partStat
			})
		});
		const data = (await res.json().catch(() => ({}))) as { error?: string; eventId?: string };
		if (!res.ok) return { ok: false, error: data.error };
		if (data.eventId) markTouched(data.eventId);
		return { ok: true, eventId: data.eventId };
	}

	async function importWith(partStat: string | null, busyKey: string) {
		if (!invitation || busy) return;
		busy = busyKey;
		try {
			const res = await postInvitation(partStat);
			if (!res.ok) {
				showToast({ message: res.error ?? 'Failed to add to calendar' });
				return;
			}
			invitation = {
				...invitation,
				myStatus: partStat ?? invitation.myStatus,
				existing: {
					calendarId: invitation.existing?.calendarId ?? selectedCalendar,
					eventId: res.eventId ?? invitation.existing?.eventId ?? '',
					myStatus: partStat ?? invitation.existing?.myStatus ?? null
				}
			};
			showToast({
				message: partStat ? 'RSVP saved to your calendar' : 'Added to your calendar',
				action: { label: 'View', onClick: () => viewInCalendar() }
			});
		} finally {
			busy = null;
		}
	}

	async function removeFromCalendar() {
		if (!invitation?.existing || busy) return;
		busy = 'remove';
		try {
			if (occurrenceOnly) {
				// The organizer cancelled one meeting of a series. The server
				// folds the cancellation into the stored series as an EXDATE;
				// deleting the object would take every other occurrence with it.
				const res = await postInvitation(null);
				if (!res.ok) {
					showToast({ message: res.error ?? 'Failed to remove event' });
					return;
				}
				occurrenceRemoved = true;
				showToast({ message: 'Removed this occurrence from your calendar' });
				return;
			}
			const res = await apiDeleteEvent(invitation.existing.eventId, 'all', null);
			if (!res.ok) {
				showToast({ message: res.error ?? 'Failed to remove event' });
				return;
			}
			invitation = { ...invitation, existing: null };
			showToast({ message: 'Removed from your calendar' });
		} finally {
			busy = null;
		}
	}

	function viewInCalendar() {
		goto(`/calendar?view=day&date=${dayKey(startDate)}`);
	}

	const rsvpOptions = [
		{ partStat: 'ACCEPTED', label: 'Yes', busyKey: 'yes' },
		{ partStat: 'TENTATIVE', label: 'Maybe', busyKey: 'maybe' },
		{ partStat: 'DECLINED', label: 'No', busyKey: 'no' }
	];
</script>

{#if !loading && invitation}
	<div class="{compact ? 'mx-4' : 'mx-6'} mt-3 shrink-0">
		<div class="flex gap-3.5 rounded-xl border border-border bg-surface p-3.5 relative overflow-hidden">
			<div class="absolute inset-y-0 left-0 w-1 {isCancellation ? 'bg-danger' : 'bg-accent'}"></div>

			<!-- Date tile -->
			<div class="w-12 shrink-0 rounded-lg border border-border overflow-hidden text-center select-none self-start">
				<div class="text-3xs uppercase tracking-wide py-0.5 {isCancellation ? 'bg-danger/15 text-danger' : 'bg-accent/15 text-accent-fg'}">
					{monthShort}
				</div>
				<div class="text-lg font-semibold text-text leading-7">{startDate.getDate()}</div>
			</div>

			<div class="min-w-0 flex-1">
				<div class="flex items-center gap-2 flex-wrap">
					<span class="text-2xs font-medium uppercase tracking-wide {isCancellation ? 'text-danger' : 'text-accent-fg'}">
						{isCancellation
							? occurrenceOnly
								? 'Occurrence cancelled'
								: 'Event cancelled'
							: isInvite
								? 'Invitation'
								: 'Event attached'}
					</span>
					{#if onCalendar && !isCancellation}
						<span class="inline-flex items-center gap-1 text-2xs text-success">
							<Icon name="check" size={12} />
							On your calendar
						</span>
					{/if}
				</div>

				<h3 class="text-sm font-semibold text-text mt-0.5 truncate {isCancellation ? 'line-through opacity-70' : ''}">
					{invitation.event.title || '(untitled event)'}
				</h3>
				<p class="text-xs text-text-secondary mt-0.5">
					{rangeText}{invitation.event.recurring
						? ` · ${describeRRule(invitation.event.rrule)}`
						: occurrenceOnly
							? ' · one occurrence of a repeating event'
							: ''}
				</p>
				{#if invitation.event.location}
					<p class="text-xs text-text-tertiary mt-0.5 truncate">📍 {invitation.event.location}</p>
				{/if}
				{#if invitation.organizer}
					<p class="text-xs text-text-tertiary mt-0.5 truncate">
						Organizer: {invitation.organizer.name || invitation.organizer.email}
						{#if invitation.attendees.length > 0}
							· {invitation.attendees.length} guest{invitation.attendees.length === 1 ? '' : 's'}
						{/if}
					</p>
				{/if}

				<!-- Actions -->
				<div class="flex items-center gap-2 mt-2.5 flex-wrap">
					{#if isCancellation}
						{#if onCalendar && !occurrenceRemoved}
							<button
								type="button"
								class="btn btn-danger btn-sm"
								disabled={busy !== null}
								onclick={removeFromCalendar}
							>
								{busy === 'remove' ? 'Removing…' : occurrenceOnly ? 'Remove this occurrence' : 'Remove from calendar'}
							</button>
						{:else if occurrenceRemoved}
							<span class="text-xs text-text-tertiary">Removed from your calendar.</span>
						{:else}
							<span class="text-xs text-text-tertiary">This event isn't on your calendar.</span>
						{/if}
					{:else if isInvite}
						<span class="text-xs text-text-secondary mr-0.5">Going?</span>
						{#each rsvpOptions as opt (opt.partStat)}
							{@const active = currentStatus === opt.partStat && onCalendar}
							<button
								type="button"
								class="px-3 h-7 rounded-lg text-xs font-medium transition-colors cursor-pointer disabled:opacity-60
									{active
										? 'bg-accent text-white'
										: 'border border-border text-text-secondary hover:bg-surface-hover hover:text-text'}"
								disabled={busy !== null}
								onclick={() => importWith(opt.partStat, opt.busyKey)}
							>
								{busy === opt.busyKey ? '…' : opt.label}
							</button>
						{/each}
					{:else if !onCalendar}
						<button
							type="button"
							class="btn btn-primary btn-sm"
							disabled={busy !== null}
							onclick={() => importWith(null, 'add')}
						>
							{busy === 'add' ? 'Adding…' : 'Add to calendar'}
						</button>
					{/if}

					{#if !isCancellation && !onCalendar && invitation.calendars.length > 1}
						<select
							bind:value={selectedCalendar}
							class="h-7 text-xs px-2 rounded-lg bg-surface-hover border border-border text-text cursor-pointer outline-none focus:border-accent"
							aria-label="Calendar"
						>
							{#each invitation.calendars as cal (cal.id)}
								<option value={cal.id}>{cal.name}</option>
							{/each}
						</select>
					{/if}

					{#if onCalendar && !isCancellation}
						<button
							type="button"
							class="text-xs text-accent-fg hover:text-accent-fg-hover transition-colors cursor-pointer"
							onclick={viewInCalendar}
						>
							View in calendar
						</button>
					{/if}
				</div>
			</div>
		</div>
	</div>
{/if}
