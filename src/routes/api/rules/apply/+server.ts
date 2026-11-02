import type { RequestHandler } from './$types';
import { createClient } from '$lib/jmap/auth';
import { getMailboxes } from '$lib/jmap/mailbox';
import {
	applyActionsToOutcome,
	emptyOutcome,
	matcherProperties,
	outcomeToUpdate,
	updatesForEmails,
	type RuleActionCtx
} from '$lib/server/rules-engine';
import {
	effectiveActions,
	hasJevCondition,
	JEV_OFF_LIMITS_ROLES,
	withoutOffLimitsTargets,
	type Rule
} from '$lib/types/rules';
import type { Email } from '$lib/jmap/types';

const PAGE = 200;
const BATCH = 50;

interface SetResult {
	updated?: Record<string, unknown> | null;
	notUpdated?: Record<string, { type?: string; description?: string; properties?: string[] }> | null;
}

/**
 * One email's JMAP update for a single rule whose matches were chosen by
 * hand (the editor's Jev test), so only the actions run here. The wire
 * format comes from the shared engine — full `mailboxIds` objects, never
 * id pointer patches (see outcomeToUpdate for the Stalwart digit-id story).
 */
function buildUpdates(
	email: Email,
	rule: Rule,
	ctx: RuleActionCtx,
	offLimits: ReadonlySet<string>
): Record<string, unknown> {
	const outcome = emptyOutcome();
	// A rule Jev judges never deletes and never moves mail to Trash or Junk,
	// here as in the worker: a judgement can be wrong, and those are the
	// places mail is lost from.
	applyActionsToOutcome(email, effectiveActions(withoutOffLimitsTargets(rule, offLimits)), ctx, outcome);
	return outcomeToUpdate(email, outcome);
}

