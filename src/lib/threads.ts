import type { Email, EmailAddress } from '$lib/jmap/types';

/**
 * Conversations: the messages of one thread shown and acted on as one.
 *
 * The mail server decides what a thread is (JMAP's Thread: messages joined by
 * their References and In-Reply-To headers, RFC 8621 §3). This is what the
 * app makes of one: which of its messages count in a given list, what the
 * list's row says, and which messages an action reaches.
 *
 * See docs/conversations-plan.md for the behaviour and why.
 */

/** The mailboxes that decide which of a thread's messages a list counts. */
export interface ThreadScope {
	/** The mailbox the list shows; null for a list that isn't one (Starred). */
	hereId: string | null;
	trashId: string | null;
	junkId: string | null;
	draftsId: string | null;
}

/** One person in a conversation, for the row's "Dana, me, Sam". */
export interface ThreadParticipant {
	name: string | null;
	email: string;
	/** They wrote a message that is still unread. */
	unread: boolean;
}

/** What a list knows about a conversation beyond the one message its row is built on. */
export interface ThreadSummary {
	threadId: string;
	/** Every message counted, oldest first. */
	ids: string[];
	/** The ones in the list's own mailbox: what Archive, Move and Snooze act on. */
	idsHere: string[];
	unreadIds: string[];
	flaggedIds: string[];
	/** The newest message that isn't a draft: what Mark unread and Star act on. */
	latestId: string;
	/** Who wrote, in order of first appearance, each once. */
	participants: ThreadParticipant[];
	hasAttachment: boolean;
	hasDraft: boolean;
	/** Every mailbox any counted message is in, for the row's label chips. */
	mailboxIds: Record<string, boolean>;
}

/** The fields of a message a summary is built from. */
export type ThreadMember = Pick<Email, 'id' | 'threadId' | 'mailboxIds' | 'keywords' | 'from' | 'receivedAt' | 'hasAttachment'>;

const isIn = (email: Pick<Email, 'mailboxIds'>, mailboxId: string | null) => !!mailboxId && email.mailboxIds[mailboxId] === true;

/**
 * Which of a thread's messages a list counts.
 *
 * In Trash or Junk, only what is in that mailbox: the list is of what was
 * thrown away, not of the conversations it came from. Everywhere else,
 * everything that isn't in Trash or Junk, wherever it is filed: your own
 * replies from Sent belong to the conversation in the Inbox.
 */
export function countedMembers<T extends Pick<Email, 'mailboxIds' | 'receivedAt'>>(members: T[], scope: ThreadScope): T[] {
	const inBin = scope.hereId !== null && (scope.hereId === scope.trashId || scope.hereId === scope.junkId);
	const counted = inBin
		? members.filter((m) => isIn(m, scope.hereId))
		: members.filter((m) => !isIn(m, scope.trashId) && !isIn(m, scope.junkId));
	return [...counted].sort((a, b) => a.receivedAt.localeCompare(b.receivedAt));
}

/** Summarise one thread for a list. `members` is every message of the thread, in any order. */
export function summariseThread(threadId: string, members: ThreadMember[], scope: ThreadScope): ThreadSummary {
	const counted = countedMembers(members, scope);
	const isDraft = (m: ThreadMember) => '$draft' in m.keywords || isIn(m, scope.draftsId);
	const unread = (m: ThreadMember) => !('$seen' in m.keywords) && !isDraft(m);

	const participants: ThreadParticipant[] = [];
	const seen = new Map<string, ThreadParticipant>();
	const mailboxIds: Record<string, boolean> = {};
	for (const m of counted) {
		for (const id of Object.keys(m.mailboxIds)) if (m.mailboxIds[id]) mailboxIds[id] = true;
		// A draft is yours and not sent: it shows as "Draft", not as a writer.
		if (isDraft(m)) continue;
		const from = m.from?.[0];
		if (!from?.email) continue;
		const key = from.email.trim().toLowerCase();
		const known = seen.get(key);
		if (known) {
			known.unread ||= unread(m);
			known.name ||= from.name ?? null;
		} else {
			const person = { name: from.name ?? null, email: from.email, unread: unread(m) };
			seen.set(key, person);
			participants.push(person);
		}
	}

	const sent = counted.filter((m) => !isDraft(m));
	return {
		threadId,
		ids: counted.map((m) => m.id),
		idsHere: counted.filter((m) => scope.hereId === null || isIn(m, scope.hereId)).map((m) => m.id),
		unreadIds: counted.filter(unread).map((m) => m.id),
		flaggedIds: counted.filter((m) => '$flagged' in m.keywords).map((m) => m.id),
		latestId: (sent[sent.length - 1] ?? counted[counted.length - 1])?.id ?? '',
		participants,
		hasAttachment: counted.some((m) => m.hasAttachment),
		hasDraft: counted.some(isDraft),
		mailboxIds
	};
}

