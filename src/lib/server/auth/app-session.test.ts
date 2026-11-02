import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { beforeAll, describe, expect, it } from 'vitest';

process.env.DATABASE_PATH = join(mkdtempSync(join(tmpdir(), 'zajel-session-')), 'test.db');

import { getDb } from '../db/index';
import { runMigrations } from '../db/migrate';
import { createAppSession, getAppSession, SESSION_TTL_MS } from './app-session';

const row = (id: string) =>
	getDb().prepare('SELECT expires_at, last_seen_at FROM app_sessions WHERE id = ?').get(id) as
		| { expires_at: string; last_seen_at: string }
		| undefined;
const pushRows = () => (getDb().prepare('SELECT endpoint FROM push_subscriptions').all() as { endpoint: string }[]).map((r) => r.endpoint);

beforeAll(() => {
	runMigrations();
	getDb().prepare(`INSERT INTO app_user (id, email, password_hash) VALUES ('u1', 'u1@example.test', 'x')`).run();
});

describe('sliding sessions', () => {
	it('says when a read extended the session, so the hook can re-issue the cookie', () => {
		const id = createAppSession('u1');
		expect(getAppSession(id)?.extended).toBe(false);

		// Two minutes without a request, and the row's expiry has drifted back.
		getDb()
			.prepare(`UPDATE app_sessions SET last_seen_at = datetime('now', '-2 minutes'), expires_at = datetime('now', '+1 day') WHERE id = ?`)
			.run(id);
		const before = new Date(row(id)!.expires_at + 'Z').getTime();
		expect(getAppSession(id)?.extended).toBe(true);
		const after = new Date(row(id)!.expires_at + 'Z').getTime();
		expect(after - before).toBeGreaterThan(SESSION_TTL_MS - 2 * 24 * 60 * 60 * 1000);
	});

	it('clears out expired sessions, and their push subscriptions, when someone signs in', () => {
		getDb()
			.prepare(
				`INSERT INTO app_sessions (id, user_id, expires_at) VALUES
				 ('stale', 'u1', datetime('now', '-1 day')), ('live', 'u1', datetime('now', '+1 day'))`
			)
			.run();
		getDb()
			.prepare(
				`INSERT INTO push_subscriptions (endpoint, user_id, session_id, p256dh, auth) VALUES
				 ('https://push.example/stale', 'u1', 'stale', 'k', 'a'), ('https://push.example/live', 'u1', 'live', 'k', 'a')`
			)
			.run();

		createAppSession('u1');

		expect(row('stale')).toBeUndefined();
		expect(row('live')).toBeDefined();
		expect(pushRows()).toEqual(['https://push.example/live']);
	});
});
