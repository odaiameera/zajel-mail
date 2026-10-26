<script lang="ts">
	import Icon from '$lib/components/Icon.svelte';
	import type { Email, Mailbox } from '$lib/jmap/types';
	import type { Label } from '$lib/types/labels';
	import { openCompose } from '$lib/stores/compose';
	import { goto, invalidateAll } from '$app/navigation';
	import { page } from '$app/state';
	import { browser } from '$app/environment';
	import { getContext } from 'svelte';
	import { renderEmailBodyHtml } from '$lib/utils/email-body';
	import { emailFrameCsp, prepareEmailForReading } from '$lib/utils/email-images';
	import { parseListUnsubscribe, type UnsubInfo } from '$lib/utils/list-unsubscribe';
	import { detectEmailVerificationCode } from '$lib/utils/otp';
	import FolderPicker from './FolderPicker.svelte';
	import AttachmentBar from './AttachmentBar.svelte';
	import InvitationCard from './InvitationCard.svelte';
	import JevWhy, { type JevSpamCheck } from './JevWhy.svelte';
	import EventModal from './calendar/EventModal.svelte';
	import { apiCreateEvent } from '$lib/calendar/api';
	import { fromDayKey } from '$lib/calendar/dates';
	import { showToast } from '$lib/stores/toast';
	import { cancelScheduled } from '$lib/stores/outbox';
	import { isScheduledMailbox } from '$lib/jmap/mailbox';
	import { formatSendTime } from '$lib/utils/send-later';
	import type { CalendarInfo, EventWritePayload } from '$lib/calendar/types';
	import { queueSenderForContacts } from '$lib/contacts/navigation';
	import { AI_ASSISTANT_CONTEXT, type AIAssistantContext } from '$lib/types/assistant';
	import { userState } from '$lib/stores/userState';
	import {
		addressList,
		escapeHtml,
		prefixedSubject,
		replyRecipients,
		threadHeaders
	} from '$lib/utils/reply';

	const allLabels = getContext<Label[]>('labels') ?? [];
	const aiAssistant = getContext<AIAssistantContext>(AI_ASSISTANT_CONTEXT);

	let {
		email,
		compact = false,
		onRemoved
	}: {
		email: Email;
		compact?: boolean;
		/** Called once this email has been moved out of the view (reading pane). */
		onRemoved?: () => void;
	} = $props();

	$effect(() => {
		const id = email.id;
		aiAssistant?.setCurrentEmail(id);
		return () => aiAssistant?.clearCurrentEmail(id);
	});

	const mailboxes = $derived<Mailbox[]>(page.data.mailboxes ?? []);

	const from = $derived(email.from?.[0]);
	const toList = $derived(email.to ?? []);
	const ccList = $derived(email.cc ?? []);
	const isDraft = $derived('$draft' in email.keywords);

	// A message waiting in Scheduled: when it goes out, or why it didn't.
	const inScheduled = $derived(
		mailboxes.some((m) => isScheduledMailbox(m) && email.mailboxIds[m.id])
	);
	let scheduledSend = $state<{ sendAt: string; status: string; error: string | null } | null>(null);
	$effect(() => {
		const id = email.id;
		scheduledSend = null;
		if (!inScheduled) return;
		let stale = false;
		void fetch(`/api/scheduled/${encodeURIComponent(id)}`)
			.then((r) => (r.ok ? r.json() : null))
			.then((s) => {
				if (!stale) scheduledSend = s;
			})
			.catch(() => {});
		return () => {
			stale = true;
		};
	});

	let cancellingSend = $state(false);
	async function handleCancelSend() {
		cancellingSend = true;
		const result = await cancelScheduled(email.id);
		cancellingSend = false;
		// Not sent either way; it opens in the composer to change and send again.
		if (result.success || result.code === 'move-failed') {
			handleEditDraft();
			void invalidateAll();
		} else {
			showToast({ message: result.error ?? 'Couldn’t cancel' });
		}
	}

	async function handleRetrySend() {
		const res = await fetch(`/api/scheduled/${encodeURIComponent(email.id)}`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ action: 'retry' })
		}).catch(() => null);
		if (res?.ok) {
			showToast({ message: 'Sending…' });
			scheduledSend = scheduledSend && { ...scheduledSend, status: 'pending', error: null, sendAt: new Date().toISOString() };
		} else {
			showToast({ message: 'Couldn’t send' });
		}
	}
	const isRead = $derived('$seen' in email.keywords);
	const isUnsubscribed = $derived('$unsubscribed' in email.keywords);

	// Flagged state is driven by local $state, not a $derived off email.keywords.
	// `email` comes from SvelteKit load data, which is NOT a $state proxy, so a
	// deep mutation of email.keywords wouldn't re-render the star. Seed from the
	// prop and resync whenever a different email is shown.
	let isFlagged = $state('$flagged' in email.keywords);
	$effect(() => {
		isFlagged = '$flagged' in email.keywords;
	});

	// Optimistic star toggle — instant UI, revert on failure.
	async function toggleFlag() {
		const next = !isFlagged;
		isFlagged = next; // reactive, drives the icon immediately
		// Keep the underlying load-data object consistent too (harmless if it
		// isn't reactive; correct if anything else reads it).
		if (next) email.keywords['$flagged'] = true;
		else delete email.keywords['$flagged'];
		try {
			const res = await fetch(`/api/email/${email.id}`, {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ action: next ? 'flag' : 'unflag' })
			});
			if (!res.ok) throw new Error();
		} catch {
			isFlagged = !next;
			if (next) delete email.keywords['$flagged'];
			else email.keywords['$flagged'] = true;
		}
	}

	// What the email's List-Unsubscribe header offers: one-click (RFC 8058),
	// a mailto, a page to open, or nothing. See $lib/utils/list-unsubscribe.
	const unsubInfo = $derived<UnsubInfo>(
		parseListUnsubscribe(
			email['header:list-unsubscribe'],
			email['header:list-unsubscribe-post:asText']
		)
	);
	// Label ids are also mailbox ids now; skip them when picking a source
	// mailbox for move-style actions (archive/trash/spam) so we don't
	// accidentally treat a label as the email's home folder.
	const labelIdSet = $derived(new Set(allLabels.map((l) => l.id)));
	const sourceMailboxId = $derived(
		Object.keys(email.mailboxIds).find((id) => !labelIdSet.has(id)) ?? ''
	);
	// The full-page view's way back: the folder the message lives in, not
	// always the Inbox, so opening something from Sent returns you to Sent.
	const sourceMailbox = $derived(mailboxes.find((m) => m.id === sourceMailboxId));
	const backHref = $derived(
		!sourceMailbox || sourceMailbox.role === 'inbox' ? '/inbox' : `/folder/${sourceMailbox.id}`
	);
	const backLabel = $derived(sourceMailbox?.name ?? 'Inbox');

	// Jev's spam verdict for this email (from the "Why is this here?" chip).
	let jevSpam = $state<JevSpamCheck | null>(null);

	// --- Spam classifier output (read-only for display + contextual button) ---
	const spamScore = $derived.by<number | null>(() => {
		const raw = email['header:x-spam-score:asText'];
		if (!raw) return null;
		const parsed = parseFloat(raw.trim());
		return Number.isFinite(parsed) ? parsed : null;
	});
	const spamStatus = $derived(email['header:x-spam-status:asText']?.toLowerCase() ?? '');

	/**
	 * The individual rules behind the score, when the server publishes them.
	 * Stalwart's filter is a stack of rules (authentication results, DNS
	 * blocklists, the Bayes classifier, heuristics), and only the breakdown
	 * tells you which of them objected — a legitimate newsletter flagged by
	 * BAYES_SPAM needs training, one flagged by a DMARC failure needs the
	 * sender to fix their DNS, and the two look identical from the score.
	 */
	const spamRules = $derived.by<string[]>(() => {
		const raw =
			email['header:x-spam-result:asText'] ?? email['header:x-spam-status:asText'] ?? '';
		return raw
			.split(/[,;]/)
			.map((part: string) => part.trim())
			.filter((part: string) => /^[A-Z][A-Z0-9_]{2,}/.test(part));
	});
	let showSpamRules = $state(false);
	const isFlaggedSpam = $derived(spamStatus.startsWith('yes'));
	const isInJunk = $derived(
		Object.keys(email.mailboxIds).some((id) => {
			const mb = mailboxes.find((m) => m.id === id);
			return mb?.role === 'junk';
		})
	);

	let actionLoading = $state('');
	let showLabelMenu = $state(false);
	let showMovePicker = $state(false);
	let moveTriggerEl = $state<HTMLButtonElement | undefined>(undefined);
	/**
	 * Destination to navigate to after a move/trash/archive. If the email
	 * came from the inbox, go back to /inbox; otherwise fall back to the
	 * source folder so the user lands where they started.
	 */
	function destAfterAction(sourceId: string): string {
		if (!sourceId) return '/inbox';
		const source = mailboxes.find((m) => m.id === sourceId);
		if (source?.role === 'inbox') return '/inbox';
		return `/folder/${sourceId}`;
	}

	async function handleMove(targetMailboxId: string) {
		showMovePicker = false;
		actionLoading = 'move';
		try {
			await fetch(`/api/email/${email.id}`, {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					action: 'moveTo',
					targetMailboxId,
					sourceMailboxId
				})
			});
			goto(destAfterAction(sourceMailboxId));
		} finally {
			actionLoading = '';
		}
	}

	const appliedLabels = $derived(allLabels.filter((l) => email.mailboxIds[l.id] === true));

	// Calendar invitations arrive as a text/calendar MIME part (iMIP) or an
	// .ics attachment — both are structured data, detected without guesswork.
	const calendarPart = $derived(
		(email.attachments ?? []).find((a) => {
			const type = a.type?.toLowerCase() ?? '';
			const name = a.name?.toLowerCase() ?? '';
			return (
				type.startsWith('text/calendar') ||
				type === 'application/ics' ||
				name.endsWith('.ics')
			);
		})
	);

	async function toggleLabel(labelId: string) {
		const isApplied = email.mailboxIds[labelId] === true;
		const action = isApplied ? 'remove' : 'apply';
		await fetch(`/api/email/${email.id}/label`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ labelId, action })
		});
		if (isApplied) {
			delete email.mailboxIds[labelId];
		} else {
			email.mailboxIds[labelId] = true;
		}
		showLabelMenu = false;
	}

	// --- Remote images: Settings → Messages → "Auto-load remote images" ---
	// never | contacts_only | always; anything else is the default, contacts only.
	const imagePolicy = $derived.by(() => {
		const value = page.data.autoLoadImages;
		return value === 'never' || value === 'always' ? value : 'contacts_only';
	});
	const senderAddress = $derived(from?.email?.trim().toLowerCase() ?? '');
	// Whether the sender is a contact, for contacts_only. Keyed by address so an
	// answer that arrives after you've moved on is never applied to the next
	// message. Until it arrives, and if it can't be had, images stay blocked.
	let senderKnown = $state<{ address: string; known: boolean | null } | null>(null);
	$effect(() => {
		const address = senderAddress;
		if (imagePolicy !== 'contacts_only' || !address) return;
		let stale = false;
		void fetch(`/api/contacts/known?email=${encodeURIComponent(address)}`)
			.then((r) => (r.ok ? r.json() : null))
			.then((d: { known?: boolean | null } | null) => {
				if (!stale) senderKnown = { address, known: d?.known ?? null };
			})
			.catch(() => {
				if (!stale) senderKnown = { address, known: null };
			});
		return () => {
			stale = true;
		};
	});
	// "Load images" on the banner: this message only, never remembered.
	let imagesShownFor = $state<string | null>(null);
	const remoteAllowed = $derived(
		imagePolicy === 'always' ||
		imagesShownFor === email.id ||
		(imagePolicy === 'contacts_only' &&
			senderKnown?.address === senderAddress &&
			senderKnown.known === true)
	);

	/**
	 * The body as shown in the reading view: remote images through the image
	 * proxy, or blocked, per the setting; `cid:` images from their inline
	 * parts. Replies and forwards quote {@link getBodyHtml} instead, so
	 * recipients get the sender's original image URLs rather than links into
	 * this webmail.
	 */
	const display = $derived(
		prepareEmailForReading(getBodyHtml(), {
			emailId: email.id,
			attachments: email.attachments ?? [],
			remote: remoteAllowed ? 'proxy' : 'block'
		})
	);

	// The frame's CSP names this origin (a path-restricted source needs a host).
	// The browser's own origin once hydrated; the server's view of it before.
	const frameOrigin = $derived(browser ? window.location.origin : page.url.origin);
	// emailFrameCsp refuses anything that isn't a plain http(s) origin. Should
	// that ever happen, fall back to a policy that allows no network at all.
	const frameCsp = $derived.by(() => {
		try {
			return emailFrameCsp(frameOrigin, remoteAllowed);
		} catch {
			return "default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'";
		}
	});

	// The CSP <meta> comes first, so it governs everything the email loads; an
	// email's own CSP <meta> can only tighten it. no-referrer keeps the address
	// of this webmail out of any link you follow from the message.
	const iframeContent = $derived(`<!DOCTYPE html><html><head>
		<meta http-equiv="Content-Security-Policy" content="${frameCsp}">
		<meta name="referrer" content="no-referrer">
		<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
		<base target="_blank">
		<style>
			body { margin: 16px; font-family: Calibri, 'Segoe UI', Arial, sans-serif; font-size: 14px; line-height: 1.6; word-wrap: break-word; overflow-wrap: break-word; color: #1f2328; background: #fff; }
			img { max-width: 100%; height: auto; }
			a { color: #0969da; }
			pre { white-space: pre-wrap; }
			blockquote { border-left: 3px solid #0969da; padding-left: 1em; margin-left: 0; color: #59636e; }
		</style>
	</head><body>${display.html}</body></html>`);


	// The message's own attachments, as the composer's blob references.
	function attachmentRefs() {
		return (email.attachments ?? []).map((a) => ({
			blobId: a.blobId,
			name: a.name ?? 'attachment',
			type: a.type,
			size: a.size
		}));
	}

	function handleEditDraft() {
		// Everything the draft carries: Bcc, attachments and its threading
		// headers used to be dropped here, so editing and sending a draft
		// lost them.
		openCompose({
			to: addressList(email.to ?? []),
			cc: addressList(email.cc ?? []),
			bcc: addressList(email.bcc ?? []),
			subject: email.subject ?? '',
			body: getBodyHtml(),
			draftId: email.id,
			inReplyTo: email.inReplyTo?.[0] ?? '',
			references: email.references?.join(' ') ?? '',
			attachments: attachmentRefs()
		});
	}

	// Mark-as-read after a second of viewing. An $effect keyed on the email
	// id (not onMount) because in the reading pane this component stays
	// mounted while the user moves between messages.
	$effect(() => {
		const id = email.id;
		if (email.keywords['$seen']) return;
		const timer = setTimeout(async () => {
			await fetch(`/api/email/${id}`, {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ action: 'markRead' })
			});
			email.keywords['$seen'] = true;
			invalidateAll();
		}, 1000);
		return () => clearTimeout(timer);
	});

	function formatDate(dateStr: string): string {
		return new Date(dateStr).toLocaleString('en-US', {
			weekday: 'short', year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'
		});
	}

	function getBodyHtml(): string {
		return renderEmailBodyHtml(email) || '<p style="color: #59636e;">No content</p>';
	}

	function getHtmlQuotedBlock(): string {
		const sender = email.from?.[0];
		if (!sender) return '';
		const dateStr = formatDate(email.receivedAt);
		const fromStr = sender.name ? `${escapeHtml(sender.name)} &lt;${escapeHtml(sender.email)}&gt;` : escapeHtml(sender.email);
		const originalBody = getBodyHtml();
		return `<br><br><blockquote style="margin: 0 0 0 0.8ex; border-left: 3px solid #0969da; padding-left: 1ex; color: #59636e;"><div><strong>From:</strong> ${fromStr}</div><div><strong>Date:</strong> ${dateStr}</div><div><strong>Subject:</strong> ${escapeHtml(email.subject ?? '')}</div><br>${originalBody}</blockquote>`;
	}

	function handleAddSenderToContacts() {
		if (!from?.email) return;
		goto(queueSenderForContacts(from));
	}

	// Your addresses, so Reply all never copies you in on your own reply.
	const myAddresses = $derived([
		...$userState.identities.map((i) => i.email),
		...(page.data.userEmail ? [page.data.userEmail as string] : [])
	]);

	function reply(all: boolean) {
		if (!email.from?.[0]) return;
		const { to, cc } = replyRecipients(email, myAddresses, all);
		openCompose({
			to: addressList(to),
			cc: addressList(cc),
			subject: prefixedSubject(email.subject, 'reply'),
			body: getHtmlQuotedBlock(),
			...threadHeaders(email)
		});
	}

	function handleReply() {
		reply(false);
	}

	function handleReplyAll() {
		reply(true);
	}

	function handleForward() {
		const sender = email.from?.[0];
		const originalSubject = email.subject ?? '';
		const dateStr = formatDate(email.receivedAt);
		const fromStr = sender?.name
			? `${escapeHtml(sender.name)} &lt;${escapeHtml(sender.email)}&gt;`
			: escapeHtml(sender?.email ?? 'Unknown');
		const toStr = escapeHtml(toList.map((a) => a.name || a.email).join(', '));
		// A forward carries the original's attachments, as mail clients do.
		openCompose({
			to: '', cc: '', subject: prefixedSubject(originalSubject, 'forward'), isForward: true,
			body: `<br><br><div style="border-top: 1px solid #d1d9e0; padding-top: 1em; color: #59636e;"><div><strong>---------- Forwarded message ----------</strong></div><div><strong>From:</strong> ${fromStr}</div><div><strong>Date:</strong> ${dateStr}</div><div><strong>Subject:</strong> ${escapeHtml(originalSubject)}</div><div><strong>To:</strong> ${toStr}</div><br>${getBodyHtml()}</div>`,
			attachments: attachmentRefs()
		});
	}

	async function doAction(action: string, extra: Record<string, unknown> = {}) {
		actionLoading = action;
		try {
			await fetch(`/api/email/${email.id}`, {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ action, sourceMailboxId, ...extra })
			});
			if (action === 'trash' || action === 'archive' || action === 'spam') {
				goto('/inbox');
			} else {
				await invalidateAll();
			}
		} finally { actionLoading = ''; }
	}

	// --- Verification codes ---
	//
	// A sign-in code is often wrapped in the sender's tracking link, so
	// double-clicking it to select opens a browser tab instead. The detected
	// code gets its own Copy button, and — once it's copied — the email has
	// done its job, so it goes to Trash (Settings → Messages turns that off).

	const otp = $derived(isDraft ? null : detectEmailVerificationCode(email));
	const trashMailboxId = $derived(mailboxes.find((m) => m.role === 'trash')?.id ?? '');
	const isInTrash = $derived(!!trashMailboxId && email.mailboxIds[trashMailboxId] === true);
	const otpTrashAfterCopy = $derived(page.data.otpTrashAfterCopy !== false);
	let otpBusy = $state(false);
	let otpCopied = $state(false);
	$effect(() => {
		void email.id;
		otpCopied = false;
	});

	async function copyText(text: string): Promise<boolean> {
		try {
			if (navigator.clipboard && window.isSecureContext) {
				await navigator.clipboard.writeText(text);
				return true;
			}
		} catch {
			// Permission denied or unfocused document — try the fallback.
		}
		// The async clipboard API only exists on https/localhost; a webmail
		// reached over plain http on the LAN still needs Copy to work.
		const area = document.createElement('textarea');
		area.value = text;
		area.setAttribute('readonly', '');
		area.style.position = 'fixed';
		area.style.opacity = '0';
		document.body.appendChild(area);
		area.select();
		let ok = false;
		try {
			ok = document.execCommand('copy');
		} catch {
			ok = false;
		}
		area.remove();
		return ok;
	}

	async function copyVerificationCode() {
		if (!otp || otpBusy) return;
		otpBusy = true;
		try {
			if (!(await copyText(otp.code))) {
				showToast({ message: 'Could not copy the code' });
				return;
			}
			otpCopied = true;
			if (!otpTrashAfterCopy || isInTrash || !trashMailboxId) {
				showToast({ message: 'Code copied' });
				return;
			}

			const id = email.id;
			const from = sourceMailboxId;
			const trashId = trashMailboxId;
			const res = await fetch(`/api/email/${id}`, {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ action: 'trash', sourceMailboxId: from })
			}).catch(() => null);
			if (!res?.ok) {
				showToast({ message: 'Code copied, but the email could not be moved to Trash' });
				return;
			}
			showToast({
				message: 'Code copied · email moved to Trash',
				duration: 6000,
				action: from
					? { label: 'Undo', onClick: () => void restoreFromTrash(id, from, trashId) }
					: undefined
			});
			if (onRemoved) {
				// Reading pane: stay in the list (a folder, or search results)
				// and just clear the pane.
				onRemoved();
				await invalidateAll();
			} else {
				await goto(destAfterAction(from));
			}
		} finally {
			otpBusy = false;
		}
	}

	async function restoreFromTrash(id: string, targetMailboxId: string, trashId: string) {
		const res = await fetch(`/api/email/${id}`, {
			method: 'PATCH',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ action: 'moveTo', targetMailboxId, sourceMailboxId: trashId })
		}).catch(() => null);
		if (!res?.ok) {
			showToast({ message: 'Could not restore the email' });
			return;
		}
		await invalidateAll();
	}

	// --- AI event extraction ("create event from this email") ---

	const aiEnabled = $derived(page.data.aiEnabled === true);
	let assistantOpen = $state(false);
	let assistantBusy = $state(false);
	let assistantQuestion = $state('');
	let assistantResult = $state('');
	let assistantError = $state('');
	let assistantResultKind = $state<'summarize' | 'answer' | 'draft' | null>(null);
	$effect(() => {
		// Do not carry an answer or generated draft into another message when
		// the reading pane swaps the `email` prop without remounting this view.
		void email.id;
		assistantOpen = false;
		assistantQuestion = '';
		assistantResult = '';
		assistantError = '';
		assistantResultKind = null;
	});
	let aiBusy = $state(false);
	let aiModalOpen = $state(false);
	let aiCalendars = $state<CalendarInfo[]>([]);
	let aiPrefill = $state<{ start: Date; end: Date; allDay: boolean } | null>(null);
	let aiExtras = $state<{ title?: string; location?: string; description?: string } | null>(null);

	async function runAssistant(action: 'summarize' | 'answer' | 'draft') {
		if (assistantBusy || (action === 'answer' && !assistantQuestion.trim())) return;
		const requestEmailId = email.id;
		assistantBusy = true;
		assistantError = '';
		try {
			const res = await fetch('/api/ai/assistant', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					action,
					subject: email.subject ?? '',
					from: from?.name ? `${from.name} <${from.email}>` : (from?.email ?? ''),
					receivedAt: email.receivedAt,
					html: getBodyHtml(),
					question: action === 'answer' ? assistantQuestion.trim() : undefined
				})
			});
			const data = (await res.json().catch(() => ({}))) as { result?: string; error?: string };
			if (!res.ok || !data.result) throw new Error(data.error ?? 'The assistant failed');
			if (email.id !== requestEmailId) return;
			assistantResult = data.result;
			assistantResultKind = action;
		} catch (err) {
			assistantError = err instanceof Error ? err.message : 'The assistant failed';
		} finally {
			assistantBusy = false;
		}
	}

	function textToHtml(text: string): string {
		const escaped = text
			.replace(/&/g, '&amp;')
			.replace(/</g, '&lt;')
			.replace(/>/g, '&gt;')
			.replace(/"/g, '&quot;')
			.replace(/'/g, '&#039;');
		return escaped
			.split(/\n{2,}/)
			.map((paragraph) => `<p>${paragraph.replace(/\n/g, '<br>')}</p>`)
			.join('');
	}

	function useAssistantDraft() {
		const sender = email.from?.[0];
		if (!sender || !assistantResult) return;
		const originalSubject = email.subject ?? '';
		openCompose({
			to: sender.email,
			cc: '',
			subject: originalSubject.startsWith('Re:') ? originalSubject : `Re: ${originalSubject}`,
			body: `${textToHtml(assistantResult)}${getHtmlQuotedBlock()}`,
			inReplyTo: email.id,
			references: email.id
		});
	}

	async function extractEventWithAI() {
		if (aiBusy) return;
		aiBusy = true;
		try {
			const [exRes, calRes] = await Promise.all([
				fetch('/api/ai/extract-event', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({
						subject: email.subject ?? '',
						html: getBodyHtml(),
						from: from?.email ?? '',
						receivedAt: email.receivedAt,
						timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone
					})
				}),
				fetch('/api/calendar/calendars')
			]);
			const ex = (await exRes.json().catch(() => ({}))) as {
				found?: boolean;
				title?: string;
				date?: string;
				startTime?: string | null;
				endTime?: string | null;
				allDay?: boolean;
				location?: string | null;
				notes?: string | null;
				error?: string;
			};
			if (!exRes.ok) {
				showToast({ message: ex.error ?? 'Event extraction failed' });
				return;
			}
			if (!ex.found || !ex.date) {
				showToast({ message: 'No event details found in this email.' });
				return;
			}
			const cals = (await calRes.json().catch(() => ({}))) as { calendars?: CalendarInfo[] };
			aiCalendars = cals.calendars ?? [];

			const day = fromDayKey(ex.date);
			if (ex.allDay || !ex.startTime) {
				aiPrefill = { start: day, end: new Date(day.getTime() + 86400000), allDay: true };
			} else {
				const [sh, sm] = ex.startTime.split(':').map(Number);
				const start = new Date(day.getFullYear(), day.getMonth(), day.getDate(), sh, sm);
				let end: Date;
				if (ex.endTime) {
					const [eh, em] = ex.endTime.split(':').map(Number);
					end = new Date(day.getFullYear(), day.getMonth(), day.getDate(), eh, em);
					if (end <= start) end = new Date(start.getTime() + 3600000);
				} else {
					end = new Date(start.getTime() + 3600000);
				}
				aiPrefill = { start, end, allDay: false };
			}
			aiExtras = {
				title: ex.title,
				location: ex.location ?? '',
				description: ex.notes ?? ''
			};
			aiModalOpen = true;
		} catch {
			showToast({ message: 'Event extraction failed' });
		} finally {
			aiBusy = false;
		}
	}

	async function saveExtractedEvent(payload: EventWritePayload): Promise<{ ok: boolean; error?: string }> {
		const res = await apiCreateEvent(payload);
		if (!res.ok) return { ok: false, error: res.error ?? 'Failed to create event' };
		const date = payload.allDay ? payload.start : payload.start.slice(0, 10);
		showToast({
			message: 'Event added to your calendar',
			action: { label: 'View', onClick: () => goto(`/calendar?view=day&date=${date}`) }
		});
		return { ok: true };
	}

	// --- Unsubscribe flow ---

	let unsubLoading = $state(false);
	let unsubToast = $state<{ kind: 'success' | 'error'; message: string } | null>(null);
	let unsubToastTimer: ReturnType<typeof setTimeout> | undefined;

	function showUnsubToast(kind: 'success' | 'error', message: string, ms = 3500) {
		unsubToast = { kind, message };
		if (unsubToastTimer) clearTimeout(unsubToastTimer);
		unsubToastTimer = setTimeout(() => { unsubToast = null; }, ms);
	}

	async function handleUnsubscribe() {
		if (unsubInfo.mode === 'none' || isUnsubscribed) return;

		// URL-only (no one-click POST header) still just opens the sender's
		// page — required because a real human click-through is needed there.
		if (unsubInfo.mode === 'url') {
			if (unsubInfo.url) window.open(unsubInfo.url, '_blank', 'noopener,noreferrer');
			return;
		}

		// Mailto sends from the user's account. Confirm once — this is a
		// silent send, not a draft, and senders key on the sender address.
		if (unsubInfo.mode === 'mailto') {
			const ok = confirm('Send an unsubscribe email to this sender from your account?');
			if (!ok) return;
		}

		unsubLoading = true;
		try {
			const res = await fetch(`/api/email/${email.id}/unsubscribe`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					mode: unsubInfo.mode,
					url: unsubInfo.url,
					mailto: unsubInfo.mailto
				})
			});
			const data = await res.json().catch(() => ({}));
			if (res.ok && data?.success) {
				// Optimistic local flag — server also persisted the keyword.
				email.keywords['$unsubscribed'] = true;
				showUnsubToast('success', 'Unsubscribe request sent.');
			} else {
				showUnsubToast('error', data?.error ?? `Failed (HTTP ${res.status})`);
			}
		} catch (err) {
			showUnsubToast('error', err instanceof Error ? err.message : 'Network error');
		} finally {
			unsubLoading = false;
		}
	}
