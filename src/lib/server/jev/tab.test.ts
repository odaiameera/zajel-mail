import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Point the lazy SQLite singleton at a throwaway file before anything opens it.
process.env.DATABASE_PATH = join(mkdtempSync(join(tmpdir(), 'zajel-tab-')), 'test.db');
vi.mock('$env/dynamic/private', () => ({ env: {} }));

import type { JMAPClient } from '$lib/jmap/client';
import type { MethodCall } from '$lib/jmap/types';
import { getDb } from '$lib/server/db/index';
import { runMigrations } from '$lib/server/db/migrate';
import { correctedEmailIds, getDecision } from '$lib/server/db/queries/jev-decisions';
import { senderHistory, setPin } from '$lib/server/db/queries/jev-learning';
import { updateJevSettings } from '$lib/server/db/queries/jev-settings';
import { AGENT_TOOLS, type ToolContext } from '$lib/server/agent/tools';
import { decideTab, setTab } from './tab';

const ACCT = 'acct-1';

/** A mailbox of two messages from one sender and one from another; records the keyword writes. */
function mailbox() {
	const from: Record<string, string> = { a: 'Jobs@LinkedIn.com', b: 'jobs@linkedin.com', c: 'sam@example.com' };
	const writes: Record<string, unknown>[] = [];
	const client = {
		async request(calls: MethodCall[]) {
			const [name, args] = calls[0];
			if (name === 'Email/set') {
				writes.push(args.update as Record<string, unknown>);
				return { methodResponses: [['Email/set', { updated: {} }, '0']], sessionState: '' };
			}
			const list = (args.ids as string[]).filter((id) => from[id]).map((id) => ({ id, from: [{ email: from[id] }] }));
			return { methodResponses: [['Email/get', { list }, 'g']], sessionState: '' };
		}
	} as unknown as JMAPClient;
	return { client, writes };
}

beforeAll(() => {
	runMigrations();
	getDb()
		.prepare(`INSERT INTO app_user (id, email, password_hash) VALUES ('user-1', 'u@example.test', 'x')`)
		.run();
	getDb()
		.prepare(
			`INSERT INTO mail_accounts (id, user_id, email, server_url, jmap_account_id, secret_enc)
			 VALUES (?, 'user-1', 'me@example.test', 'https://mail.example', 'jmap-acc', 'x')`
		)
		.run(ACCT);
});

beforeEach(() => {
	for (const table of ['jev_decisions', 'jev_sender_moves', 'jev_sender_pins']) getDb().prepare(`DELETE FROM ${table}`).run();
	updateJevSettings(ACCT, { inboxTabs: true, jevEnabled: false });
});

describe('setTab', () => {
	it('moves the messages and remembers the move as yours, for each sender', async () => {
		const { client, writes } = mailbox();

		const suggestion = await setTab(client, 'jmap-acc', ACCT, ['a', 'b'], 'updates');

		expect(Object.keys(writes[0])).toEqual(['a', 'b']);
		// Your choice of tab: Jev never sorts these again.
		expect(correctedEmailIds(ACCT, ['a', 'b', 'c'])).toEqual(new Set(['a', 'b']));
		expect(getDecision(ACCT, 'a')).toMatchObject({ status: 'done', correctedTo: 'updates' });
		// And what Jev is told with this sender's next email.
		expect(senderHistory(ACCT, 'jobs@linkedin.com')).toBe('You have moved 2 earlier emails from this sender to Updates.');
		// All from one sender, and tabs are on: a pin is worth offering, Jev on or off.
		expect(suggestion).toEqual({ sender: 'jobs@linkedin.com', category: 'updates' });
	});

	it('offers no pin for several senders, a sender pinned there already, or an Inbox without tabs', async () => {
		const { client } = mailbox();
		expect(await setTab(client, 'jmap-acc', ACCT, ['a', 'c'], 'updates')).toBeNull();

		setPin(ACCT, 'jobs@linkedin.com', 'updates');
		expect(await setTab(client, 'jmap-acc', ACCT, ['a'], 'updates')).toBeNull();
		// Pinned elsewhere: moving it here is a reason to offer the change.
		expect(await setTab(client, 'jmap-acc', ACCT, ['a'], 'promotions')).toEqual({ sender: 'jobs@linkedin.com', category: 'promotions' });

		updateJevSettings(ACCT, { inboxTabs: false });
		expect(await setTab(client, 'jmap-acc', ACCT, ['c'], 'updates')).toBeNull();
	});

	it('takes an undone move back out of the sender’s history', async () => {
		const { client } = mailbox();
		await setTab(client, 'jmap-acc', ACCT, ['c'], 'updates');
		expect(senderHistory(ACCT, 'sam@example.com')).toBe('You have moved 1 earlier email from this sender to Updates.');

		expect(await setTab(client, 'jmap-acc', ACCT, ['c'], 'important', { undoOf: 'updates' })).toBeNull();
		expect(senderHistory(ACCT, 'sam@example.com')).toBeNull();
		expect(getDecision(ACCT, 'c')).toMatchObject({ correctedTo: 'important' });
	});

	it('only moves the messages when there is no linked account to remember it for', async () => {
		const { client, writes } = mailbox();
		expect(await setTab(client, 'jmap-acc', null, ['a'], 'updates')).toBeNull();
		expect(writes).toHaveLength(1);
		expect(getDecision(ACCT, 'a')).toBeNull();
	});
});

