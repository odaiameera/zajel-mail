import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

process.env.DATABASE_PATH = join(mkdtempSync(join(tmpdir(), 'zajel-account-tasks-')), 'test.db');

// A mail server's Sieve scripts. `calls` records every method call made.
const state = vi.hoisted(() => ({
	capabilities: {} as Record<string, unknown>,
	scripts: [] as { id: string; name: string; isActive: boolean }[],
	calls: [] as [string, Record<string, unknown>][],
	fail: false,
	refuse: false,
	/** Requests made: each attempt starts with one. */
	attempts: 0
}));

vi.mock('$lib/jmap/auth', () => ({
	fetchSession: async () => ({ capabilities: state.capabilities, accounts: {} }),
	createClient: () => ({
		request: async (calls: [string, Record<string, unknown>, string][]) => {
			if (calls[0][0] === 'SieveScript/get') state.attempts++;
			if (state.fail) throw new Error('server unreachable');
			const responses: [string, unknown, string][] = [];
			for (const [name, args, tag] of calls) {
				state.calls.push([name, args]);
				if (name === 'SieveScript/get') {
					responses.push([name, { list: state.scripts.map((s) => ({ ...s })) }, tag]);
				} else if (name === 'SieveScript/set') {
					const notDestroyed: Record<string, unknown> = {};
					for (const id of (args.destroy as string[] | undefined) ?? []) {
						const s = state.scripts.find((x) => x.id === id);
						// As a server does: an active script can't be destroyed.
						if (!s || s.isActive || state.refuse) notDestroyed[id] = { type: 'sieveIsActive' };
						else state.scripts = state.scripts.filter((x) => x.id !== id);
					}
					if (args.onSuccessDeactivateScript) for (const s of state.scripts) s.isActive = false;
					responses.push([name, { notDestroyed }, tag]);
				} else throw new Error(`unexpected ${name}`);
			}
			return { methodResponses: responses, sessionState: '' };
		}
	})
}));

import { getDb } from './db/index';
import { runMigrations } from './db/migrate';
import { isAccountTaskDone } from './db/queries/account-tasks';
import { runAccountTasks } from './account-tasks';
import type { AuthState } from '$lib/jmap/types';

const auth = { accountId: 'jmap' } as AuthState;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const SIEVE = { 'urn:ietf:params:jmap:sieve': {} };
let n = 0;
let address = '';

/** A fresh linked account, so each test starts with no task done. */
function newAccount(): string {
	n++;
	address = `a${n}@example.test`;
	getDb()
		.prepare(
			`INSERT INTO mail_accounts (id, user_id, email, server_url, jmap_account_id, secret_enc)
			 VALUES (?, 'user-1', ?, 'https://mail.example', 'jmap', 'x')`
		)
		.run(`acct-${n}`, address);
	return `acct-${n}`;
}

beforeAll(() => {
	runMigrations();
	getDb().prepare(`INSERT INTO app_user (id, email, password_hash) VALUES ('user-1', 'me@example.test', 'x')`).run();
});

beforeEach(() => {
	state.capabilities = SIEVE;
	state.scripts = [];
	state.calls = [];
	state.fail = false;
	state.refuse = false;
	state.attempts = 0;
});

describe('retire_sieve_script', () => {
	it('switches off and deletes the script Zajel left, and is done', async () => {
		const id = newAccount();
		state.scripts = [{ id: 's1', name: 'mailrules', isActive: true }];
		await runAccountTasks(auth, address);
		expect(state.scripts).toEqual([]);
		expect(state.calls.filter(([name]) => name === 'SieveScript/set').map(([, args]) => args)).toEqual([
			{ accountId: 'jmap', onSuccessDeactivateScript: true },
			{ accountId: 'jmap', destroy: ['s1'] }
		]);
		expect(isAccountTaskDone(id, 'retire_sieve_script')).toBe(true);
	});

	it('leaves another client’s active script alone', async () => {
		newAccount();
		state.scripts = [
			{ id: 's1', name: 'mailrules', isActive: false },
			{ id: 's2', name: 'my-filters', isActive: true }
		];
		await runAccountTasks(auth, address);
		expect(state.scripts).toEqual([{ id: 's2', name: 'my-filters', isActive: true }]);
		expect(state.calls.some(([, args]) => 'onSuccessDeactivateScript' in args)).toBe(false);
	});

	it('touches nothing when there is no script of ours', async () => {
		const id = newAccount();
		state.scripts = [{ id: 's2', name: 'my-filters', isActive: true }];
		await runAccountTasks(auth, address);
		expect(state.calls.map(([name]) => name)).toEqual(['SieveScript/get']);
		expect(isAccountTaskDone(id, 'retire_sieve_script')).toBe(true);
	});

	it('is done at once on a server without Sieve', async () => {
		const id = newAccount();
		state.capabilities = {};
		await runAccountTasks(auth, address);
		expect(state.calls).toEqual([]);
		expect(isAccountTaskDone(id, 'retire_sieve_script')).toBe(true);
	});

	it('tries again an hour after a failure, not on the next minute’s run, without throwing', async () => {
		const id = newAccount();
		const t0 = Date.parse('2026-11-20T12:00:00Z');
		state.scripts = [{ id: 's1', name: 'mailrules', isActive: true }];
		state.fail = true;
		await expect(runAccountTasks(auth, address, t0)).resolves.toBeUndefined();
		expect(state.attempts).toBe(1);
		expect(isAccountTaskDone(id, 'retire_sieve_script')).toBe(false);

		state.fail = false;
		await runAccountTasks(auth, address, t0 + MINUTE);
		expect(state.attempts).toBe(1);
		expect(isAccountTaskDone(id, 'retire_sieve_script')).toBe(false);

		await runAccountTasks(auth, address, t0 + HOUR);
		expect(state.attempts).toBe(2);
		expect(state.scripts).toEqual([]);
		expect(isAccountTaskDone(id, 'retire_sieve_script')).toBe(true);
	});

	it('logs a failure that keeps happening once, and then at most once a day', async () => {
		newAccount();
		const t0 = Date.parse('2026-11-20T12:00:00Z');
		state.fail = true;
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		try {
			for (let h = 0; h < 30; h++) await runAccountTasks(auth, address, t0 + h * HOUR);
			expect(state.attempts).toBe(30);
			// The first failure, and the one a day later.
			expect(warn).toHaveBeenCalledTimes(2);
		} finally {
			warn.mockRestore();
		}
	});

	it('is not done while the server refuses to delete the script', async () => {
		const id = newAccount();
		state.scripts = [{ id: 's1', name: 'mailrules', isActive: false }];
		state.refuse = true;
		await runAccountTasks(auth, address);
		expect(isAccountTaskDone(id, 'retire_sieve_script')).toBe(false);
	});

	it('runs once', async () => {
		newAccount();
		await runAccountTasks(auth, address);
		state.calls = [];
		state.scripts = [{ id: 's9', name: 'mailrules', isActive: true }];
		await runAccountTasks(auth, address);
		expect(state.calls).toEqual([]);
		expect(state.scripts).toHaveLength(1);
	});
});
