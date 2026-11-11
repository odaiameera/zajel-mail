import cron from 'node-cron';
import { listSchedulableAuths, markNeedsReauth } from './auth/accounts';
import { JMAPAuthError } from '$lib/jmap/client';
import { createClient } from '$lib/jmap/auth';
import { getMailboxes } from '$lib/jmap/mailbox';
import type { AuthState, Email } from '$lib/jmap/types';
import { isRunnable } from '$lib/types/rules';
import { getRules, getRulesCursor, setRulesCursor } from './db/queries/rules';
import { matcherProperties, updatesForEmails, type RuleActionCtx } from './rules/engine';
import { runAccountTasks } from './account-tasks';
import { AUTO_REPLY_PROPERTIES, answerNewMail, outOfOfficeFor, pruneOldAutoReplies } from './auto-reply';

/**
 * Server-side rule application. Rules are not handed to the mail server;
 * the app applies them itself a beat after the mail lands: every minute (and opportunistically per request for
 * active users) we run each user's enabled rules over the inbox mail that
 * arrived since the last run. Actions are idempotent, so overlap is safe.
 *
 * This is the only thing that runs rules on new mail. Jev's worker asks for
 * a run before it sorts (see applyRulesNow), and evaluates none itself.
 *
 * The same run sends out-of-office replies (auto-reply.ts): it sees each
 * new Inbox message once, with Jev on or off.
 */

const PAGE = 100;
const BATCH = 50;

let started = false;

// Guards against the cron tick and the per-request catch-up running for the
// same user at once — harmless (actions are idempotent) but wasteful.
const inFlight = new Map<string, Promise<void>>();

// The mail each user's last run acted on. The cursor re-reads the second a
// run started in (see runApply), and what was handled then isn't redone.
const lastHandled = new Map<string, Set<string>>();

export function startRulesScheduler(): void {
	if (started) return;
	started = true;

	cron.schedule('* * * * *', async () => {
		for (const { account, auth, email } of listSchedulableAuths()) {
			try {
				await applyRulesForUser(auth, email);
			} catch (err) {
				if (err instanceof JMAPAuthError) {
					markNeedsReauth(account.id);
					continue;
				}
				console.error('[rules] auto-apply failed', email, err);
			}
		}
	});

	// The daily pass: the out-of-office log is kept a month.
	cron.schedule('41 3 * * *', () => {
		try {
			pruneOldAutoReplies();
		} catch (err) {
			console.error('[rules] auto-reply log prune failed', err);
		}
	});
}

/**
 * Process inbox mail that arrived since this user's cursor. On the very first
 * run we just seed the cursor to "now" so we never retro-apply the entire
 * backlog (that's what the manual "apply to existing" action is for).
 */
export async function applyRulesForUser(auth: AuthState, userEmail: string): Promise<void> {
	if (inFlight.has(userEmail)) return;
	const run = runApply(auth, userEmail).finally(() => inFlight.delete(userEmail));
	inFlight.set(userEmail, run);
	await run;
}

/**
 * A run that covers the newest mail, for Jev's worker, which marks mail
 * done once the rules have had it: one already going may have read the
 * Inbox before that mail landed, so it is waited out and another run made.
 */
export async function applyRulesNow(auth: AuthState, userEmail: string): Promise<void> {
	for (let running = inFlight.get(userEmail); running; running = inFlight.get(userEmail)) {
		await running.catch(() => {});
	}
	await applyRulesForUser(auth, userEmail);
}

