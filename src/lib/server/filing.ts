import type { JMAPClient } from '$lib/jmap/client';
import type { Mailbox } from '$lib/jmap/types';
import {
	emailMailboxMembership,
	sendEmailUpdates,
	type EmailUpdateFailure
} from '$lib/jmap/email';
import { ensureArchiveMailbox, ensureRemindMeLaterMailbox, getMailboxes } from '$lib/jmap/mailbox';
import {
	canMoveInto,
	isRemindMeLaterMailbox,
	mailboxKind,
	nextMailboxIds,
	sameMailboxIds,
	type FilingOp
} from '$lib/mailboxes';
import { scheduleReminder } from '$lib/server/db/queries/reminders';

/**
 * Filing mail: what every caller that moves or labels a message uses (the
 * mail endpoints, the assistant, jobs, Telegram's buttons). A message is in
 * exactly one folder and any number of labels; the rules are written once,
 * in `nextMailboxIds` ($lib/mailboxes), and applied here to where each
 * message really is on the server, never to where a caller thought it was.
 *
 * Each function loads the mailboxes (unless given them), refuses a bad
 * destination with a {@link FilingError}, and writes whole `mailboxIds`
 * objects: Stalwart v0.15.0 to v0.16.7 reject `mailboxIds/<id>` patches for
 * the all-digit mailbox ids it hands out (see `updateEmailMailboxes`). A
 * write the server refuses, or a message that no longer exists, comes back
 * as an `EmailUpdateError` naming each one.
 */

/** A destination that mail can't be filed into. The message says why, in plain words. */
export class FilingError extends Error {
	constructor(
		message: string,
		public status = 400
	) {
		super(message);
		this.name = 'FilingError';
	}
}

export interface FilingOptions {
	/** The account's mailboxes, when the caller has them already. */
	mailboxes?: Mailbox[];
}

/** Keywords to set (true) or clear (false) in the same write. */
type Keywords = Record<string, boolean>;

async function loadMailboxes(client: JMAPClient, accountId: string, opts?: FilingOptions): Promise<Mailbox[]> {
	return opts?.mailboxes ?? (await getMailboxes(client, accountId));
}

/**
 * Read where each message is, work out where it goes with `step`, and write
 * what differs. `step` returning null means it needs Archive (a message
 * that would otherwise be left in nothing); Archive is then found or made
 * and `step` asked again with it.
 */
async function file(
	client: JMAPClient,
	accountId: string,
	ids: string[],
	step: (current: Record<string, boolean>, archiveId: string | null) => Record<string, boolean> | null,
	archiveId: string | null,
	keywords: Keywords = {}
): Promise<void> {
	if (ids.length === 0) return;
	const membership = await emailMailboxMembership(client, accountId, ids);
	const failures: EmailUpdateFailure[] = [];
	const update: Record<string, Record<string, unknown>> = {};
	let archive = archiveId;

	for (const id of ids) {
		const current = membership.get(id);
		if (!current) {
			failures.push({ id, type: 'notFound', description: 'Email no longer exists' });
			continue;
		}
		let next = step(current, archive);
		if (next === null && archive === null) {
			archive = (await ensureArchiveMailbox(client, accountId)) || null;
			next = step(current, archive);
		}
		if (next === null) {
			failures.push({ id, type: 'invalidProperties', description: 'No Archive folder to put the message in' });
			continue;
		}
		const patch: Record<string, unknown> = {};
		if (!sameMailboxIds(next, current)) patch.mailboxIds = next;
		for (const [keyword, on] of Object.entries(keywords)) patch[`keywords/${keyword}`] = on;
		if (Object.keys(patch).length > 0) update[id] = patch;
	}

	await sendEmailUpdates(client, accountId, update, failures);
}

/** Archive as `ensureArchiveMailbox` finds it, without making one. */
function existingArchiveId(mailboxes: Mailbox[]): string | null {
	const archive =
		mailboxes.find((m) => m.role === 'archive') ??
		mailboxes.find((m) => m.parentId === null && !m.role && m.name.trim().toLowerCase() === 'archive');
	return archive?.id ?? null;
}

