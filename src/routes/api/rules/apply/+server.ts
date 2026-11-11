import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { createClient } from '$lib/jmap/auth';
import { getMailboxes } from '$lib/jmap/mailbox';
import { roleMailboxId, ruleContext } from '$lib/server/rules/engine';
import { scanInbox } from '$lib/server/rules/scan';
import { listRules } from '$lib/server/rules/store';
import { isRunnable } from '$lib/types/rules';

/**
 * Run saved rules over the mail already in the Inbox ("Save & apply now"),
 * streaming progress. The rules are read from the store, never taken from
 * the request: the page saves first, then applies, so what acts is what
 * was saved and passed `parseRule`. `ruleIds` picks some of them;
 * without it every enabled rule runs.
 */
export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.auth || !locals.activeAccountId) {
		return new Response('Not authenticated', { status: 401 });
	}

	const body = (await request.json().catch(() => ({}))) as { ruleIds?: unknown };
	const saved = listRules(locals.activeAccountId);
	let chosen = saved;
	if (body.ruleIds !== undefined) {
		if (!Array.isArray(body.ruleIds) || !body.ruleIds.every((id) => typeof id === 'string')) {
			return json({ error: 'ruleIds must be a list of rule ids' }, { status: 400 });
		}
		const ids = body.ruleIds as string[];
		const unknown = ids.filter((id) => !saved.some((r) => r?.id === id));
		if (unknown.length > 0) return json({ error: `No saved rule with id ${unknown[0]}` }, { status: 400 });
		chosen = saved.filter((r) => ids.includes(r.id));
	}
	// A rule waiting for its owner to rewrite it never acts, switched on or not.
	const activeRules = chosen.filter(isRunnable);
	const client = createClient(locals.auth);
	const { accountId } = locals.auth;

	// The editor's Cancel aborts the fetch; the scan stops at the next page
	// instead of finishing the whole mailbox behind its back.
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

			try {
				if (activeRules.length === 0) {
					send({ type: 'done', scanned: 0, matched: 0, applied: 0, failed: 0 });
					return;
				}

				const mailboxes = await getMailboxes(client, accountId);
				const ctx = ruleContext(mailboxes);
				const inbox = mailboxes.find((m) => m.role === 'inbox');

				// Preflight: a rule whose folder or label was deleted would "apply"
				// as a stream of server-side rejections, or quietly not at all.
				// Name the broken rule instead of pretending it ran.
				for (const rule of activeRules) {
					const t = rule.target;
					const gone =
						t.kind === 'folder' || t.kind === 'label'
							? !ctx.validMailboxIds?.has(t.mailboxId)
							: t.kind !== 'none' && !roleMailboxId(ctx, t.kind);
					if (gone) {
						const where =
							t.kind === 'folder' || t.kind === 'label'
								? `a ${t.kind} that no longer exists`
								: `${t.kind === 'junk' ? 'Junk' : t.kind === 'trash' ? 'Trash' : 'Archive'}, which this account doesn’t have`;
						send({ type: 'error', message: `Rule "${rule.name}" files into ${where}. Open the rule and pick where it files mail again.` });
						return;
					}
				}

				if (!inbox) {
					send({ type: 'error', message: 'This account has no Inbox to apply rules to.' });
					return;
				}

				send({ type: 'start', total: inbox.totalEmails });
				const result = await scanInbox(client, accountId, activeRules, {
					apply: true,
					mailboxes,
					cancelled: () => cancelled,
					onProgress: ({ scanned, matched, applied, failed, total }) =>
						send({ type: 'progress', scanned, matched, applied, failed, total })
				});
				const { scanned, matched, applied, failed, failedReason } = result;
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
