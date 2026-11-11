import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { beforeAll, describe, expect, it } from 'vitest';

process.env.DATABASE_PATH = join(mkdtempSync(join(tmpdir(), 'zajel-auto-reply-api-')), 'test.db');

import { getDb } from '$lib/server/db/index';
import { runMigrations } from '$lib/server/db/migrate';
import { getPrefs } from '$lib/server/db/queries/app-prefs';
import { POST } from './+server';

async function save(body: Record<string, unknown>) {
	const res = await POST({
		request: new Request('http://localhost/api/preferences/auto-reply', { method: 'POST', body: JSON.stringify(body) }),
		locals: { user: { id: 'user-1' } }
	} as unknown as Parameters<typeof POST>[0]);
	return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

beforeAll(() => {
	runMigrations();
	getDb().prepare(`INSERT INTO app_user (id, email, password_hash) VALUES ('user-1', 'me@example.test', 'x')`).run();
});

describe('saving out-of-office', () => {
	it('refuses an end date before the start date, and stores nothing', async () => {
		const res = await save({ enabled: true, body: 'Away', from: '2026-11-21', until: '2026-11-20', tz: 'UTC' });
		expect(res).toEqual({ status: 400, body: { error: 'The end date is before the start date.' } });
		expect(getPrefs('user-1').auto_reply_enabled).toBeUndefined();
	});

	it('stamps the switch-on time, keeps it while only the message changes, and renews it when the dates do', async () => {
		const before = Date.now();
		const res = await save({ enabled: true, body: 'Away', tz: 'Europe/London' });
		expect(res).toEqual({ status: 200, body: { success: true, status: 'On' } });
		const prefs = getPrefs('user-1');
		expect(prefs).toMatchObject({ auto_reply_enabled: 'on', auto_reply_body: 'Away', auto_reply_tz: 'Europe/London' });
		const since = prefs.auto_reply_since;
		expect(Date.parse(since)).toBeGreaterThanOrEqual(before);

		await new Promise((r) => setTimeout(r, 5));
		await save({ enabled: true, body: 'Away, back Monday', tz: 'Europe/London' });
		expect(getPrefs('user-1').auto_reply_since).toBe(since);

		await save({ enabled: true, body: 'Away', until: '2099-01-01', tz: 'Europe/London' });
		expect(getPrefs('user-1').auto_reply_since).not.toBe(since);
	});

	it('clears the switch-on time when switched off', async () => {
		await save({ enabled: false, body: 'Away' });
		expect(getPrefs('user-1')).toMatchObject({ auto_reply_enabled: 'off', auto_reply_since: '' });
	});
});
