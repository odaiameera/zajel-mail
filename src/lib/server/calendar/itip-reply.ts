import { createClient } from '$lib/jmap/auth';
import { sendEmail } from '$lib/jmap/email';
import { getMailboxes } from '$lib/jmap/mailbox';
import type { AuthState } from '$lib/jmap/types';
import { resolveIdentity } from '$lib/server/identity-resolve';
import { buildReply } from './imip';

/**
 * Tell the organizer about an RSVP: an iTIP REPLY (RFC 6047) mailed from
 * the account through its own JMAP submission, like any message the user
 * sends. The calendar goes as a `text/calendar; method=REPLY` part, which
 * Google Calendar, Outlook/Exchange and Apple read the reply from.
 *
 * Best-effort by design: the RSVP is already saved on the calendar when
 * this runs, and a failure here only means the organizer wasn't told —
 * which the card says, instead of pretending.
 */
export type ReplyOutcome = 'sent' | 'failed' | 'none';

const CALENDAR_PART_TYPE = 'text/calendar; method=REPLY; charset=utf-8';

const VERB: Record<string, string> = {
	ACCEPTED: 'accepted',
	TENTATIVE: 'tentatively accepted',
	DECLINED: 'declined'
};

function escapeHtml(s: string): string {
	return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export async function sendItipReply(
	auth: AuthState,
	userEmail: string,
	invitationIcs: string,
	partStat: string
): Promise<ReplyOutcome> {
	const reply = buildReply(invitationIcs, userEmail, partStat);
	if (!reply) return 'none';

	const identity = resolveIdentity(userEmail, null, userEmail);
	if (!identity?.id) return 'failed';
	const client = createClient(auth);
	const boxes = await getMailboxes(client, auth.accountId);
	const drafts = boxes.find((m) => m.role === 'drafts');
	const sent = boxes.find((m) => m.role === 'sent');
	if (!drafts || !sent) return 'failed';

	// Same upload endpoint the composer's attachments use.
	const upload = await fetch(`${auth.apiUrl}upload/${auth.accountId}/`, {
		method: 'POST',
		headers: { Authorization: auth.authHeader, 'Content-Type': CALENDAR_PART_TYPE },
		body: reply.ics
	});
	if (!upload.ok) return 'failed';
	const blob = (await upload.json()) as { blobId?: string; size?: number };
	if (!blob.blobId) return 'failed';

	const who = escapeHtml(identity.name || identity.email);
	const result = await sendEmail(
		client,
		auth.accountId,
		{
			from: { name: identity.name, email: identity.email },
			to: [{ name: null, email: reply.organizer }],
			cc: [],
			subject: reply.subject,
			body: `<p>${who} has ${VERB[partStat] ?? partStat.toLowerCase()} this invitation.</p>`,
			attachments: [
				{
					blobId: blob.blobId,
					name: 'invite.ics',
					type: CALENDAR_PART_TYPE,
					size: blob.size ?? Buffer.byteLength(reply.ics, 'utf8')
				}
			]
		},
		{ drafts: drafts.id, sent: sent.id },
		{ id: identity.id, email: identity.email }
	);
	return result.success ? 'sent' : 'failed';
}