export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.auth) {
		return new Response('Not authenticated', { status: 401 });
	}

	const { rules, ids } = (await request.json()) as { rules: Rule[]; ids?: unknown };
	const activeRules = (rules ?? []).filter((r) => r.enabled);
	// For a rule with a Jev condition no query finds the matches; the
	// editor's test on recent mail does, and sends the ones you accepted.
	const chosenIds = Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : null;
	const client = createClient(locals.auth);
	const { accountId } = locals.auth;

	// The editor's Cancel aborts the fetch; the loop below stops at the next
	// page instead of finishing the whole mailbox behind its back.
	let cancelled = false;

	const stream = new ReadableStream({
		async start(controller) {
			const encoder = new TextEncoder();
			const send = (data: unknown) => {
				try {
					controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
				} catch {
					// Controller closed mid-flight (client disconnected).
				}
			};

			let scanned = 0;
			let matched = 0;
			let applied = 0;
			let failed = 0;
			let failedReason = '';
			let total = 0;

			// Send a page of updates in JMAP-safe chunks, counting what the
			// server accepted — `notUpdated` rejections used to be dropped on
			// the floor, reporting success while folders stayed empty. Returns
			// the ids that were updated.
			const applyUpdates = async (update: Record<string, Record<string, unknown>>): Promise<Set<string>> => {
				const updatedIds = new Set<string>();
				const entries = Object.entries(update);
				for (let i = 0; i < entries.length; i += BATCH) {
					const chunk = Object.fromEntries(entries.slice(i, i + BATCH));
					const setRes = await client.request([['Email/set', { accountId, update: chunk }, '0']]);
					const result = setRes.methodResponses[0][1] as SetResult;
					for (const id of Object.keys(result.updated ?? {})) updatedIds.add(id);
					const rejected = Object.values(result.notUpdated ?? {});
					failed += rejected.length;
					if (rejected.length > 0 && !failedReason) {
						const first = rejected[0];
						const where = first.properties?.length ? ` (${first.properties.join(', ')})` : '';
						failedReason = `${first.description ?? first.type ?? 'rejected by server'}${where}`;
					}
				}
				applied += updatedIds.size;
				return updatedIds;
			};

			try {
				if (activeRules.length === 0) {
					send({ type: 'done', scanned: 0, matched: 0, applied: 0, failed: 0 });
					return;
				}

				const mailboxes = await getMailboxes(client, accountId);
				const validIds = new Set(mailboxes.map((m) => m.id));
				const inbox = mailboxes.find((m) => m.role === 'inbox');
				const ctx: RuleActionCtx = {
					inboxId: inbox?.id,
					trashId: mailboxes.find((m) => m.role === 'trash')?.id,
					validMailboxIds: validIds
				};
				const offLimits = new Set(
					mailboxes.filter((m) => m.role && JEV_OFF_LIMITS_ROLES.has(m.role)).map((m) => m.id)
				);

				// Preflight: a rule whose label/folder target was deleted would
				// "apply" as a stream of server-side rejections. Name the broken
				// rule instead of pretending it ran.
				for (const rule of activeRules) {
					const stale = rule.actions.find(
						(a) =>
							(a.type === 'moveToFolder' || a.type === 'applyLabel') &&
							a.value &&
							!validIds.has(a.value)
					);
					if (stale) {
						send({
							type: 'error',
							message: `Rule "${rule.name}" targets a ${stale.type === 'moveToFolder' ? 'folder' : 'label'} that no longer exists. Open the rule and pick the target again.`
						});
						return;
					}
					const unset = rule.actions.find(
						(a) => (a.type === 'moveToFolder' || a.type === 'applyLabel') && !a.value
					);
					if (unset) {
						send({
							type: 'error',
							message: `Rule "${rule.name}" has a ${unset.type === 'moveToFolder' ? '"move to folder"' : '"apply label"'} action with no target selected.`
						});
						return;
					}
				}

				if (chosenIds) {
					if (activeRules.length !== 1) {
						send({ type: 'error', message: 'Chosen emails can only be applied with one rule.' });
						return;
					}
					const rule = activeRules[0];
					send({ type: 'start', total: chosenIds.length });
					const response = await client.request([
						['Email/get', { accountId, ids: chosenIds, properties: ['id', 'keywords', 'mailboxIds'] }, 'g']
					]);
					const emails = (response.methodResponses[0][1] as { list?: Email[] }).list ?? [];
					const patches = Object.fromEntries(
						emails
							.map((email) => [email.id, buildUpdates(email, rule, ctx, offLimits)] as const)
							.filter(([, p]) => Object.keys(p).length > 0)
					);
					scanned = matched = emails.length;
					await applyUpdates(patches);
					send({ type: 'done', scanned, matched, applied, failed, failedReason });
					return;
				}

				const jevRule = activeRules.find(hasJevCondition);
				if (jevRule) {
					send({
						type: 'error',
						message: `Rule "${jevRule.name}" has a Jev condition, so no search can find its matches. Test it on recent mail, then apply it to the emails that match.`
					});
					return;
				}
				if (!inbox) {
					send({ type: 'error', message: 'This account has no Inbox to apply rules to.' });
					return;
				}

				// The candidates are the Inbox, page by page — the mail rules see
				// as it arrives — and each message is judged by the matcher the
				// scheduler uses, so "apply now" acts on exactly what a rule would
				// act on at delivery. A JMAP filter used to stand in for the
				// matcher, and acted on the wrong mail: the server's text filters
				// are its search (word based, not substring), "is" and "starts
				// with" had no counterpart, NOT plus "doesn't contain" came out as
				// a single negation, and nothing kept it to the Inbox, so Sent and
				// Trash were swept too.
				const { properties, fetchTextBodyValues } = matcherProperties(activeRules);
				total = inbox.totalEmails;
				send({ type: 'start', total });

				let position = 0;
				// Bounded loop for safety; the real end is a page smaller than PAGE.
				for (let safety = 0; safety < 10_000 && !cancelled; safety++) {
					const response = await client.request([
						[
							'Email/query',
							{
								accountId,
								filter: { inMailbox: inbox.id },
								sort: [{ property: 'receivedAt', isAscending: false }],
								position,
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

					const emails = (response.methodResponses[1][1] as { list: Email[] }).list ?? [];
					if (emails.length === 0) break;

					const page = updatesForEmails(emails, activeRules, ctx);
					scanned += emails.length;
					matched += page.matched;
					const updatedIds = await applyUpdates(page.update);

					send({ type: 'progress', scanned, matched, applied, failed, total });

					if (emails.length < PAGE) break;
					// A message a move took out of the Inbox has left the listing,
					// so the next page starts that many earlier or it would skip
					// as many unseen messages.
					let left = 0;
					for (const id of updatedIds) {
						const next = page.update[id]?.mailboxIds as Record<string, boolean> | undefined;
						if (next && !next[inbox.id]) left++;
					}
					position += emails.length - left;
				}

				send({ type: 'done', scanned, matched, applied, failed, failedReason });
			} catch (err) {
				send({
					type: 'error',
					message: err instanceof Error ? err.message : 'Apply failed'
				});
			} finally {
				try {
					controller.close();
				} catch {
					// already closed
				}
			}
		},
		cancel() {
			cancelled = true;
		}
	});

	return new Response(stream, {
		headers: {
			'Content-Type': 'text/event-stream',
			'Cache-Control': 'no-cache, no-transform',
			'Connection': 'keep-alive',
			'X-Accel-Buffering': 'no'
		}
	});
};
