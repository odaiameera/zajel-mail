import type { JMAPClient } from '$lib/jmap/client';
import type { AuthState, Email, Mailbox } from '$lib/jmap/types';
import {
	getEmailDetail,
	moveEmails,
	searchEmails,
	setEmailCategory,
	updateEmailMailboxes
} from '$lib/jmap/email';
import { ensureArchiveMailbox, ensureRemindMeLaterMailbox, getMailboxes } from '$lib/jmap/mailbox';
import { categoryOf, INBOX_CATEGORIES, isInboxCategory } from '$lib/types/categories';
import { labelMailboxIds } from '$lib/types/labels';
import { getEventsInRange } from '$lib/server/calendar/service';
import { parseWallClock, wallClockToUtc } from '$lib/server/calendar/tz';
import { scheduleReminder } from '$lib/server/db/queries/reminders';
import { getDecision } from '$lib/server/db/queries/jev-decisions';
import { htmlToPromptText } from '$lib/server/ai/extract-event';
import { createPendingAction, type AgentSource, type PendingAction, type ToolTier } from './store';
import { composeReply, saveComposedDraft, type ComposeRequest } from './compose';

/**
 * The agent's tools. Every tool declares a tier and the server enforces it,
 * whatever the model was talked into:
 *
 * - read: looks, changes nothing;
 * - self: reversible and only touches your own mailbox (mark, flag, file,
 *   Trash, snooze, a draft); runs straight away and is logged;
 * - outward: leaves the account (sending); never runs from a model turn,
 *   only becomes a pending action you confirm.
 */

export interface ToolContext {
	auth: AuthState;
	client: JMAPClient;
	userId: string;
	/** The mail account's own address. */
	userEmail: string;
	/** The linked-account row the agent is working in. */
	accountRowId: string;
	conversationId: string | null;
	source: AgentSource;
	timeZone: string;
	mailboxes(): Promise<Mailbox[]>;
}

export interface ToolResult {
	/** What the model is told. */
	content: string;
	isError?: boolean;
	/** A self-tier change that happened, for the reply and the audit log. */
	done?: string;
	/** An outward change waiting for your click. */
	pending?: PendingAction;
}

export interface AgentTool {
	name: string;
	description: string;
	tier: ToolTier;
	input_schema: Record<string, unknown>;
	run(ctx: ToolContext, input: Record<string, unknown>): Promise<ToolResult>;
}

const MAX_IDS = 100;
const MAX_RESULTS = 40;

// --- helpers -----------------------------------------------------------------

