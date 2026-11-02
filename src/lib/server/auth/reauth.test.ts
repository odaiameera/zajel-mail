import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { beforeAll, describe, expect, it, vi } from 'vitest';

process.env.DATABASE_PATH = join(mkdtempSync(join(tmpdir(), 'ameera-reauth-')), 'test.db');

const mocks = vi.hoisted(() => ({ logEvent: vi.fn(), notifySignInLost: vi.fn(async () => {}) }));
vi.mock('$lib/server/log', () => ({ logEvent: mocks.logEvent, errorFields: (e: unknown) => ({ error: String(e) }) }));
vi.mock('$lib/server/telegram/notifier', () => ({ notifySignInLost: mocks.notifySignInLost }));

import { getDb } from '../db/index';
import { runMigrations } from '../db/migrate';
import { markNeedsReauth } from './accounts';

beforeAll(() => {
	runMigrations();
	getDb().prepare(`INSERT INTO app_user (id, email, password_hash) VALUES ('u1', 'u1@example.test', 'x')`).run();
	getDb()
		.prepare(
			`INSERT INTO mail_accounts (id, user_id, email, server_url, jmap_account_id, secret_enc)
			 VALUES ('a1', 'u1', 'me@example.test', 'https://mail.example', 'jmap', 'x')`
		)
		.run();
});

describe('markNeedsReauth', () => {
	it('logs and tells Telegram once, however many passes hit the 401', async () => {
		markNeedsReauth('a1');
		markNeedsReauth('a1');
		markNeedsReauth('a1');
		await vi.waitFor(() => expect(mocks.notifySignInLost).toHaveBeenCalledTimes(1));
		expect(mocks.notifySignInLost).toHaveBeenCalledWith('a1');
		expect(mocks.logEvent.mock.calls.filter((c) => c[2] === 'needs_reauth')).toHaveLength(1);
		const row = getDb().prepare(`SELECT needs_reauth FROM mail_accounts WHERE id = 'a1'`).get() as { needs_reauth: number };
		expect(row.needs_reauth).toBe(1);
	});
});
