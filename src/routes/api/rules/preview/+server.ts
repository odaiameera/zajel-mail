import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { createClient } from '$lib/jmap/auth';
import { buildJmapFilter } from '$lib/server/rules';
import type { Rule } from '$lib/types/rules';

/**
 * Preview how many existing emails match a single rule. Returns a JMAP
 * Email/query `total` with `limit: 0` so the server can compute the
 * count without returning rows. Debounce the caller (~400ms) since
 * every keystroke in the editor fires this.
 */
export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.auth) return json({ error: 'Not authenticated' }, { status: 401 });

	const { rule } = (await request.json()) as { rule: Rule };
	if (!rule) return json({ error: 'rule required' }, { status: 400 });

	const filter = buildJmapFilter(rule);
	if (!filter) return json({ count: 0 });

	try {
		const client = createClient(locals.auth);
		const response = await client.request([
			[
				'Email/query',
				{
					accountId: locals.auth.accountId,
					filter,
					calculateTotal: true,
					limit: 0
				},
				'0'
			]
		]);

		const result = response.methodResponses[0][1] as { total?: number };
		return json({ count: result.total ?? 0 });
	} catch (err) {
		return json({ error: err instanceof Error ? err.message : 'Preview failed' }, { status: 500 });
	}
};
