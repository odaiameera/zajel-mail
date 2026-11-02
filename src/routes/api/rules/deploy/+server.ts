import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { buildSieveContext, compileRulesToSieve } from '$lib/server/sieve';
import { createClient } from '$lib/jmap/auth';
import { getMailboxes } from '$lib/jmap/mailbox';
import type { MethodCall } from '$lib/jmap/types';
import type { Rule } from '$lib/types/rules';
import { readPreferences } from '$lib/server/preferences';

const JMAP_USING = ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:sieve'];
const SCRIPT_NAME = 'mailrules';

interface SieveScriptEntry {
	id: string;
	name: string;
	isActive?: boolean;
}

interface SetError {
	type?: string;
	description?: string;
}

export const POST: RequestHandler = async ({ request, locals, cookies }) => {
	if (!locals.auth || !locals.user) return json({ error: 'Not authenticated' }, { status: 401 });

	const { rules } = await request.json() as { rules: Rule[] };
	// The session's own JMAP base — never a hardcoded host, so deploys work
	// on any Stalwart deployment.
	const { authHeader, accountId, apiUrl } = locals.auth;

	// Sieve needs to resolve applyLabel/moveToFolder action values (mailbox
	// ids, or legacy names for older rules) to IMAP mailbox names —
	// compileRulesToSieve can't do that without the current mailbox list.
	const client = createClient(locals.auth);
	const mailboxes = await getMailboxes(client, accountId);

	// Auto-reply is stored with the rest of the preferences (the auto-reply
	// page saves it there). Pass the current config through so the compiled
	// script includes the vacation block when enabled.
	const prefs = readPreferences(locals.user.id, cookies);
	const autoReply = {
		enabled: prefs.auto_reply_enabled === 'on',
		subject: prefs.auto_reply_subject ?? '',
		body: prefs.auto_reply_body ?? ''
	};

	const script = compileRulesToSieve(rules, buildSieveContext(mailboxes), autoReply);

	try {
		// Step 1: Upload script as blob
		const uploadRes = await fetch(
			`${apiUrl}upload/${accountId}/`,
			{
				method: 'POST',
				headers: {
					'Content-Type': 'application/sieve',
					'Authorization': authHeader
				},
				body: script
			}
		);

		if (!uploadRes.ok) {
			const text = await uploadRes.text();
			return json({ error: `Upload failed: ${uploadRes.status} — ${text}`, script }, { status: 500 });
		}

		const { blobId } = await uploadRes.json() as { blobId: string };

		// Step 2: Check if mailrules script already exists. The shared client
		// turns a method-level `error` response into a JMAPMethodError with
		// the server's reason, where reading `.list` off it used to throw a
		// TypeError.
		const getRes = await client.request([['SieveScript/get', { accountId, ids: null }, '0']], JMAP_USING);
		const scriptList = (getRes.methodResponses[0][1] as { list?: SieveScriptEntry[] }).list ?? [];
		const existingScript = scriptList.find((s) => s.name === SCRIPT_NAME);
		// Only one script is active at a time, so activating ours switches off
		// whatever was — a filter the user wrote in another client. Say so
		// rather than letting it vanish without a word.
		const deactivated = scriptList.find((s) => s.isActive && s.name !== SCRIPT_NAME)?.name ?? null;

		// Step 3: Create or update
		const methodCalls: MethodCall[] = existingScript
			? [['SieveScript/set', {
				accountId,
				update: { [existingScript.id]: { blobId } },
				onSuccessActivateScript: existingScript.id
			}, '0']]
			: [['SieveScript/set', {
				accountId,
				create: { script1: { name: SCRIPT_NAME, blobId } },
				onSuccessActivateScript: '#script1'
			}, '0']];

		const setRes = await client.request(methodCalls, JMAP_USING);
		const result = setRes.methodResponses[0][1] as {
			notCreated?: Record<string, SetError> | null;
			notUpdated?: Record<string, SetError> | null;
		};

		// An empty `notCreated: {}` is not a refusal; only an entry is.
		const refused = Object.values(result.notCreated ?? {})[0] ?? Object.values(result.notUpdated ?? {})[0];
		if (refused) {
			return json({ error: refused.description ?? refused.type ?? 'Sieve deploy failed', script }, { status: 500 });
		}

		return json({ success: true, script, deactivated });
	} catch (err) {
		return json({
			error: err instanceof Error ? err.message : 'Deploy failed',
			script
		}, { status: 500 });
	}
};