function str(value: unknown, max = 500): string {
	return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function ids(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return [...new Set(value.filter((v): v is string => typeof v === 'string' && /^[A-Za-z0-9_-]{1,255}$/.test(v)))].slice(0, MAX_IDS);
}

function schema(properties: Record<string, unknown>, required: string[] = Object.keys(properties)) {
	return { type: 'object', properties, required, additionalProperties: false };
}

const ID_LIST = { type: 'array', items: { type: 'string' }, description: 'Email ids from search_mail or inbox_triage.' };

/** Plain text of a message: its text/plain part, or its HTML turned into text. */
export function emailBodyText(email: Email, max = 8000): string {
	const values = email.bodyValues ?? {};
	const join = (parts: Email['textBody']) =>
		(parts ?? []).map((part) => values[part.partId]?.value ?? '').join('\n').trim();
	const plain = join(email.textBody?.filter((part) => part.type?.toLowerCase().startsWith('text/plain')));
	if (plain) return plain.slice(0, max);
	const html = join(email.htmlBody?.filter((part) => part.type?.toLowerCase().startsWith('text/html')));
	return html ? htmlToPromptText(html, max) : (email.preview ?? '');
}

function who(list: Email['from']): string {
	return (list ?? []).map((a) => (a.name ? `${a.name} <${a.email}>` : a.email)).join(', ');
}

/** Folder names a message is in, Junk and Trash spelled out so they're never mistaken for Inbox mail. */
function placeOf(email: Email, boxes: Mailbox[]): string {
	return boxes
		.filter((m) => email.mailboxIds?.[m.id])
		.map((m) => m.name)
		.join(', ');
}

function summaryLine(email: Email, boxes: Mailbox[]): string {
	const flags = [
		email.keywords?.$seen ? '' : 'unread',
		email.keywords?.$flagged ? 'starred' : ''
	].filter(Boolean);
	return [
		`id=${email.id}`,
		`date=${email.receivedAt}`,
		`from=${who(email.from)}`,
		`subject=${JSON.stringify(email.subject ?? '')}`,
		`in=${placeOf(email, boxes)}`,
		`tab=${categoryOf(email.keywords ?? {})}`,
		flags.length ? flags.join(',') : '',
		`preview=${JSON.stringify((email.preview ?? '').slice(0, 160))}`
	]
		.filter(Boolean)
		.join(' | ');
}

/** Email content is written by strangers: the model sees it fenced as data. */
function untrusted(kind: string, id: string, text: string): string {
	return `<untrusted_${kind} id="${id}">\n${text.replace(/<\/?untrusted_/g, '')}\n</untrusted_${kind}>`;
}

async function inbox(ctx: ToolContext): Promise<Mailbox> {
	const box = (await ctx.mailboxes()).find((m) => m.role === 'inbox');
	if (!box) throw new Error('This account has no Inbox');
	return box;
}

function plural(n: number, word: string): string {
	return `${n} ${word}${n === 1 ? '' : 's'}`;
}

// --- read --------------------------------------------------------------------

const searchMail: AgentTool = {
	name: 'search_mail',
	tier: 'read',
	description:
		'Search every folder, newest first. Give at least one of text, from, after or before. Dates are ISO (YYYY-MM-DD or a full timestamp). Results show id, sender, subject, folder, tab and a preview.',
	input_schema: schema({
		text: { type: ['string', 'null'] },
		from: { type: ['string', 'null'] },
		after: { type: ['string', 'null'] },
		before: { type: ['string', 'null'] },
		unread_only: { type: 'boolean' },
		limit: { type: 'integer' }
	}),
	async run(ctx, input) {
		const conditions: Record<string, unknown>[] = [];
		if (str(input.text)) conditions.push({ text: str(input.text, 200) });
		if (str(input.from)) conditions.push({ from: str(input.from, 200) });
		for (const key of ['after', 'before'] as const) {
			const value = str(input[key], 40);
			const at = value ? new Date(value.length === 10 ? `${value}T00:00:00Z` : value) : null;
			if (at && !Number.isNaN(at.getTime())) conditions.push({ [key]: at.toISOString() });
		}
		if (input.unread_only === true) conditions.push({ notKeyword: '$seen' });
		if (conditions.length === 0) {
			conditions.push({ inMailbox: (await inbox(ctx)).id });
		}
		const filter = conditions.length === 1 ? conditions[0] : { operator: 'AND', conditions };
		const limit = Math.min(Math.max(Number(input.limit) || 15, 1), MAX_RESULTS);
		const [boxes, { emails, total }] = await Promise.all([
			ctx.mailboxes(),
			searchEmails(ctx.client, ctx.auth.accountId, filter, { limit })
		]);
		if (emails.length === 0) return { content: 'No messages matched.' };
		return {
			content: `${total} matched; showing ${emails.length}.\n${emails
				.map((e) => untrusted('email_summary', e.id, summaryLine(e, boxes)))
				.join('\n')}`
		};
	}
};

const readEmail: AgentTool = {
	name: 'read_email',
	tier: 'read',
	description: 'Read one message in full: headers and body text.',
	input_schema: schema({ email_id: { type: 'string' } }),
	async run(ctx, input) {
		const [id] = ids([input.email_id]);
		if (!id) return { content: 'email_id is not valid', isError: true };
		const [boxes, email] = await Promise.all([ctx.mailboxes(), getEmailDetail(ctx.client, ctx.auth.accountId, id)]);
		const head = [
			`From: ${who(email.from)}`,
			`To: ${who(email.to)}`,
			email.cc?.length ? `Cc: ${who(email.cc)}` : '',
			`Date: ${email.receivedAt}`,
			`Subject: ${email.subject ?? ''}`,
			`Folder: ${placeOf(email, boxes)}`,
			email.attachments?.length ? `Attachments: ${email.attachments.map((a) => a.name ?? a.type).join(', ')}` : ''
		]
			.filter(Boolean)
			.join('\n');
		return { content: untrusted('email', id, `${head}\n\n${emailBodyText(email)}`) };
	}
};

const listFolders: AgentTool = {
	name: 'list_folders',
	tier: 'read',
	description: 'The account’s folders and labels, with their ids, for moving or labelling mail.',
	input_schema: schema({}),
	async run(ctx) {
		const boxes = await ctx.mailboxes();
		const labels = labelMailboxIds(boxes);
		return {
			content: boxes
				.map((m) => `id=${m.id} | ${labels.has(m.id) ? 'label' : 'folder'} | ${m.name}${m.role ? ` (${m.role})` : ''}`)
				.join('\n')
		};
	}
};

const inboxTriage: AgentTool = {
	name: 'inbox_triage',
	tier: 'read',
	description:
		'Recent Inbox mail with the tab each message is in and how sure Jev was. Messages in Updates, Newsletters or Promotions that Jev sorted with high confidence are the unimportant ones.',
	input_schema: schema({ limit: { type: 'integer' }, unread_only: { type: 'boolean' } }),
	async run(ctx, input) {
		const box = await inbox(ctx);
		const filter = input.unread_only === true
			? { operator: 'AND', conditions: [{ inMailbox: box.id }, { notKeyword: '$seen' }] }
			: { inMailbox: box.id };
		const limit = Math.min(Math.max(Number(input.limit) || 30, 1), MAX_RESULTS);
		const [boxes, { emails }] = await Promise.all([
			ctx.mailboxes(),
			searchEmails(ctx.client, ctx.auth.accountId, filter, { limit })
		]);
		if (emails.length === 0) return { content: 'The Inbox has nothing matching.' };
		const lines = emails.map((e) => {
			const decision = getDecision(ctx.accountRowId, e.id);
			const jev = decision?.status === 'done' && decision.category
				? `jev=${decision.category}@${(decision.confidence ?? 0).toFixed(2)}`
				: 'jev=none';
			return untrusted('email_summary', e.id, `${summaryLine(e, boxes)} | ${jev}`);
		});
		return { content: lines.join('\n') };
	}
};

const searchCalendar: AgentTool = {
	name: 'search_calendar',
	tier: 'read',
	description: 'Events between two ISO dates or instants (after inclusive, before exclusive).',
	input_schema: schema({ after: { type: 'string' }, before: { type: 'string' } }),
	async run(ctx, input) {
		const from = Date.parse(str(input.after, 40));
		const to = Date.parse(str(input.before, 40));
		if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) {
			return { content: 'after and before must be dates with after first', isError: true };
		}
		const { events, partial } = await getEventsInRange(ctx.auth, ctx.userEmail, from, Math.min(to, from + 366 * 86_400_000));
		if (events.length === 0) return { content: partial ? 'No events found (some calendars failed to load).' : 'No events.' };
		return {
			content: events
				.slice(0, 60)
				.map((e) => untrusted('event', e.id, `${e.title} | ${e.start} – ${e.end}${e.location ? ` | ${e.location}` : ''}`))
				.join('\n')
		};
	}
};

