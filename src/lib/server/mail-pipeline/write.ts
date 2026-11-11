import { JMAPAuthError, type JMAPClient } from '$lib/jmap/client';
import type { Email } from '$lib/jmap/types';
import { EMAIL_SET_BATCH } from '$lib/jmap/email';
import { errorFields } from '$lib/server/log';
import { noteFailure, noteRecovered } from '$lib/server/jev/health';

/**
 * Writing what a pass decided about new mail: batched Email/set, the
 * server's refusals kept with its reason, and one log line per pass.
 */

export type Placement = Pick<Email, 'mailboxIds' | 'keywords'>;

/** Where each message is, and which tab it has, right now; one the server no longer has is absent. */
export async function currentPlacement(client: JMAPClient, accountId: string, ids: string[]): Promise<Map<string, Placement>> {
	if (ids.length === 0) return new Map();
	const response = await client.request([
		['Email/get', { accountId, ids, properties: ['id', 'mailboxIds', 'keywords'] }, 'p']
	]);
	const list = (response.methodResponses[0][1] as { list?: (Placement & { id: string })[] }).list ?? [];
	return new Map(list.map((e) => [e.id, { mailboxIds: e.mailboxIds ?? {}, keywords: e.keywords ?? {} }]));
}

/**
 * A SetError as one short line: its type, what the server said, and which
 * properties. It is the server's text, of whatever shape, so nothing about
 * it is trusted, and it is cut to the length errorFields keeps.
 */
function refusalText(err: unknown): string {
	const e = (err && typeof err === 'object' ? err : {}) as Record<string, unknown>;
	const what = [e.type, e.description].filter((v) => v != null && v !== '').map(String).join(': ') || 'no reason given';
	const props = Array.isArray(e.properties) ? ` (${e.properties.map(String).join(', ')})` : '';
	return `${what}${props}`.slice(0, 300);
}

/** What a pass's writes came to, for its one log line. */
export interface WriteOutcome {
	attempted: number;
	refused: number;
	/** The first refusal's reason. */
	refusal: string | null;
	/** The first write that got no answer from the server. */
	unreachable: unknown;
}

export const noWrites = (): WriteOutcome => ({ attempted: 0, refused: 0, refusal: null, unreachable: null });

/**
 * Write updates in batches; returns what to record for each message not
 * updated. A refused tab or label never reaches the message, and "refused"
 * alone can't tell a patch the server can't read from a message that's
 * gone, so the server's reason is kept. A write that got no answer is not a
 * refusal (after a timeout it may even have landed), and is recorded as such.
 */
export async function writeUpdates(
	client: JMAPClient,
	accountId: string,
	updates: [string, Record<string, unknown>][],
	outcome: WriteOutcome
): Promise<Map<string, string>> {
	const failed = new Map<string, string>();
	outcome.attempted += updates.length;
	for (let i = 0; i < updates.length; i += EMAIL_SET_BATCH) {
		const chunk = updates.slice(i, i + EMAIL_SET_BATCH);
		let notUpdated: unknown;
		try {
			const res = await client.request([
				['Email/set', { accountId, update: Object.fromEntries(chunk) }, '0']
			]);
			notUpdated = (res.methodResponses[0][1] as { notUpdated?: unknown }).notUpdated;
		} catch (err) {
			if (err instanceof JMAPAuthError) throw err;
			outcome.unreachable ??= err;
			const reason = `Couldn’t reach the mail server: ${errorFields(err).error}`;
			for (const [id] of chunk) failed.set(id, reason);
			continue;
		}
		if (!notUpdated || typeof notUpdated !== 'object') continue;
		for (const [id, err] of Object.entries(notUpdated)) {
			const reason = refusalText(err);
			outcome.refused++;
			outcome.refusal ??= reason;
			failed.set(id, `The mail server refused the change: ${reason}`);
		}
	}
	return failed;
}

/**
 * Log a pass's writes once, after all its batches: a pass that keeps
 * refusing new mail while sorting existing mail fine is still failing, not
 * recovering, and logging per batch said both every minute.
 */
export function noteWrites(accountRowId: string, w: WriteOutcome): void {
	if (w.unreachable) noteFailure('write', accountRowId, 'write_failed', errorFields(w.unreachable));
	else if (w.refusal) noteFailure('write', accountRowId, 'write_refused', { count: w.refused, error: w.refusal });
	else if (w.attempted) noteRecovered('write', accountRowId, 'write_recovered');
}
