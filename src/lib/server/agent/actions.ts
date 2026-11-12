import { authStateForAccount, getAccount, type MailAccountRow } from '$lib/server/auth/accounts';
import { composedHtml, holdComposed, saveComposedDraft, sendComposed, type ComposedMessage } from './compose';
import { getPrefs } from '$lib/server/db/queries/app-prefs';
import { parseUndoSendSeconds } from '$lib/server/compose-input';
import { createDraftedEvent, deleteConfirmedEvent, describeWhen, type EventDraft } from './calendar-tools';
import { describeSchedule, parseSchedule } from '$lib/server/jobs/schedule';
import { describeSpec, parseSpec } from '$lib/server/jobs/specs';
import { createJob } from '$lib/server/jobs/store';

/** Kinds whose confirm also needs a fresh re-check: they keep running unattended. */
export const STEP_UP_KINDS = new Set(['create_job']);
import {
	claimPendingAction,
	finishPendingAction,
	getPendingAction,
	recordAudit,
	type PendingAction
} from './store';

/**
 * Deciding a pending action. Confirming runs it in the account the agent
 * was working in, whichever account is active now, and only once.
 */

export type Decision = 'confirm' | 'cancel';

/** A send held for the Undo send window, and what the composer reopens with if it's taken back. */
export interface HeldSend {
	scheduled: { emailId: string; sendAt: string; undo: true };
	restore: { to: string; cc: string; subject: string; body: string; inReplyTo: string; references: string };
}

type ExecutorResult = { success: boolean; message: string } & Partial<HeldSend>;
type Executor = (action: PendingAction) => Promise<ExecutorResult>;