// --- self: reversible, your own mailbox ---------------------------------------

function keywordTool(name: string, description: string, field: string, keyword: string, on: string, off: string): AgentTool {
	return {
		name,
		tier: 'self',
		description,
		input_schema: schema({ email_ids: ID_LIST, [field]: { type: 'boolean' } }),
		async run(ctx, input) {
			const list = ids(input.email_ids);
			if (list.length === 0) return { content: 'No valid email ids', isError: true };
			const value = input[field] !== false;
			await updateEmailMailboxes(
				ctx.client,
				ctx.auth.accountId,
				Object.fromEntries(list.map((id) => [id, { keywords: { [keyword]: value } }]))
			);
			const done = `${value ? on : off} ${plural(list.length, 'message')}`;
			return { content: `Done: ${done}.`, done };
		}
	};
}

const markRead = keywordTool('mark_read', 'Mark messages read (read=true) or unread (read=false).', 'read', '$seen', 'Marked read', 'Marked unread');
const flag = keywordTool('star', 'Star (starred=true) or unstar messages.', 'starred', '$flagged', 'Starred', 'Unstarred');

const archive: AgentTool = {
	name: 'archive',
	tier: 'self',
	description: 'Move messages out of their folders into Archive; labels stay.',
	input_schema: schema({ email_ids: ID_LIST }),
	async run(ctx, input) {
		const list = ids(input.email_ids);
		if (list.length === 0) return { content: 'No valid email ids', isError: true };
		const target = await ensureArchiveMailbox(ctx.client, ctx.auth.accountId);
		if (!target) return { content: 'Could not find or create Archive', isError: true };
		await moveEmails(ctx.client, ctx.auth.accountId, list, target, undefined, labelMailboxIds(await ctx.mailboxes()));
		const done = `Archived ${plural(list.length, 'message')}`;
		return { content: `Done: ${done}.`, done };
	}
};

