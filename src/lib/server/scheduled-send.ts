import { createClient } from '$lib/jmap/auth';
import { JMAPAuthError, JMAPMethodError } from '$lib/jmap/client';
import { buildEnvelope, saveDraft, submitStoredEmail } from '$lib/jmap/email';
import { ensureScheduledMailbox, getMailboxes, isScheduledMailbox } from '$lib/jmap/mailbox';
import type { AuthState, ComposeEmail } from '$lib/jmap/types';
import { authStateForAccount, getAccount, markNeedsReauth } from './auth/accounts';
import {
	cancelScheduledSendRow,
	claimDueSends,
	failScheduledSend,
	getScheduledSend,
	insertScheduledSend,
	recoverInterruptedSends,
	removeScheduledSend,
	retryScheduledSendLater,
	retryScheduledSendNow,
	type ScheduledSendRow
} from './db/queries/scheduled-sends';

/**
 * Delay send and Send later, done by the server so a message goes out at
 * its time whether or not any browser is open.
 *
 * Scheduling stores the message in the account's Scheduled folder, with its
 * Date header set to the send time, and records a row. A worker submits due
 * messages: a timer for sends due within the sweep interval (the undo
 * window), and a sweep every few seconds for the rest and for anything a
 * restart interrupted. Cancelling moves the message to Drafts.
 */

const SWEEP_MS = 15_000;
/** Network or server trouble: wait this long before each retry, then give up. */
const RETRY_DELAYS_MS = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000];
const REAUTH_ERROR = 'Sign in to this account again, then try again.';

type ScheduleResult = { success: true; emailId: string; sendAt: string } | { success: false; error: string };

/** Whole seconds, as JMAP wants dates (no fractional part when it's zero). */
export function toJmapDate(at: Date): string {
	return new Date(Math.ceil(at.getTime() / 1000) * 1000).toISOString().replace('.000Z', 'Z');
}

export async function scheduleSend(opts: {
	mailAccountId: string;
	auth: AuthState;
	compose: ComposeEmail;
	identity: { id: string; email: string };
	sendAt: Date;
	/** The draft this message was being written as; it's replaced. */
	replaceDraftId?: string;
}): Promise<ScheduleResult> {
	const client = createClient(opts.auth);
	const { accountId } = opts.auth;
	const scheduledId = await ensureScheduledMailbox(client, accountId);
	if (!scheduledId) return { success: false, error: 'Could not create the Scheduled folder' };

	const sendAt = toJmapDate(opts.sendAt);
	const saved = await saveDraft(
		client,
		accountId,
		scheduledId,
		{ ...opts.compose, sentAt: sendAt },
		opts.replaceDraftId
	);
	if (!saved.success || !saved.id) return { success: false, error: saved.error ?? 'Could not schedule the message' };

	insertScheduledSend({
		mailAccountId: opts.mailAccountId,
		emailId: saved.id,
		identityId: opts.identity.id,
		envelope: buildEnvelope(opts.compose, opts.identity.email),
		sendAt: new Date(sendAt).toISOString()
	});
	wakeAt(new Date(sendAt));
	return { success: true, emailId: saved.id, sendAt: new Date(sendAt).toISOString() };
}

export type CancelResult =
	| { success: true; draftId: string }
	/**
	 * `unreachable`: nothing was changed and the message is still scheduled.
	 * `move-failed`: it will not be sent, but it is still in Scheduled.
	 */
	| { success: false; code: 'sending' | 'not-found' | 'unreachable' | 'move-failed'; error: string };

/** Stop a send and move the message to Drafts, where the composer can open it. */
export async function cancelScheduledSend(
	mailAccountId: string,
	auth: AuthState,
	emailId: string
): Promise<CancelResult> {
	// Reach the server before touching the row. Once the row is gone nothing
	// will send the message, so a lookup that fails after it was deleted left
	// the message stranded in Scheduled with the outbox reporting it sent.
	const client = createClient(auth);
	let drafts: string | undefined;
	try {
		drafts = (await getMailboxes(client, auth.accountId)).find((m) => m.role === 'drafts')?.id;
	} catch {
		return { success: false, code: 'unreachable', error: 'The mail server couldn’t be reached; the message is still scheduled' };
	}

	const row = cancelScheduledSendRow(mailAccountId, emailId);
	if (!row) {
		return getScheduledSend(mailAccountId, emailId)
			? { success: false, code: 'sending', error: 'Already sent' }
			: { success: false, code: 'not-found', error: 'This message isn’t scheduled' };
	}

	if (drafts) {
		try {
			const response = await client.request([
				[
					'Email/set',
					{ accountId: auth.accountId, update: { [emailId]: { mailboxIds: { [drafts]: true } } } },
					'0'
				]
			]);
			const result = response.methodResponses[0][1] as { updated?: Record<string, unknown> };
			if (result.updated && emailId in result.updated) return { success: true, draftId: emailId };
		} catch {
			// The row is gone, so the message stays unsent in Scheduled; the
			// composer replaces it there on its next save.
		}
	}
	return { success: false, code: 'move-failed', error: 'Not sent, but it couldn’t be moved to Drafts' };
}