const ADDRESS = /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[^\s@<>()",;:]+$/;

function asMessage(payload: Record<string, unknown>): ComposedMessage | null {
	const list = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
	const message: ComposedMessage = {
		to: list(payload.to),
		cc: list(payload.cc),
		subject: typeof payload.subject === 'string' ? payload.subject : '',
		text: typeof payload.text === 'string' ? payload.text : '',
		inReplyTo: typeof payload.inReplyTo === 'string' ? payload.inReplyTo : null,
		references: typeof payload.references === 'string' ? payload.references : null,
		replyToEmailId: typeof payload.replyToEmailId === 'string' ? payload.replyToEmailId : null,
		// Written by the server when the card was made (quote.ts), never by the model.
		quoteHtml: typeof payload.quoteHtml === 'string' ? payload.quoteHtml : null
	};
	const valid = message.to.length > 0 && [...message.to, ...message.cc].every((a) => ADDRESS.test(a)) && message.subject;
	return valid ? message : null;
}

/** The account an action was proposed in, if it still belongs to the same login. */
function ownAccount(action: PendingAction): MailAccountRow | null {
	const account = getAccount(action.accountId);
	return account && account.user_id === action.userId ? account : null;
}

function asEventDraft(payload: Record<string, unknown>): EventDraft | null {
	const text = (v: unknown) => (typeof v === 'string' ? v : '');
	const attendees = Array.isArray(payload.attendees) ? payload.attendees.filter((a): a is string => typeof a === 'string') : [];
	if (!text(payload.calendarId) || !text(payload.title) || !text(payload.start) || !text(payload.end)) return null;
	if (!attendees.every((a) => ADDRESS.test(a))) return null;
	return {
		calendarId: text(payload.calendarId),
		calendarName: text(payload.calendarName),
		title: text(payload.title),
		allDay: payload.allDay === true,
		start: text(payload.start),
		end: text(payload.end),
		timeZone: text(payload.timeZone) || 'UTC',
		location: text(payload.location),
		description: text(payload.description),
		attendees
	};
}

const EXECUTORS: Record<string, Executor> = {
	async send_email(action) {
		const message = asMessage(action.payload);
		const account = ownAccount(action);
		if (!message || !account) return { success: false, message: 'That message can no longer be sent' };
		// Settings → Undo send covers Zajel's sends too: the message waits that
		// long in Scheduled, and Undo puts it back in Drafts.
		const undo = parseUndoSendSeconds(getPrefs(action.userId).undo_send_seconds);
		if (undo > 0) {
			const held = await holdComposed(authStateForAccount(account), account.id, account.email, message, new Date(Date.now() + undo * 1000));
			if (!held.success) return { success: false, message: held.error };
			return {
				success: true,
				message: `Sending to ${message.to.join(', ')} in ${undo} seconds`,
				scheduled: { emailId: held.emailId, sendAt: held.sendAt, undo: true },
				restore: {
					to: message.to.join(', '),
					cc: message.cc.join(', '),
					subject: message.subject,
					body: composedHtml(message),
					inReplyTo: message.inReplyTo ?? '',
					references: message.references ?? ''
				}
			};
		}
		const result = await sendComposed(authStateForAccount(account), account.email, message);
		return result.success
			? { success: true, message: `Sent to ${message.to.join(', ')}` }
			: { success: false, message: result.error ?? 'The message could not be sent' };
	},

	// A draft to someone other than the user: saved, not sent.
	async save_draft(action) {
		const message = asMessage(action.payload);
		const account = ownAccount(action);
		if (!message || !account) return { success: false, message: 'That draft can no longer be saved' };
		const result = await saveComposedDraft(authStateForAccount(account), account.email, message);
		return result.success
			? { success: true, message: `Saved a draft to ${message.to.join(', ')}` }
			: { success: false, message: result.error ?? 'The draft could not be saved' };
	},

	// Stalwart sends the invitations once an event with attendees is saved.
	async create_event(action) {
		const draft = asEventDraft(action.payload);
		const account = ownAccount(action);
		if (!draft || !account) return { success: false, message: 'That event can no longer be added' };
		await createDraftedEvent(authStateForAccount(account), account.email, action.userId, draft);
		return {
			success: true,
			message: draft.attendees.length
				? `Added “${draft.title}” and invited ${draft.attendees.join(', ')}`
				: `Added “${draft.title}” to ${draft.calendarName || 'the calendar'}`
		};
	},

	async create_job(action) {
		const p = action.payload;
		const spec = parseSpec(p.spec);
		const schedule = parseSchedule(p.schedule);
		const account = ownAccount(action);
		if (!spec || !schedule || !account || typeof p.title !== 'string') {
			return { success: false, message: 'That job can no longer be set up' };
		}
		const job = createJob({
			userId: action.userId,
			accountId: account.id,
			title: p.title,
			spec,
			schedule,
			timeZone: typeof p.timeZone === 'string' ? p.timeZone : 'UTC'
		});
		return 'error' in job ? { success: false, message: job.error } : { success: true, message: `Scheduled “${job.title}”` };
	},

	async delete_event(action) {
		const account = ownAccount(action);
		if (!account || typeof action.payload.eventId !== 'string') {
			return { success: false, message: 'That event can no longer be deleted' };
		}
		return { success: true, message: await deleteConfirmedEvent(authStateForAccount(account), account.email, action.payload) };
	}
};

export async function decidePendingAction(
	userId: string,
	id: string,
	decision: Decision,
	/** Where the click came from: the web app's card, or a button in the Telegram chat. */
	source: 'chat' | 'telegram' = 'chat'
): Promise<{ status: number; message: string } & Partial<HeldSend>> {
	const action = getPendingAction(userId, id);
	if (!action) return { status: 404, message: 'Unknown action' };
	const executor = EXECUTORS[action.kind];
	if (!executor) return { status: 400, message: 'Unknown action' };
	if (!claimPendingAction(userId, id, decision === 'confirm' ? 'done' : 'cancelled')) {
		return { status: 409, message: action.status === 'expired' ? 'This has expired' : 'This was already decided' };
	}

	const audit = (summary: string, outcome: 'done' | 'refused' | 'failed') =>
		recordAudit({ userId, accountId: action.accountId, source, tool: action.kind, tier: 'outward', summary, outcome });

	if (decision === 'cancel') {
		audit(`Cancelled ${action.kind.replace('_', ' ')}`, 'refused');
		return { status: 200, message: 'Cancelled' };
	}
	try {
		const result = await executor(action);
		finishPendingAction(id, result.success ? 'done' : 'failed', result.message);
		audit(result.message, result.success ? 'done' : 'failed');
		return {
			status: result.success ? 200 : 502,
			message: result.message,
			...(result.scheduled && result.restore && { scheduled: result.scheduled, restore: result.restore })
		};
	} catch (err) {
		const message = err instanceof Error ? err.message.slice(0, 200) : 'Failed';
		finishPendingAction(id, 'failed', message);
		audit(message, 'failed');
		return { status: 502, message };
	}
}

export interface PendingView {
	id: string;
	kind: string;
	/** What kind of change, e.g. "Send email". */
	label: string;
	title: string;
	lines: string[];
	body: string | null;
	confirmLabel: string;
	danger: boolean;
}

/** What the card shows: exactly what will run, from the stored payload. */
export function pendingView(action: PendingAction): PendingView {
	const p = action.payload;
	const list = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
	const base = { id: action.id, kind: action.kind, body: null, danger: false };
	// A message as the card shows it: who gets it, and exactly what it says.
	const message = (label: string, confirmLabel: string): PendingView => ({
		...base,
		label,
		title: String(p.subject ?? ''),
		lines: [
			`To ${list(p.to).join(', ')}`,
			...(list(p.cc).length ? [`Cc ${list(p.cc).join(', ')}`] : []),
			...(typeof p.quoteHtml === 'string' && p.quoteHtml ? ['With the original message quoted below it'] : [])
		],
		body: String(p.text ?? ''),
		confirmLabel
	});
	switch (action.kind) {
		case 'send_email':
			return message('Send email', 'Send');
		case 'save_draft':
			return message('Save draft', 'Save draft');
		case 'create_event': {
			const draft = asEventDraft(p);
			const attendees = list(p.attendees);
			return {
				...base,
				label: attendees.length ? 'Send invitations' : 'Add event',
				title: String(p.title ?? ''),
				lines: [
					...(draft ? [describeWhen(draft)] : []),
					...(p.calendarName ? [`In ${String(p.calendarName)}`] : []),
					...(p.location ? [String(p.location)] : []),
					...(attendees.length ? [`Invite ${attendees.join(', ')}`] : [])
				],
				// Everything the attendees will read is on the card: the
				// description goes into the invitation, so it is shown whole.
				body: p.description ? String(p.description) : null,
				confirmLabel: attendees.length ? 'Add and invite' : 'Add to calendar'
			};
		}
		case 'create_job': {
			const spec = parseSpec(p.spec);
			const schedule = parseSchedule(p.schedule);
			const zone = typeof p.timeZone === 'string' ? p.timeZone : 'UTC';
			return {
				...base,
				label: 'Schedule a job',
				title: String(p.title ?? ''),
				lines: [...(schedule ? [describeSchedule(schedule, zone)] : []), ...(spec ? [describeSpec(spec)] : [])],
				confirmLabel: 'Schedule'
			};
		}
		case 'delete_event':
			return {
				...base,
				label: 'Delete event',
				title: String(p.title ?? ''),
				lines: [
					String(p.when ?? ''),
					...(p.recurring ? [p.occurrence ? 'This occurrence only' : 'Every occurrence'] : [])
				],
				confirmLabel: 'Delete',
				danger: true
			};
		default:
			return { ...base, label: action.kind, title: '', lines: [], confirmLabel: 'Confirm' };
	}
}