/** Why a mailbox can't be moved into, or null when it can. */
function refusal(target: Mailbox | undefined, mailboxes: Mailbox[]): string | null {
	if (!target) return 'That folder no longer exists.';
	if (canMoveInto(target, mailboxes)) return null;
	switch (mailboxKind(target, mailboxes)) {
		case 'labels-root':
			return '“Labels” holds your labels; it isn’t a folder.';
		case 'label':
			return `“${target.name}” is a label, not a folder.`;
		default:
			return `Mail can’t be moved into “${target.name}”.`;
	}
}

function stepFor(op: FilingOp, mailboxes: Mailbox[]) {
	return (current: Record<string, boolean>) => nextMailboxIds(current, op, mailboxes);
}

/**
 * Move messages into a folder, or the Inbox, Archive, Junk or Trash. Each
 * ends up there with all its labels, and out of every other folder.
 */
export async function moveToFolder(
	client: JMAPClient,
	accountId: string,
	ids: string[],
	targetId: string,
	opts?: FilingOptions & { keywords?: Keywords }
): Promise<void> {
	const mailboxes = await loadMailboxes(client, accountId, opts);
	const why = refusal(
		mailboxes.find((m) => m.id === targetId),
		mailboxes
	);
	if (why) throw new FilingError(why);
	await file(client, accountId, ids, stepFor({ move: targetId }, mailboxes), null, opts?.keywords);
}

function assertLabel(labelId: string, mailboxes: Mailbox[]): void {
	const label = mailboxes.find((m) => m.id === labelId);
	if (!label || mailboxKind(label, mailboxes) !== 'label') throw new FilingError('Not a label');
}

/** Add a label. Nothing else about the messages changes. */
export async function addLabel(
	client: JMAPClient,
	accountId: string,
	ids: string[],
	labelId: string,
	opts?: FilingOptions
): Promise<void> {
	const mailboxes = await loadMailboxes(client, accountId, opts);
	assertLabel(labelId, mailboxes);
	await file(client, accountId, ids, stepFor({ addLabel: labelId }, mailboxes), null);
}

/**
 * Take a label off. A message that would be left in no mailbox at all (it
 * was only in this label) goes to Archive, which is made if the account has
 * none.
 */
export async function removeLabel(
	client: JMAPClient,
	accountId: string,
	ids: string[],
	labelId: string,
	opts?: FilingOptions
): Promise<void> {
	const mailboxes = await loadMailboxes(client, accountId, opts);
	assertLabel(labelId, mailboxes);
	await file(
		client,
		accountId,
		ids,
		(current, archiveId) => nextMailboxIds(current, { removeLabel: labelId, archiveId }, mailboxes),
		existingArchiveId(mailboxes)
	);
}

/**
 * "Move to" as the mail endpoints take it: a folder is a move; a label adds
 * the label and moves nothing (a drop on a label in the sidebar, and older
 * clients that offered labels as places to move to). Anything else that is
 * not a folder is refused.
 */
export async function fileInto(
	client: JMAPClient,
	accountId: string,
	ids: string[],
	targetId: string,
	opts?: FilingOptions
): Promise<'moved' | 'labelled'> {
	const mailboxes = await loadMailboxes(client, accountId, opts);
	const target = mailboxes.find((m) => m.id === targetId);
	if (target && mailboxKind(target, mailboxes) === 'label') {
		await addLabel(client, accountId, ids, targetId, { mailboxes });
		return 'labelled';
	}
	await moveToFolder(client, accountId, ids, targetId, { mailboxes });
	return 'moved';
}

function roleId(mailboxes: Mailbox[], role: string, what: string): string {
	const id = mailboxes.find((m) => m.role === role)?.id;
	if (!id) throw new FilingError(`${what} folder not found`, 500);
	return id;
}

/** Move to Trash; labels stay. */
export async function moveToTrash(client: JMAPClient, accountId: string, ids: string[], opts?: FilingOptions): Promise<void> {
	const mailboxes = await loadMailboxes(client, accountId, opts);
	await moveToFolder(client, accountId, ids, roleId(mailboxes, 'trash', 'Trash'), { mailboxes });
}