async function runApply(auth: AuthState, userEmail: string): Promise<void> {
	// The account's one-time jobs ride on this run, which has its
	// credentials. They never hold the rules up.
	try {
		await runAccountTasks(auth, userEmail);
	} catch (err) {
		console.error('[rules] account tasks failed', userEmail, err);
	}

	// Rules that may run: switched on, and not waiting to be rewritten.
	const enabled = getRules(userEmail).filter(isRunnable);
	// Stalwart stamps receivedAt to the second and `after` is strict, so a
	// cursor at this run's own instant would skip mail landing later in that
	// second, after the query below. The next run reads from the second
	// before instead; what this run handled is remembered and not redone.
	const nowIso = new Date(Math.floor(Date.now() / 1000) * 1000 - 1000).toISOString();

	// Out-of-office for this account's login, when it is on right now.
	const outOfOffice = outOfOfficeFor(userEmail);

	const cursor = getRulesCursor(userEmail);
	if (cursor === null || (enabled.length === 0 && !outOfOffice)) {
		// First sight of this user, or nothing to do — advance and bail, so
		// nothing is retro-applied (or answered) should that change.
		setRulesCursor(userEmail, nowIso);
		return;
	}

	const client = createClient(auth);
	const { accountId } = auth;
	const mailboxes = await getMailboxes(client, accountId);
	const inbox = mailboxes.find((m) => m.role === 'inbox');
	if (!inbox) {
		setRulesCursor(userEmail, nowIso);
		return;
	}
	const ctx: RuleActionCtx = {
		inboxId: inbox.id,
		trashId: mailboxes.find((m) => m.role === 'trash')?.id,
		validMailboxIds: new Set(mailboxes.map((m) => m.id))
	};

	const matcher = matcherProperties(enabled);
	const { fetchTextBodyValues } = matcher;
	const properties = outOfOffice ? [...new Set([...matcher.properties, ...AUTO_REPLY_PROPERTIES])] : matcher.properties;

	const response = await client.request([
		[
			'Email/query',
			{
				accountId,
				filter: { operator: 'AND', conditions: [{ inMailbox: inbox.id }, { after: cursor }] },
				sort: [{ property: 'receivedAt', isAscending: true }],
				limit: PAGE
			},
			'q'
		],
		[
			'Email/get',
			{
				accountId,
				'#ids': { resultOf: 'q', name: 'Email/query', path: '/ids' },
				properties,
				...(fetchTextBodyValues && { fetchTextBodyValues })
			},
			'g'
		]
	]);

	const listed = (response.methodResponses[1][1] as { list: Email[] }).list ?? [];
	const handled = lastHandled.get(userEmail);
	const emails = handled ? listed.filter((e) => !handled.has(e.id)) : listed;

	// Out-of-office decides on the mail as it arrived, before the rules
	// below move it. A failure here never stops the rules.
	if (outOfOffice) {
		try {
			await answerNewMail(client, accountId, outOfOffice, emails, mailboxes);
		} catch (err) {
			console.error('[rules] out-of-office failed', userEmail, err);
		}
	}
	const { update } = updatesForEmails(emails, enabled, ctx);

	const entries = Object.entries(update);
	for (let i = 0; i < entries.length; i += BATCH) {
		const chunk = Object.fromEntries(entries.slice(i, i + BATCH));
		const res = await client.request([['Email/set', { accountId, update: chunk }, '0']]);
		const result = res.methodResponses[0][1] as {
			notUpdated?: Record<
				string,
				{ type?: string; description?: string; properties?: string[] }
			> | null;
		};
		const rejected = Object.entries(result.notUpdated ?? {});
		if (rejected.length > 0) {
			// Surface rejections in the server log — they were previously
			// swallowed, making rules look applied while nothing moved.
			const [id, err] = rejected[0];
			const where = err.properties?.length ? ` (${err.properties.join(', ')})` : '';
			console.warn(
				`[rules] ${userEmail}: server rejected ${rejected.length}/${entries.length} update(s); first: ${id} → ${err.description ?? err.type ?? 'unknown'}${where}`
			);
		}
	}

	// A full page may have more behind it, so the cursor resumes from the
	// newest message processed rather than jumping to "now". Stalwart stamps
	// receivedAt to the second and `after` is strict, so resuming at that
	// message would skip the rest of its second: step back a second for ties
	// (a re-read is safe, the updates only write differences) — unless the
	// whole page is that one second, when stepping back would never move on.
	// The same stepping as Jev's worker.
	lastHandled.set(userEmail, new Set(listed.map((e) => e.id)));
	let newCursor = nowIso;
	if (listed.length >= PAGE) {
		const lastSeen = listed[listed.length - 1]!.receivedAt;
		const stepped = Date.parse(lastSeen) - 1000;
		newCursor = stepped > Date.parse(cursor) ? new Date(stepped).toISOString() : lastSeen;
	}
	setRulesCursor(userEmail, newCursor);
}

/**
 * On-demand catch-up used from hooks for active users, so rules apply within
 * a couple seconds while the user is using the app rather than waiting on the
 * next cron tick. Fire-and-forget; errors are swallowed.
 */
export async function applyRulesForUserSafe(auth: AuthState, userEmail: string): Promise<void> {
	try {
		await applyRulesForUser(auth, userEmail);
	} catch (err) {
		console.error('[rules] on-demand apply failed', userEmail, err);
	}
}