describe('the assistant’s set_tab tool', () => {
	const tool = AGENT_TOOLS.find((t) => t.name === 'set_tab')!;
	const ctx = (client: JMAPClient) =>
		({ client, auth: { accountId: 'jmap-acc' }, accountRowId: ACCT }) as unknown as ToolContext;

	it('teaches Jev exactly what moving the mail by hand does', async () => {
		const { client, writes } = mailbox();

		const result = await tool.run(ctx(client), { email_ids: ['a', 'b', 'c'], tab: 'newsletters' });

		expect(result.isError).toBeUndefined();
		expect(result.done).toBe('Moved 3 messages to newsletters');
		expect(Object.keys(writes[0])).toEqual(['a', 'b', 'c']);
		// The same record the bulk endpoint leaves: your choice, per message...
		expect(correctedEmailIds(ACCT, ['a', 'b', 'c'])).toEqual(new Set(['a', 'b', 'c']));
		expect(getDecision(ACCT, 'c')).toMatchObject({ status: 'done', correctedTo: 'newsletters' });
		// ...and the move, per sender.
		expect(senderHistory(ACCT, 'jobs@linkedin.com')).toBe('You have moved 2 earlier emails from this sender to Newsletters.');
		expect(senderHistory(ACCT, 'sam@example.com')).toBe('You have moved 1 earlier email from this sender to Newsletters.');
	});

	it('records nothing for a tab that isn’t one', async () => {
		const { client, writes } = mailbox();
		const result = await tool.run(ctx(client), { email_ids: ['a'], tab: 'spam' });
		expect(result.isError).toBe(true);
		expect(writes).toEqual([]);
		expect(getDecision(ACCT, 'a')).toBeNull();
	});
});

describe('decideTab', () => {
	const pin = { sender: '@linkedin.com', category: 'updates' as const, createdAt: 0 };
	const base = { tabsOn: true, userChose: false, currentTab: 'important' as const, pin: null, jevPick: null };

	it('leaves every tab alone while the Inbox has no tabs', () => {
		expect(decideTab({ ...base, tabsOn: false, pin, jevPick: 'promotions' })).toEqual({ tab: null, pin: null, open: false });
	});

	it('never overrules a tab you chose yourself, Important included', () => {
		expect(decideTab({ ...base, userChose: true, pin, jevPick: 'promotions' })).toEqual({ tab: null, pin: null, open: false });
		expect(decideTab({ ...base, userChose: true, currentTab: 'updates', pin })).toEqual({ tab: null, pin: null, open: false });
	});

	it('puts a pinned sender’s mail in its tab ahead of Jev’s pick, and asks Jev nothing about it', () => {
		expect(decideTab({ ...base, pin, jevPick: 'promotions' })).toEqual({ tab: 'updates', pin, open: false });
		expect(decideTab({ ...base, pin })).toEqual({ tab: 'updates', pin, open: false });
	});

	it('still credits the pin for mail already in its tab', () => {
		expect(decideTab({ ...base, currentTab: 'updates', pin })).toEqual({ tab: 'updates', pin, open: false });
	});

	it('lets neither a pin nor Jev move mail out of another tab it already has', () => {
		expect(decideTab({ ...base, currentTab: 'newsletters', pin, jevPick: 'promotions' })).toEqual({ tab: null, pin: null, open: false });
		expect(decideTab({ ...base, currentTab: 'newsletters', jevPick: 'promotions' })).toEqual({ tab: null, pin: null, open: false });
	});

	it('uses Jev’s confident pick for mail still in Important, and otherwise leaves it there', () => {
		expect(decideTab({ ...base, jevPick: 'promotions' })).toEqual({ tab: 'promotions', pin: null, open: true });
		expect(decideTab({ ...base, jevPick: 'important' })).toEqual({ tab: 'important', pin: null, open: true });
		expect(decideTab(base)).toEqual({ tab: null, pin: null, open: true });
	});
});