/** First name, or the part of an address before the @: how a row names someone among others. */
export function shortName(person: Pick<EmailAddress, 'name' | 'email'>): string {
	const name = person.name?.trim();
	if (name) return name.split(/\s+/)[0].replace(/,$/, '');
	return person.email.split('@')[0];
}

/**
 * The row's names: "Dana Wade" for one writer, "Dana, me, Sam" for several
 * (first names, "me" for you), and with more than `max`, the first, "…" and
 * the last ones, so the person who started it and whoever wrote last both
 * show. Each comes with whether to draw it bold (they have an unread message).
 */
export function participantLine(
	participants: ThreadParticipant[],
	myAddresses: string[],
	max = 3
): { text: string; unread: boolean }[] {
	const mine = new Set(myAddresses.map((a) => a.trim().toLowerCase()));
	const isMe = (p: ThreadParticipant) => mine.has(p.email.trim().toLowerCase());
	if (participants.length === 0) return [];
	if (participants.length === 1) {
		const only = participants[0];
		return [{ text: isMe(only) ? 'me' : only.name?.trim() || only.email, unread: only.unread }];
	}
	const named = participants.map((p) => ({ text: isMe(p) ? 'me' : shortName(p), unread: p.unread }));
	if (named.length <= max) return named;
	return [named[0], { text: '…', unread: false }, ...named.slice(-(max - 1))];
}

/**
 * The messages each action reaches, for a conversation row.
 *
 *  - Archive, Move, Spam, Snooze and a move between Inbox tabs take what is
 *    in the list's own mailbox: archiving from the Inbox leaves your replies
 *    in Sent where they are.
 *  - Trash and Mark read take the whole conversation, as does a label.
 *  - Mark unread and Star mark its latest message: one unread message is
 *    enough to bring the conversation back, and a star says which message.
 *  - Unstar clears every star in it.
 */
export function actionIds(summary: ThreadSummary, action: string): string[] {
	switch (action) {
		case 'archive':
		case 'moveTo':
		case 'spam':
		case 'notSpam':
		case 'snooze':
		case 'setCategory':
			return summary.idsHere.length > 0 ? summary.idsHere : summary.ids;
		case 'markUnread':
		case 'flag':
			return summary.latestId ? [summary.latestId] : [];
		case 'unflag':
			return summary.flaggedIds;
		case 'markRead':
			return summary.unreadIds;
		default:
			return summary.ids;
	}
}

/**
 * Which messages open expanded: the unread ones, the one asked for, and the
 * last, so there is always something to read. A draft is always open: it is
 * yours to finish.
 */
export function expandedByDefault(
	messages: Pick<Email, 'id' | 'keywords'>[],
	focusId: string | null
): Set<string> {
	const open = new Set<string>();
	for (const m of messages) {
		if (!('$seen' in m.keywords) || '$draft' in m.keywords) open.add(m.id);
	}
	if (focusId && messages.some((m) => m.id === focusId)) open.add(focusId);
	const last = messages[messages.length - 1];
	if (last) open.add(last.id);
	return open;
}

/** How many collapsed messages in a row are folded into one "N earlier messages" line. */
export const FOLD_AFTER = 4;

/**
 * A long run of collapsed messages, folded: the conversation shows its
 * first message, a line for the rest of the run, and what follows. Returns
 * the runs to fold, as [start, end) indexes into `messages`; a run keeps its
 * first and last message showing.
 */
export function foldedRuns(messages: Pick<Email, 'id'>[], expanded: Set<string>): [number, number][] {
	const runs: [number, number][] = [];
	let start = -1;
	const close = (end: number) => {
		// Keep the first and last of the run in view; fold what is between.
		if (start !== -1 && end - start >= FOLD_AFTER) runs.push([start + 1, end - 1]);
		start = -1;
	};
	messages.forEach((m, i) => {
		if (expanded.has(m.id)) close(i);
		else if (start === -1) start = i;
	});
	close(messages.length);
	return runs;
}