const moveToTrash: AgentTool = {
	name: 'move_to_trash',
	tier: 'self',
	description: 'Move messages to Trash (recoverable until Trash is emptied). Never deletes outright.',
	input_schema: schema({ email_ids: ID_LIST }),
	async run(ctx, input) {
		const list = ids(input.email_ids);
		if (list.length === 0) return { content: 'No valid email ids', isError: true };
		const boxes = await ctx.mailboxes();
		const trash = boxes.find((m) => m.role === 'trash');
		if (!trash) return { content: 'This account has no Trash', isError: true };
		await moveEmails(ctx.client, ctx.auth.accountId, list, trash.id, undefined, labelMailboxIds(boxes));
		const done = `Moved ${plural(list.length, 'message')} to Trash`;
		return { content: `Done: ${done}.`, done };
	}
};

const moveToFolder: AgentTool = {
	name: 'move_to_folder',
	tier: 'self',
	description: 'Move messages into a folder from list_folders (not a label; use set_label for those).',
	input_schema: schema({ email_ids: ID_LIST, folder_id: { type: 'string' } }),
	async run(ctx, input) {
		const list = ids(input.email_ids);
		const boxes = await ctx.mailboxes();
		const labels = labelMailboxIds(boxes);
		const folder = boxes.find((m) => m.id === input.folder_id && !labels.has(m.id));
		if (list.length === 0 || !folder) return { content: 'Unknown folder or no valid email ids', isError: true };
		await moveEmails(ctx.client, ctx.auth.accountId, list, folder.id, undefined, labels);
		const done = `Moved ${plural(list.length, 'message')} to ${folder.name}`;
		return { content: `Done: ${done}.`, done };
	}
};

const setLabel: AgentTool = {
	name: 'set_label',
	tier: 'self',
	description: 'Add (on=true) or remove a label from list_folders on messages.',
	input_schema: schema({ email_ids: ID_LIST, label_id: { type: 'string' }, on: { type: 'boolean' } }),
	async run(ctx, input) {
		const list = ids(input.email_ids);
		const boxes = await ctx.mailboxes();
		const label = boxes.find((m) => m.id === input.label_id && labelMailboxIds(boxes).has(m.id));
		if (list.length === 0 || !label) return { content: 'Unknown label or no valid email ids', isError: true };
		const on = input.on !== false;
		await updateEmailMailboxes(
			ctx.client,
			ctx.auth.accountId,
			Object.fromEntries(list.map((id) => [id, on ? { add: [label.id] } : { remove: [label.id] }]))
		);
		const done = `${on ? 'Labelled' : 'Removed the label from'} ${plural(list.length, 'message')}${on ? ` ${label.name}` : ''}`;
		return { content: `Done: ${done}.`, done };
	}
};

const setTab: AgentTool = {
	name: 'set_tab',
	tier: 'self',
	description: `Move Inbox messages to a tab: ${INBOX_CATEGORIES.map((c) => c.key).join(', ')}.`,
	input_schema: schema({ email_ids: ID_LIST, tab: { type: 'string', enum: INBOX_CATEGORIES.map((c) => c.key) } }),
	async run(ctx, input) {
		const list = ids(input.email_ids);
		if (list.length === 0 || !isInboxCategory(input.tab)) return { content: 'Unknown tab or no valid email ids', isError: true };
		await setEmailCategory(ctx.client, ctx.auth.accountId, list, input.tab);
		const done = `Moved ${plural(list.length, 'message')} to ${input.tab}`;
		return { content: `Done: ${done}.`, done };
	}
};