/** Move to Archive, which is made if the account has none; labels stay. */
export async function moveToArchive(client: JMAPClient, accountId: string, ids: string[], opts?: FilingOptions): Promise<void> {
	let mailboxes = await loadMailboxes(client, accountId, opts);
	let archiveId = existingArchiveId(mailboxes);
	if (!archiveId) {
		archiveId = (await ensureArchiveMailbox(client, accountId)) || null;
		if (!archiveId) throw new FilingError('Could not create Archive', 500);
		mailboxes = await getMailboxes(client, accountId);
	}
	// Archive found by name has no role and is a folder; either way it may be moved into.
	await moveToFolder(client, accountId, ids, archiveId, { mailboxes });
}

/**
 * Spam: move to Junk and set `$junk` (clearing `$notjunk`), so Stalwart's
 * classifier learns from the correction. One write does both.
 */
export async function markSpam(client: JMAPClient, accountId: string, ids: string[], opts?: FilingOptions): Promise<void> {
	const mailboxes = await loadMailboxes(client, accountId, opts);
	await moveToFolder(client, accountId, ids, roleId(mailboxes, 'junk', 'Junk'), {
		mailboxes,
		keywords: { $junk: true, $notjunk: false }
	});
}

/** Not spam: back to the Inbox, with the keywords the other way round. */
export async function markNotSpam(client: JMAPClient, accountId: string, ids: string[], opts?: FilingOptions): Promise<void> {
	const mailboxes = await loadMailboxes(client, accountId, opts);
	await moveToFolder(client, accountId, ids, roleId(mailboxes, 'inbox', 'Inbox'), {
		mailboxes,
		keywords: { $junk: false, $notjunk: true }
	});
}

export interface SnoozeResult {
	/** The folder the message comes back to. */
	returnsTo: string;
}

/**
 * Snooze one message until `remindAt`: it is moved to Remind Me Later like
 * any other move (out of every folder, keeping its labels), and a reminder
 * brings it back to the folder it was in.
 *
 * `hint` is the folder the caller believes it is in, used only when the
 * message really is there; otherwise it returns to the first folder it is
 * in, or the Inbox. The same for the app, the assistant and Telegram.
 */
export async function snoozeEmail(
	client: JMAPClient,
	accountId: string,
	userEmail: string,
	emailId: string,
	remindAt: Date,
	hint?: string
): Promise<SnoozeResult> {
	let mailboxes = await getMailboxes(client, accountId);
	let rmlId = mailboxes.find(isRemindMeLaterMailbox)?.id;
	if (!rmlId) {
		rmlId = (await ensureRemindMeLaterMailbox(client, accountId)) || undefined;
		if (!rmlId) throw new FilingError('Could not create Remind Me Later mailbox', 500);
		mailboxes = await getMailboxes(client, accountId);
	}

	const current = (await emailMailboxMembership(client, accountId, [emailId])).get(emailId);
	if (!current) throw new FilingError('Email not found', 404);
	if (current[rmlId]) throw new FilingError('Email is already in Remind Me Later');

	// Somewhere to come back to: a folder or system folder, never a label,
	// the labels root, Scheduled, or Remind Me Later itself.
	const isHome = (id: string) => {
		const box = mailboxes.find((m) => m.id === id);
		if (!box) return false;
		const kind = mailboxKind(box, mailboxes);
		return kind === 'folder' || kind === 'system';
	};
	const homes = Object.keys(current).filter((id) => current[id] && isHome(id));
	const origin =
		(hint && current[hint] && isHome(hint) ? hint : undefined) ??
		homes[0] ??
		mailboxes.find((m) => m.role === 'inbox')?.id;
	if (!origin) throw new FilingError('No folder to return the email to', 500);

	// Remind Me Later is no place to move mail by hand (canMoveInto), so the
	// move is written here rather than through moveToFolder.
	await file(client, accountId, [emailId], stepFor({ move: rmlId }, mailboxes), null);
	scheduleReminder(userEmail, accountId, emailId, origin, remindAt.toISOString());
	return { returnsTo: origin };
}