/** Send a failed message again, now. */
export function retryScheduledSend(mailAccountId: string, emailId: string): boolean {
	const row = retryScheduledSendNow(mailAccountId, emailId);
	if (row) wakeAt(new Date());
	return !!row;
}

// --- Worker ---------------------------------------------------------------

interface WorkerState {
	running: boolean;
	again: boolean;
}

// On globalThis, not module scope: dev-server reloads re-evaluate this
// module, and two workers in one process could submit the same message.
const WORKER_KEY = Symbol.for('ameera.scheduledSendWorker');

function worker(): WorkerState | undefined {
	return (globalThis as Record<symbol, WorkerState | undefined>)[WORKER_KEY];
}

export function startScheduledSendWorker(): void {
	if (worker()) return;
	(globalThis as Record<symbol, WorkerState>)[WORKER_KEY] = { running: false, again: false };
	recoverInterruptedSends();
	setInterval(() => void sweep(), SWEEP_MS).unref?.();
	void sweep();
}

/** A send due before the next sweep gets its own timer, so Undo send is on time. */
function wakeAt(when: Date): void {
	const delay = when.getTime() - Date.now();
	if (delay > SWEEP_MS) return;
	setTimeout(() => void sweep(), Math.max(0, delay) + 50).unref?.();
}

async function sweep(): Promise<void> {
	const state = worker();
	if (!state) return;
	if (state.running) {
		state.again = true;
		return;
	}
	state.running = true;
	try {
		do {
			state.again = false;
			for (const row of claimDueSends()) await deliverScheduledSend(row);
		} while (state.again);
	} catch (err) {
		console.error('[scheduled-send] sweep failed', err);
	} finally {
		state.running = false;
	}
}

/**
 * Refusals the server may withdraw if the message is offered again later
 * (RFC 8620 §3.6.2 method errors and §5.3 set errors). Anything else — bad
 * properties, an unknown identity, a forbidden sender — would be refused
 * again, so it fails the row for the user to look at.
 */
const TRANSIENT_ERRORS = new Set(['serverUnavailable', 'serverPartialFail', 'rateLimit']);
const UNREACHABLE_ERROR = 'The mail server couldn’t be reached';
const NO_SCHEDULED_FOLDER_ERROR = 'The Scheduled folder couldn’t be found. Restore it, then try again.';

/** Try again later along the ladder; once it is used up, fail with `finalError`. */
function retryOrFail(row: ScheduledSendRow, error: string, finalError = error): void {
	const delay = RETRY_DELAYS_MS[row.attempts - 1];
	if (delay === undefined) failScheduledSend(row.id, finalError);
	else retryScheduledSendLater(row.id, new Date(Date.now() + delay).toISOString(), error);
}

/** One claimed row: send it, or record on the row why not. Exported for tests. */
export async function deliverScheduledSend(row: ScheduledSendRow): Promise<void> {
	const account = getAccount(row.mail_account_id);
	if (!account) {
		removeScheduledSend(row.id);
		return;
	}
	if (account.needs_reauth === 1) {
		failScheduledSend(row.id, REAUTH_ERROR);
		return;
	}

	let auth: AuthState;
	try {
		auth = authStateForAccount(account);
	} catch {
		failScheduledSend(row.id, REAUTH_ERROR);
		return;
	}

	try {
		const client = createClient(auth);
		const mailboxes = await getMailboxes(client, auth.accountId);
		const scheduled = mailboxes.find(isScheduledMailbox);
		const sent = mailboxes.find((m) => m.role === 'sent');
		if (!scheduled) {
			// An IMAP client can rename or move the folder. The row used to be
			// dropped here, which read as "sent" everywhere; now it says why.
			failScheduledSend(row.id, NO_SCHEDULED_FOLDER_ERROR);
			return;
		}
		if (!sent) {
			failScheduledSend(row.id, 'Sent folder not found');
			return;
		}

		const result = await submitStoredEmail(
			client,
			auth.accountId,
			row.jmap_email_id,
			row.identity_id,
			JSON.parse(row.envelope),
			{ scheduled: scheduled.id, sent: sent.id }
		);
		if (result.status === 'failed') {
			if (result.type && TRANSIENT_ERRORS.has(result.type)) retryOrFail(row, result.error);
			else failScheduledSend(row.id, result.error);
		} else {
			removeScheduledSend(row.id);
		}
	} catch (err) {
		if (err instanceof JMAPAuthError) {
			markNeedsReauth(account.id);
			failScheduledSend(row.id, REAUTH_ERROR);
			return;
		}
		if (err instanceof JMAPMethodError && !TRANSIENT_ERRORS.has(err.type)) {
			failScheduledSend(row.id, err.description || err.type);
			return;
		}
		// Network trouble, a timeout, or a refusal the server may withdraw:
		// try again in a while, then give up.
		console.error('[scheduled-send] send failed', row.id, err);
		retryOrFail(
			row,
			err instanceof Error ? err.message : String(err),
			err instanceof JMAPMethodError ? err.description || err.type : UNREACHABLE_ERROR
		);
	}
}
