import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { beforeAll, describe, expect, it, vi } from 'vitest';

process.env.DATABASE_PATH = join(mkdtempSync(join(tmpdir(), 'zajel-unlink-')), 'test.db');
vi.mock('$lib/server/log', () => ({ logEvent: vi.fn(), errorFields: (e: unknown) => ({ error: String(e) }) }));
vi.mock('$lib/server/telegram/notifier', () => ({ notifySignInLost: vi.fn(async () => {}) }));

import { getDb } from '$lib/server/db/index';
import { runMigrations } from '$lib/server/db/migrate';
import { DELETE, GET } from './+server';

const count = (sql: string, id: string) => (getDb().prepare(sql).get(id) as { n: number }).n;
const sends = (id: string) => count('SELECT COUNT(*) AS n FROM scheduled_sends WHERE mail_account_id = ?', id);
const jobs = (id: string) => count('SELECT COUNT(*) AS n FROM agent_jobs WHERE account_id = ?', id);
const labels = (email: string) => count('SELECT COUNT(*) AS n FROM label_meta WHERE user_email = ?', email);

// Async so a handler's synchronous error() throw becomes a rejection.
async function call(handler: typeof GET, id: string, userId = 'u1') {
	return handler({
		params: { id },
		locals: { user: { id: userId, email: `${userId}@example.test` }, sessionId: 's1', sessionVerifiedAt: Date.now() },
		cookies: { get: () => undefined, delete: vi.fn() }
	} as unknown as Parameters<typeof GET>[0]);
}

beforeAll(() => {
	runMigrations();
	const db = getDb();
	db.exec(`
		INSERT INTO app_user (id, email, password_hash) VALUES ('u1', 'u1@example.test', 'x'), ('u2', 'u2@example.test', 'x');
		INSERT INTO mail_accounts (id, user_id, email, server_url, jmap_account_id, secret_enc) VALUES
			('a1', 'u1', 'me@example.test', 'https://mail.example', 'j1', 'x'),
			('a2', 'u1', 'other@example.test', 'https://mail.example', 'j2', 'x');
		INSERT INTO scheduled_sends (id, mail_account_id, jmap_email_id, identity_id, envelope, send_at) VALUES
			('s1', 'a1', 'e1', 'i1', '{}', '2030-01-01T09:00:00Z'),
			('s2', 'a1', 'e2', 'i1', '{}', '2030-01-02T09:00:00Z'),
			('s3', 'a2', 'e3', 'i2', '{}', '2030-01-03T09:00:00Z');
		INSERT INTO agent_jobs (id, user_id, account_id, title, spec_json, schedule_json, time_zone, enabled) VALUES
			('j1', 'u1', 'a1', 'Digest', '{}', '{}', 'UTC', 1),
			('j2', 'u1', 'a1', 'Old tidy-up', '{}', '{}', 'UTC', 0);
		INSERT INTO search_index (account_id, enabled, updated_at) VALUES ('a1', 1, 0);
		INSERT INTO label_meta (user_email, mailbox_id, display_name, color) VALUES ('me@example.test', 'm1', 'Clients', '#ff0000');
	`);
});

describe('unlinking an account', () => {
	it('says beforehand what goes with the link', async () => {
		const body = await (await call(GET, 'a1')).json();
		expect(body.account).toMatchObject({ id: 'a1', email: 'me@example.test' });
		expect(body.unlink).toEqual({ pendingSends: 2, enabledJobs: 1, searchIndexed: true });

		const quiet = await (await call(GET, 'a2')).json();
		expect(quiet.unlink).toEqual({ pendingSends: 1, enabledJobs: 0, searchIndexed: false });
	});

	it("keeps another login's accounts to itself", async () => {
		// SvelteKit's error() throws an HttpError; its class is not shared with the test's copy of kit.
		await expect(call(GET, 'a1', 'u2')).rejects.toMatchObject({ status: 404 });
	});

	it('takes those rows with it, and leaves what is keyed by the address', async () => {
		expect((await call(DELETE, 'a1')).status).toBe(200);
		expect(sends('a1')).toBe(0);
		expect(jobs('a1')).toBe(0);
		expect(count('SELECT COUNT(*) AS n FROM search_index WHERE account_id = ?', 'a1')).toBe(0);
		// The other account's rows, and the address-keyed label colour, are untouched.
		expect(sends('a2')).toBe(1);
		expect(labels('me@example.test')).toBe(1);
	});
});
