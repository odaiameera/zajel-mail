import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

process.env.DATABASE_PATH = join(mkdtempSync(join(tmpdir(), 'zajel-needs-')), 'test.db');
const env = vi.hoisted(() => ({}) as Record<string, string | undefined>);
vi.mock('$env/dynamic/private', () => ({ env }));

import { getDb } from '$lib/server/db/index';
import { runMigrations } from '$lib/server/db/migrate';
import { patchPrefs } from '$lib/server/db/queries/app-prefs';
import { updateJevSettings } from '$lib/server/db/queries/jev-settings';
import { setPin } from '$lib/server/db/queries/jev-learning';
import { importRules } from '$lib/server/rules/store';
import type { Rule } from '$lib/types/rules';
import { pipelineNeeds } from './needs';

const ACCT = 'acct-1';
const NOW = new Date('2026-11-11T10:00:00Z');

const rule = (over: Partial<Rule> = {}): Rule => ({
	id: 'r',
	name: 'r',
	enabled: true,
	logic: 'allof',
	conditions: [{ id: 'c', field: 'subject', op: 'contains', value: 'x', negate: false }],
	target: { kind: 'label', mailboxId: 'L1' },
	markRead: false,
	star: false,
	stop: false,
	position: 0,
	createdAt: 0,
	updatedAt: 0,
	...over
});

beforeAll(() => {
	runMigrations();
	getDb().prepare(`INSERT INTO app_user (id, email, password_hash) VALUES ('user-1', 'u@example.test', 'x')`).run();
	getDb()
		.prepare(
			`INSERT INTO mail_accounts (id, user_id, email, server_url, jmap_account_id, secret_enc) VALUES (?, 'user-1', 'me@example.test', 'https://mail.example', 'j', 'x')`
		)
		.run(ACCT);
});

beforeEach(() => {
	for (const key of Object.keys(env)) delete env[key];
	env.JEV_MOCK = '1';
	getDb().prepare('DELETE FROM rules').run();
	getDb().prepare('DELETE FROM jev_sender_pins').run();
	getDb().prepare('DELETE FROM jev_settings').run();
	patchPrefs('user-1', { auto_reply_enabled: 'off' });
});

describe('pipelineNeeds', () => {
	it('wants nothing when nothing acts on new mail', () => {
		expect(pipelineNeeds(ACCT, NOW)).toMatchObject({ wantsArrivals: false, hold: false, jevStep: false, rules: [] });
	});

	it('wants new mail for rules alone, holding it only when a rule moves mail', () => {
		importRules(ACCT, [rule()]);
		expect(pipelineNeeds(ACCT, NOW)).toMatchObject({ wantsArrivals: true, hold: false, rulesMoveMail: false, jevStep: false });
		importRules(ACCT, [rule({ id: 'm', target: { kind: 'archive' } })]);
		expect(pipelineNeeds(ACCT, NOW)).toMatchObject({ wantsArrivals: true, hold: true, rulesMoveMail: true });
	});

	it('wants new mail for out-of-office alone', () => {
		patchPrefs('user-1', { auto_reply_enabled: 'on', auto_reply_body: 'Away', auto_reply_since: NOW.toISOString() });
		const needs = pipelineNeeds(ACCT, NOW);
		expect(needs.outOfOffice).toMatchObject({ accountRowId: ACCT });
		expect(needs).toMatchObject({ wantsArrivals: true, hold: false, jevStep: false });
	});

	it('asks Jev only while it is switched on and configured, and checks no spam otherwise', () => {
		updateJevSettings(ACCT, { inboxTabs: true, jevEnabled: true, spamMode: 'active' }, NOW);
		expect(pipelineNeeds(ACCT, NOW)).toMatchObject({ jev: true, jevStep: true, hold: true, spamMode: 'active', jevSince: NOW.toISOString() });
		delete env.JEV_MOCK;
		expect(pipelineNeeds(ACCT, NOW)).toMatchObject({ jev: false, jevStep: false, hold: false, spamMode: 'off', wantsArrivals: false });
	});

	it('lets pins act only while the Inbox has tabs', () => {
		setPin(ACCT, '@linkedin.com', 'updates');
		expect(pipelineNeeds(ACCT, NOW)).toMatchObject({ pins: [], wantsArrivals: false });
		updateJevSettings(ACCT, { inboxTabs: true });
		expect(pipelineNeeds(ACCT, NOW)).toMatchObject({ jevStep: true, hold: true, wantsArrivals: true });
	});
});