</script>

<div class="h-full flex flex-col relative">
	<!-- Ribbon. First, and 48px tall, so it lines up with the mail list's
	     header across the divider (and with every other pane's top bar). On
	     the full-page view it also carries the way back to the folder. -->
	<div class="ribbon flex items-center justify-between h-12 shrink-0 border-b border-border {compact ? 'px-4' : 'px-6 max-md:px-2'}">
		<div class="flex items-center gap-1">
			{#if !compact}
				<a href={backHref} class="btn btn-ghost btn-sm -ml-2 mr-1" title="Back to {backLabel}">
					<Icon name="back" size={14} />
					{backLabel}
				</a>
				<span class="w-px h-4 bg-border mr-1" aria-hidden="true"></span>
			{/if}
			{#if inScheduled}
				<button onclick={handleCancelSend} disabled={cancellingSend} class="btn btn-secondary">Cancel send</button>
				{#if scheduledSend?.status === 'failed'}
					<button onclick={handleRetrySend} class="btn btn-primary">Try again</button>
					<span class="ml-2 text-xs text-danger truncate" title={scheduledSend.error ?? undefined}>Not sent{scheduledSend.error ? ` · ${scheduledSend.error}` : ''}</span>
				{:else if scheduledSend}
					<span class="ml-2 text-xs text-text-secondary truncate">Sends {formatSendTime(new Date(scheduledSend.sendAt))}</span>
				{/if}
			{:else if isDraft}
				<button onclick={handleEditDraft} class="btn btn-primary">
					<Icon name="edit" size={14} />
					Edit draft
				</button>
			{:else}
				<button onclick={handleReply} title="Reply" class="p-1.5 rounded-md hover:bg-surface-hover text-text-secondary hover:text-text transition-colors cursor-pointer">
					<Icon name="reply" size={16} />
				</button>
				<button onclick={handleReplyAll} title="Reply All" class="p-1.5 rounded-md hover:bg-surface-hover text-text-secondary hover:text-text transition-colors cursor-pointer">
					<Icon name="reply-all" size={16} />
				</button>
				<button onclick={handleForward} title="Forward" class="p-1.5 rounded-md hover:bg-surface-hover text-text-secondary hover:text-text transition-colors cursor-pointer">
					<Icon name="forward" size={16} />
				</button>
			{/if}
		</div>
		<div class="flex items-center gap-1">
			{#if aiEnabled && !isDraft}
				<button
					onclick={() => { assistantOpen = !assistantOpen; }}
					title="Ask Zajel"
					aria-pressed={assistantOpen}
					class="p-1.5 rounded-md hover:bg-surface-hover transition-colors cursor-pointer
						{assistantOpen ? 'text-accent-fg bg-accent/10' : 'text-text-secondary hover:text-accent-fg'}"
				>
					<Icon name="assistant" size={16} />
				</button>
			{/if}
			<button
				onclick={toggleFlag}
				title={isFlagged ? 'Unstar' : 'Star'}
				aria-label={isFlagged ? 'Unstar' : 'Star'}
				aria-pressed={isFlagged}
				class="p-1.5 rounded-md hover:bg-surface-hover transition-colors cursor-pointer
					{isFlagged ? 'text-warning' : 'text-text-secondary hover:text-warning'}"
			>
				<Icon name="star" size={16} fill={isFlagged ? 'currentColor' : 'none'} />
			</button>
			<button onclick={() => doAction(isRead ? 'markUnread' : 'markRead')} title={isRead ? 'Mark Unread' : 'Mark Read'} class="p-1.5 rounded-md hover:bg-surface-hover text-text-secondary hover:text-text transition-colors cursor-pointer">
				{#if isRead}
					<Icon name="mark-unread" size={16} />
				{:else}
					<Icon name="mark-read" size={16} />
				{/if}
			</button>
			<button
				bind:this={moveTriggerEl}
				onclick={(e) => { e.stopPropagation(); showMovePicker = !showMovePicker; }}
				title="Move to…"
				disabled={actionLoading === 'move'}
				class="p-1.5 rounded-md hover:bg-surface-hover transition-colors cursor-pointer disabled:opacity-50
					{showMovePicker ? 'text-accent-fg bg-accent/10' : 'text-text-secondary hover:text-text'}"
			>
				<Icon name="move-to-folder" size={16} />
			</button>
			{#if showMovePicker}
				<FolderPicker
					{mailboxes}
					labels={allLabels}
					excludeIds={sourceMailboxId ? [sourceMailboxId] : []}
					anchor={moveTriggerEl ?? null}
					align="right"
					onPick={handleMove}
					onClose={() => { showMovePicker = false; }}
				/>
			{/if}
			<button onclick={() => doAction('archive')} title="Archive" disabled={actionLoading === 'archive'} class="p-1.5 rounded-md hover:bg-surface-hover text-text-secondary hover:text-text transition-colors cursor-pointer disabled:opacity-50">
				<Icon name="archive" size={16} />
			</button>
			{#if isInJunk}
				<!--
					Trusting the sender is the durable fix where "not spam" is the
					one-off one: Stalwart exempts mail from anyone in the address
					book regardless of score, so this stops the same newsletter
					being re-flagged next month without loosening the filter for
					anything else.
				-->
				<button
					onclick={() =>
						doAction('trustSender', { address: from?.email, name: from?.name })}
					title="Trust this sender — add them to Contacts so their mail is never filtered as spam"
					disabled={actionLoading === 'trustSender' || !from?.email}
					class="p-1.5 rounded-md hover:bg-surface-hover text-text-secondary hover:text-accent-fg transition-colors cursor-pointer disabled:opacity-50"
				>
					<Icon name="add-contact" size={16} />
				</button>
				<button
					onclick={() => doAction('notSpam')}
					title="Not spam — move back to Inbox and train the classifier"
					disabled={actionLoading === 'notSpam'}
					class="p-1.5 rounded-md hover:bg-surface-hover text-text-secondary hover:text-success transition-colors cursor-pointer disabled:opacity-50"
				>
					<Icon name="not-spam" size={16} />
				</button>
			{:else}
				<button
					onclick={() => doAction('spam')}
					title="Mark as spam — move to Junk and train the classifier"
					disabled={actionLoading === 'spam'}
					class="p-1.5 rounded-md hover:bg-surface-hover text-text-secondary hover:text-text transition-colors cursor-pointer disabled:opacity-50"
				>
					<Icon name="spam" size={16} />
				</button>
			{/if}
			<button onclick={() => doAction('trash')} title="Trash" disabled={actionLoading === 'trash'} class="p-1.5 rounded-md hover:bg-surface-hover text-text-secondary hover:text-danger transition-colors cursor-pointer disabled:opacity-50">
				<Icon name="delete" size={16} />
			</button>
			<div class="w-px h-4 bg-border mx-0.5"></div>
			<button onclick={() => window.print()} title="Print" class="p-1.5 rounded-md hover:bg-surface-hover text-text-secondary hover:text-text transition-colors cursor-pointer">
				<Icon name="print" size={16} />
			</button>
			{#if aiEnabled && !isDraft}
				<button
					onclick={extractEventWithAI}
					title="Create calendar event from this email (AI)"
					disabled={aiBusy}
					class="p-1.5 rounded-md hover:bg-surface-hover text-text-secondary hover:text-accent-fg transition-colors cursor-pointer disabled:opacity-50"
				>
					{#if aiBusy}
						<span class="block w-4 h-4 rounded-full border-2 border-accent/40 border-t-accent animate-spin"></span>
					{:else}
						<!-- calendar with sparkle -->
						<Icon name="create-event" size={16} />
					{/if}
				</button>
			{/if}
			{#if unsubInfo.mode !== 'none'}
				<div class="w-px h-4 bg-border mx-0.5"></div>
				{#if isUnsubscribed}
					<span class="inline-flex items-center gap-1 px-2 py-1 text-xs text-success" title="Unsubscribed">
						<Icon name="check" size={14} />
						Unsubscribed
					</span>
				{:else}
					<button
						onclick={handleUnsubscribe}
						disabled={unsubLoading}
						title={unsubInfo.mode === 'one-click'
							? 'Unsubscribe (one click)'
							: unsubInfo.mode === 'mailto'
								? 'Send unsubscribe email'
								: 'Open sender\'s unsubscribe page'}
						class="inline-flex items-center gap-1 px-2 py-1 rounded-md text-xs text-danger hover:bg-danger/10 transition-colors cursor-pointer disabled:opacity-60 disabled:cursor-not-allowed"
					>
						{#if unsubLoading}
							<span class="w-3 h-3 rounded-full border-2 border-danger/40 border-t-red-400 animate-spin"></span>
							Unsubscribing…
						{:else}
							Unsubscribe
						{/if}
					</button>
				{/if}
			{/if}
		</div>
	</div>

	<header class="{compact ? 'px-4 py-3' : 'px-6 py-4 max-md:px-4'} border-b border-border shrink-0">
		<h1 class="{compact ? 'text-base' : 'text-xl'} font-semibold text-text mb-1">
			{email.subject || '(no subject)'}
		</h1>

		<!-- Labels -->
		<div class="flex items-center gap-1.5 flex-wrap mb-2 relative">
			{#each appliedLabels as label}
				<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium"
					style="background-color: {label.color}25; color: {label.color};">
					<span class="w-1.5 h-1.5 rounded-full" style="background-color: {label.color}"></span>
					{label.name}
					<button onclick={() => toggleLabel(label.id)} class="ml-0.5 opacity-60 hover:opacity-100 cursor-pointer">&times;</button>
				</span>
			{/each}
			<button onclick={() => showLabelMenu = !showLabelMenu}
				class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs text-text-tertiary border border-border hover:border-text-tertiary transition-colors cursor-pointer">
				+ Label
			</button>
			{#if showLabelMenu}
				<div class="absolute z-20 top-full left-0 mt-1 bg-surface border border-border rounded-lg shadow-lg py-1 min-w-[160px]">
					{#each allLabels as label}
						<button onclick={() => toggleLabel(label.id)}
							class="w-full flex items-center gap-2 px-3 py-1.5 text-sm hover:bg-surface-hover transition-colors cursor-pointer">
							<span class="w-2.5 h-2.5 rounded-full shrink-0" style="background-color: {label.color}"></span>
							<span class="flex-1 text-left text-text">{label.name}</span>
							{#if appliedLabels.find(l => l.id === label.id)}
								<Icon name="check" size={14} />
							{/if}
						</button>
					{/each}
					{#if allLabels.length === 0}
						<p class="px-3 py-2 text-xs text-text-tertiary">No labels yet. Create one in Settings.</p>
					{/if}
				</div>
			{/if}
		</div>

		<!-- On phones the date and Jev chips drop below the sender instead of
		     competing with a long address for one line. -->
		<div class="flex items-start justify-between gap-4 max-md:flex-col max-md:gap-2">
			<div class="min-w-0">
				<div class="flex items-baseline gap-x-2 flex-wrap">
					<span class="font-medium text-text text-sm">{from?.name || from?.email || 'Unknown'}</span>
					{#if from?.name && from?.email}
						<span class="text-xs text-text-tertiary break-all">&lt;{from.email}&gt;</span>
					{/if}
					{#if from?.email}
						<!-- self-center: in this baseline-aligned row, an icon-only
						     button's baseline is the bottom of its SVG, which lifts
						     the icon above the text. The negative margin keeps the
						     padded hit area from making the row taller. -->
						<button
							type="button"
							onclick={handleAddSenderToContacts}
							aria-label="Add sender to contacts"
							title="Add to Contacts"
							class="self-center -my-1 p-1 rounded-md text-text-tertiary hover:text-accent-fg hover:bg-accent/10 cursor-pointer"
						>
							<Icon name="add-contact" size={14} class="block" />
						</button>
					{/if}
				</div>
				<div class="text-xs text-text-tertiary mt-1">
					<span>To: {toList.map(a => a.name || a.email).join(', ')}</span>
					{#if ccList.length > 0}
						<span class="ml-3">Cc: {ccList.map(a => a.name || a.email).join(', ')}</span>
					{/if}
				</div>
			</div>
			<div class="flex flex-col items-end gap-1 shrink-0 max-md:flex-row max-md:flex-wrap max-md:items-center max-md:gap-2">
				<span class="text-xs text-text-tertiary">{formatDate(email.receivedAt)}</span>
				{#if page.data.jevReads}
					<JevWhy emailId={email.id} onSpamCheck={(check) => (jevSpam = check)} />
				{/if}
				{#if spamScore !== null}
					<!-- The score is a button when there is a breakdown to show: a
					     number on its own cannot tell you whether to train the
					     classifier or chase a DNS record. -->
					<svelte:element
						this={spamRules.length > 0 ? 'button' : 'span'}
						role={spamRules.length > 0 ? 'button' : undefined}
						tabindex={spamRules.length > 0 ? 0 : undefined}
						onclick={spamRules.length > 0 ? () => (showSpamRules = !showSpamRules) : undefined}
						class="inline-flex items-center gap-1 text-2xs px-2 py-0.5 rounded-full
							{spamRules.length > 0 ? 'cursor-pointer' : ''}
							{isFlaggedSpam
								? 'bg-danger/10 text-danger'
								: spamScore > 3
									? 'bg-warning/10 text-warning'
									: 'bg-text-tertiary/10 text-text-tertiary'}"
						title={spamRules.length > 0
							? 'Spam score — click to see which rules fired'
							: isFlaggedSpam
								? 'Flagged as spam by the classifier'
								: 'Spam classifier score'}
					>
						Spam score: {spamScore.toFixed(1)}
						{#if spamRules.length > 0}
							<Icon name="dropdown" size={12} class="transition-transform {showSpamRules ? 'rotate-180' : ''}" />
						{/if}
					</svelte:element>
					{#if showSpamRules && spamRules.length > 0}
						<div class="mt-1 max-w-xs flex flex-wrap justify-end gap-1">
							{#each spamRules as rule (rule)}
								<span class="text-3xs font-mono px-1.5 py-0.5 rounded-md bg-surface-hover text-text-secondary">
									{rule}
								</span>
							{/each}
						</div>
					{/if}
				{/if}
			</div>
		</div>
	</header>


	{#if jevSpam && (jevSpam.action === 'flagged' || jevSpam.action === 'junked' || jevSpam.action === 'rescued')}
		<!-- Jev's spam verdict, when (in active mode) it acted on it. -->
		<div class="{compact ? 'mx-4' : 'mx-6'} mt-3 shrink-0">
			<div class="flex items-start gap-3 rounded-xl border border-border bg-surface px-3.5 py-2.5 relative overflow-hidden" role="status">
				<div class="absolute inset-y-0 left-0 w-1 {jevSpam.action === 'rescued' ? 'bg-success' : 'bg-warning'}"></div>
				<div class="min-w-0 text-sm">
					{#if jevSpam.action === 'flagged'}
						<p class="text-text font-medium">This looks suspicious</p>
						<p class="text-xs text-text-tertiary mt-0.5">
							Jev puts it at {Math.round(jevSpam.phishing * 100)}% likely phishing and {Math.round(jevSpam.spam * 100)}% likely spam.
							Check who really sent it before you click a link, sign in or pay.
						</p>
					{:else if jevSpam.action === 'junked'}
						<p class="text-text font-medium">Jev moved this to Junk</p>
						<p class="text-xs text-text-tertiary mt-0.5">
							{Math.round(Math.max(jevSpam.spam, jevSpam.phishing) * 100)}% likely {jevSpam.phishing >= jevSpam.spam ? 'phishing' : 'spam'}. If it’s fine, mark it Not spam.
						</p>
					{:else}
						<p class="text-text font-medium">Jev brought this back from Junk</p>
						<p class="text-xs text-text-tertiary mt-0.5">
							Stalwart had flagged it, but Jev is sure it isn’t spam or phishing and the sender passed authentication.
						</p>
					{/if}
				</div>
			</div>
		</div>
	{/if}

	{#if otp}
		<div class="{compact ? 'mx-4' : 'mx-6'} mt-3 shrink-0">
			<div class="flex items-center gap-3 rounded-xl border border-border bg-surface px-3.5 py-2.5 relative overflow-hidden">
				<div class="absolute inset-y-0 left-0 w-1 bg-accent"></div>
				<Icon name="code" size={20} class="text-accent-fg" />
				<div class="min-w-0">
					<div class="text-2xs font-medium uppercase tracking-wide text-accent-fg">Verification code</div>
					<div class="font-mono text-lg font-semibold tracking-[0.2em] text-text select-all leading-7">{otp.display}</div>
				</div>
				<div class="ml-auto flex flex-col items-end gap-0.5 shrink-0">
					<button
						type="button"
						onclick={copyVerificationCode}
						disabled={otpBusy}
						class="btn btn-primary btn-sm"
					>
						{#if otpCopied}
							<Icon name="check" size={14} />
							Copied
						{:else}
							<Icon name="copy" size={14} />
							Copy code
						{/if}
					</button>
					{#if otpTrashAfterCopy && !isInTrash && trashMailboxId}
						<span class="text-3xs text-text-tertiary">Moves this email to Trash</span>
					{/if}
				</div>
			</div>
		</div>
	{/if}

	{#if calendarPart}
		{#key calendarPart.blobId}
			<InvitationCard emailId={email.id} blobId={calendarPart.blobId} {compact} />
		{/key}
	{/if}

	<AttachmentBar emailId={email.id} attachments={email.attachments ?? []} />

	{#if assistantOpen}
		<section class="shrink-0 border-b border-border bg-surface-hover/40 {compact ? 'px-4' : 'px-6'} py-3">
			<div class="flex items-center justify-between gap-3 mb-3">
				<h2 class="text-sm font-semibold text-text">Zajel</h2>
				<button onclick={() => { assistantOpen = false; }} aria-label="Close Zajel" class="text-text-tertiary hover:text-text cursor-pointer"><Icon name="close" /></button>
			</div>

			<div class="flex flex-wrap gap-2">
				<button onclick={() => runAssistant('summarize')} disabled={assistantBusy} class="px-3 py-1.5 rounded-lg text-xs border border-border text-text hover:border-accent disabled:opacity-50 cursor-pointer">Summarize</button>
				<button onclick={() => runAssistant('draft')} disabled={assistantBusy} class="px-3 py-1.5 rounded-lg text-xs border border-border text-text hover:border-accent disabled:opacity-50 cursor-pointer">Draft reply</button>
				<form class="flex min-w-[240px] flex-1 gap-2" onsubmit={(event) => { event.preventDefault(); runAssistant('answer'); }}>
					<input bind:value={assistantQuestion} maxlength="500" aria-label="Ask Zajel about this email" class="min-w-0 flex-1 rounded-lg border border-border bg-surface px-3 py-1.5 text-xs text-text outline-none focus:border-accent" />
					<button type="submit" disabled={assistantBusy || !assistantQuestion.trim()} class="btn btn-primary btn-sm">Ask</button>
				</form>
			</div>

			{#if assistantBusy}
				<p class="mt-3 text-xs text-text-tertiary">Thinking…</p>
			{:else if assistantError}
				<p class="mt-3 text-xs text-danger">{assistantError}</p>
			{:else if assistantResult}
				<div class="mt-3 max-h-48 overflow-y-auto rounded-lg border border-border bg-surface p-3">
					<p class="whitespace-pre-wrap text-sm leading-6 text-text">{assistantResult}</p>
					{#if assistantResultKind === 'draft'}
						<button onclick={useAssistantDraft} class="btn btn-primary btn-sm mt-3">Use as reply</button>
					{/if}
				</div>
			{/if}
		</section>
	{/if}

	{#if display.blockedRemote > 0 && !remoteAllowed}
		<!-- Remote images blocked by the setting (or while a contact lookup is
		     pending). Loading them is a per-message choice. -->
		<div class="flex items-center gap-2 shrink-0 border-b border-border text-xs text-text-secondary {compact ? 'px-4 py-1.5' : 'px-6 py-2 max-md:px-2'}">
			<Icon name="file-image" size={14} />
			<span class="flex-1 min-w-0">Remote images are hidden, so the sender can't tell you opened this.</span>
			<button onclick={() => (imagesShownFor = email.id)} class="btn btn-ghost btn-sm">Load images</button>
		</div>
	{/if}

	<!-- Email body in sandboxed iframe. The iframe always fills the
	     remaining vertical space of the reading pane, regardless of the
	     email's content height — short emails no longer collapse the
	     pane, and long ones scroll inside the iframe instead of the
	     wrapper. -->
	<div class="flex-1 overflow-hidden {compact ? 'px-4 py-3' : 'px-6 py-4 max-md:px-2 max-md:py-2'}">
		<!-- bg-white matches the document's body background so swapping
		     srcdoc (next/previous message) repaints white-on-white instead
		     of flashing through the dark page background. -->
		<iframe
			srcdoc={iframeContent}
			sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
			title="Email content"
			class="w-full h-full border-none rounded-md bg-white"
		></iframe>
	</div>

	<EventModal
		open={aiModalOpen}
		calendars={aiCalendars}
		prefill={aiPrefill}
		prefillExtras={aiExtras}
		onSubmit={saveExtractedEvent}
		onClose={() => {
			aiModalOpen = false;
			aiPrefill = null;
			aiExtras = null;
		}}
	/>

	<!-- Unsubscribe toast — fixed relative to the detail surface so it
	     floats over the ribbon without affecting its layout. Solid
	     bg-surface so it's clearly legible over the mail body. -->
	{#if unsubToast}
		<div
			role="status"
			aria-live="polite"
			class="absolute top-16 right-6 z-20 inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-surface border text-xs shadow-[0_8px_24px_rgba(0,0,0,0.4)] animate-compose-modal-in
				{unsubToast.kind === 'success' ? 'border-border text-text' : 'border-danger/40 text-danger'}"
		>
			{#if unsubToast.kind === 'success'}
				<Icon name="check" size={14} class="text-accent-fg" />
			{:else}
				<Icon name="error" size={14} />
			{/if}
			<span>{unsubToast.message}</span>
		</div>
	{/if}
</div>