const snooze: AgentTool = {
	name: 'snooze',
	tier: 'self',
	description: 'Hide a message in Remind Me Later until a local time ("YYYY-MM-DDTHH:mm" in the user’s time zone); it then returns unread.',
	input_schema: schema({ email_id: { type: 'string' }, until: { type: 'string' } }),
	async run(ctx, input) {
		const [id] = ids([input.email_id]);
		const wall = parseWallClock(str(input.until, 20));
		if (!id || !wall) return { content: 'email_id or until is not valid', isError: true };
		const at = wallClockToUtc(wall, ctx.timeZone);
		if (at <= Date.now()) return { content: 'until must be in the future', isError: true };
		const boxes = await ctx.mailboxes();
		const email = await getEmailDetail(ctx.client, ctx.auth.accountId, id);
		const labels = labelMailboxIds(boxes);
		const source = Object.keys(email.mailboxIds ?? {}).find((m) => !labels.has(m));
		const rml = await ensureRemindMeLaterMailbox(ctx.client, ctx.auth.accountId);
		if (!source || !rml || source === rml) return { content: 'That message can’t be snoozed', isError: true };
		await moveEmails(ctx.client, ctx.auth.accountId, [id], rml, source);
		scheduleReminder(ctx.userEmail, ctx.auth.accountId, id, source, new Date(at).toISOString());
		const done = `Snoozed “${email.subject ?? 'a message'}” until ${str(input.until, 20).replace('T', ' ')}`;
		return { content: `Done: ${done}.`, done };
	}
};

const COMPOSE_PROPS = {
	to: { type: 'array', items: { type: 'string' }, description: 'Addresses. For a reply, leave empty to answer the sender.' },
	cc: { type: 'array', items: { type: 'string' } },
	subject: { type: ['string', 'null'], description: 'Leave null for a reply.' },
	reply_to_email_id: { type: ['string', 'null'] },
	points: { type: 'string', description: 'What the message must say. It is written up for you.' },
	exact_body: { type: ['string', 'null'], description: 'Only when the user dictated the exact text.' }
};

function composeInput(input: Record<string, unknown>): ComposeRequest {
	const list = (value: unknown) =>
		(Array.isArray(value) ? value : []).filter((v): v is string => typeof v === 'string').map((v) => v.trim()).slice(0, 20);
	return {
		to: list(input.to),
		cc: list(input.cc),
		subject: str(input.subject, 300) || null,
		replyToEmailId: ids([input.reply_to_email_id])[0] ?? null,
		points: str(input.points, 4000),
		exactBody: str(input.exact_body, 20_000) || null
	};
}

const saveDraftTool: AgentTool = {
	name: 'save_draft',
	tier: 'self',
	description: 'Write a message and save it to Drafts without sending, for the user to review.',
	input_schema: schema(COMPOSE_PROPS),
	async run(ctx, input) {
		const message = await composeReply(ctx, composeInput(input));
		if ('error' in message) return { content: message.error, isError: true };
		const saved = await saveComposedDraft(ctx, message);
		if (!saved.success) return { content: saved.error ?? 'Could not save the draft', isError: true };
		const done = `Saved a draft to ${message.to.join(', ')}: “${message.subject}”`;
		return { content: `Done: ${done}.\n\n${message.text}`, done };
	}
};

// --- outward: needs your click ------------------------------------------------

const sendEmail: AgentTool = {
	name: 'send_email',
	tier: 'outward',
	description:
		'Write a message to send. Nothing is sent by this call: the user sees exactly what will go and confirms it. Say so in your reply.',
	input_schema: schema(COMPOSE_PROPS),
	async run(ctx, input) {
		const message = await composeReply(ctx, composeInput(input));
		if ('error' in message) return { content: message.error, isError: true };
		const pending = createPendingAction({
			userId: ctx.userId,
			accountId: ctx.accountRowId,
			conversationId: ctx.conversationId,
			kind: 'send_email',
			payload: { ...message }
		});
		return {
			content: `Waiting for the user to confirm sending to ${message.to.join(', ')}: “${message.subject}”. Nothing has been sent.`,
			pending
		};
	}
};

export const AGENT_TOOLS: AgentTool[] = [
	searchMail,
	readEmail,
	listFolders,
	inboxTriage,
	searchCalendar,
	markRead,
	flag,
	archive,
	moveToTrash,
	moveToFolder,
	setLabel,
	setTab,
	snooze,
	saveDraftTool,
	sendEmail
];

/** Tools allowed for a source: unattended runs never get outward ones. */
export function toolsFor(source: AgentSource): AgentTool[] {
	return source === 'chat' ? AGENT_TOOLS : AGENT_TOOLS.filter((t) => t.tier !== 'outward');
}

/** A per-request mailbox list, fetched once. */
export function mailboxCache(client: JMAPClient, accountId: string): () => Promise<Mailbox[]> {
	let list: Promise<Mailbox[]> | null = null;
	return () => (list ??= getMailboxes(client, accountId));
}
