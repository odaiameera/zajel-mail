import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { createClient } from '$lib/jmap/auth';
import { sendEmail } from '$lib/jmap/email';
import { getMailboxes } from '$lib/jmap/mailbox';
import { userEmailFromAuth } from '$lib/server/user';
import { resolveIdentity } from '$lib/server/identity-resolve';
import { safeFetch } from '$lib/server/avatars/net';
import { parseListUnsubscribe } from '$lib/utils/list-unsubscribe';

interface UnsubscribeBody {
	mode: 'one-click' | 'mailto';
	url?: string;
	mailto?: string;
}

const ONE_CLICK_TIMEOUT_MS = 15_000;
// The reply is never read; this only bounds how much a sender can make us take.
const ONE_CLICK_MAX_BYTES = 64 * 1024;

/**
 * Best-effort unsubscribe endpoint.
 *
 *  - `one-click` (RFC 8058): server-side POSTs
 *    `List-Unsubscribe=One-Click` to the sender's HTTPS URL. This has to
 *    happen server-side because browsers can't make CORS-less POSTs.
 *  - `mailto`: sends an empty (or mailto-specified) message from the
 *    user's identity via the existing sendEmail pipeline. We hand-roll
 *    the compose rather than bouncing through /api/send so we can honor
 *    `?subject=` and `?body=` params on the mailto URI.
 *
 * The target always comes from the stored email's own `List-Unsubscribe`
 * header, read here from the mail server; a URL or address in the request
 * body is only accepted if the header lists it. Otherwise this would be a
 * "make the server POST anywhere" button. The POST itself goes through
 * `safeFetch`, which refuses private, loopback and link-local hosts on every
 * redirect hop, because the header is still written by whoever sent the mail.
 *
 * On success, we flag the source email with the `$unsubscribed` keyword
 * so the UI can show a persistent "Unsubscribed" state across reloads.
 */
export const POST: RequestHandler = async ({ params, locals, request }) => {
	if (!locals.auth) return json({ error: 'Not authenticated' }, { status: 401 });

	let body: UnsubscribeBody;
	try {
		body = (await request.json()) as UnsubscribeBody;
	} catch {
		return json({ error: 'Invalid JSON body' }, { status: 400 });
	}

	const client = createClient(locals.auth);
	const accountId = locals.auth.accountId;

	try {
		const headers = await listHeaders(client, accountId, params.id);
		if (!headers) return json({ error: 'Email not found' }, { status: 404 });

		if (body.mode === 'one-click') {
			const offered = parseListUnsubscribe(headers.list, headers.post);
			if (offered.mode !== 'one-click' || !offered.url) {
				return json({ error: 'This email does not offer one-click unsubscribe' }, { status: 400 });
			}
			if (body.url !== undefined && body.url.trim() !== offered.url) {
				return json({ error: "That URL is not this email's unsubscribe address" }, { status: 400 });
			}

			const res = await safeFetch(offered.url, {
				method: 'POST',
				body: 'List-Unsubscribe=One-Click',
				contentType: 'application/x-www-form-urlencoded',
				timeoutMs: ONE_CLICK_TIMEOUT_MS,
				maxBytes: ONE_CLICK_MAX_BYTES,
				allowEmpty: true
			});
			if (!res) {
				// A blocked host, a timeout, no answer, or an oversized one.
				return json({ error: "Couldn't reach the sender's unsubscribe address" }, { status: 502 });
			}
			if (res.status < 200 || res.status >= 300) {
				return json({ error: `Sender returned ${res.status}` }, { status: 502 });
			}
		} else if (body.mode === 'mailto') {
			if (!body.mailto) return json({ error: 'mailto required' }, { status: 400 });
			const mailto = body.mailto.trim();
			if (!mailtoEntries(headers.list).includes(mailto)) {
				return json({ error: "That address is not this email's unsubscribe address" }, { status: 400 });
			}

			const parsed = parseMailto(mailto);
			if (!parsed) return json({ error: 'Invalid mailto URI' }, { status: 400 });

			const mailboxes = await getMailboxes(client, accountId);
			const sent = mailboxes.find((m) => m.role === 'sent');
			const drafts = mailboxes.find((m) => m.role === 'drafts');
			if (!sent || !drafts) return json({ error: 'Sent or Drafts folder missing' }, { status: 500 });

			const userEmail = userEmailFromAuth(locals.auth);
			// Unsubscribe always sends from the primary identity. Picking
			// the right identity here would require tracking which one the
			// user was reading the message under, and isn't worth the
			// complexity for an out-of-band unsubscribe action.
			const identity = resolveIdentity(userEmail, null, userEmail);
			if (!identity || !identity.id) {
				return json({ error: 'No sending identity available' }, { status: 500 });
			}

			const result = await sendEmail(
				client,
				accountId,
				{
					from: { name: identity.name, email: identity.email },
					to: [{ name: null, email: parsed.to }],
					cc: [],
					subject: parsed.subject ?? 'unsubscribe',
					body: parsed.body ?? ''
				},
				{ drafts: drafts.id, sent: sent.id },
				{ id: identity.id, email: identity.email }
			);

			if (!result.success) {
				return json({ error: result.error ?? 'Send failed' }, { status: 502 });
			}
		} else {
			return json({ error: 'Invalid unsubscribe mode' }, { status: 400 });
		}

		// Flag the email locally so the UI can show "Unsubscribed" persistently.
		await client.request([
			[
				'Email/set',
				{
					accountId,
					update: { [params.id]: { 'keywords/$unsubscribed': true } }
				},
				'0'
			]
		]);

		return json({ success: true });
	} catch (err) {
		const message = err instanceof Error ? err.message : 'Unsubscribe failed';
		return json({ error: message }, { status: 500 });
	}
};

/** The email's List-Unsubscribe headers as the mail server stored them, or null if it's gone. */
async function listHeaders(
	client: ReturnType<typeof createClient>,
	accountId: string,
	emailId: string
): Promise<{ list: string | null; post: string | null } | null> {
	const response = await client.request([
		[
			'Email/get',
			{
				accountId,
				ids: [emailId],
				// List-Unsubscribe in raw form: RFC 8621 allows no Text form for it,
				// and Stalwart 1.0 rejects `:asText`. See getEmailDetail.
				properties: ['id', 'header:list-unsubscribe', 'header:list-unsubscribe-post:asText']
			},
			'0'
		]
	]);
	const result = response.methodResponses[0]?.[1] as
		| { list?: Record<string, string | null | undefined>[] }
		| undefined;
	const email = result?.list?.[0];
	if (!email) return null;
	return {
		list: email['header:list-unsubscribe'] ?? null,
		post: email['header:list-unsubscribe-post:asText'] ?? null
	};
}

function mailtoEntries(header: string | null): string[] {
	if (!header) return [];
	return [...header.matchAll(/<([^>]*)>/g)].map((m) => m[1].trim()).filter((u) => /^mailto:/i.test(u));
}

/**
 * Parse a `mailto:` URI, honoring `?subject=` and `?body=` parameters.
 * Returns null on malformed input.
 */
function parseMailto(mailto: string): { to: string; subject?: string; body?: string } | null {
	const m = mailto.match(/^mailto:([^?]+)(?:\?(.*))?$/i);
	if (!m) return null;
	let to: string;
	try {
		to = decodeURIComponent(m[1]).trim();
	} catch {
		return null;
	}
	if (!to.includes('@')) return null;
	const params = new URLSearchParams(m[2] ?? '');
	return {
		to,
		subject: params.get('subject') ?? undefined,
		body: params.get('body') ?? undefined
	};
}
