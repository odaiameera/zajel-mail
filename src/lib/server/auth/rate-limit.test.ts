import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Point the lazy SQLite singleton at a throwaway file before anything opens it.
process.env.DATABASE_PATH = join(mkdtempSync(join(tmpdir(), 'ameera-rate-')), 'test.db');

const mocks = vi.hoisted(() => ({ logEvent: vi.fn() }));
vi.mock('$lib/server/log', () => ({ logEvent: mocks.logEvent }));

import { getDb } from '../db/index';
import { runMigrations } from '../db/migrate';
import { isIpLockedOut, isLockedOut, isPrivateAddress, recordFailure, recordIpFailure, recordSuccess } from './rate-limit';

const IP = '203.0.113.7';
const rows = () =>
	getDb().prepare('SELECT key, window_start, locked_until FROM login_attempts').all() as {
		key: string;
		window_start: string;
		locked_until: string | null;
	}[];

beforeAll(() => {
	runMigrations();
});

beforeEach(() => {
	getDb().prepare('DELETE FROM login_attempts').run();
	mocks.logEvent.mockClear();
	vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe('login rate limiting', () => {
	it('locks an email and IP out after ten failures, whatever the case', () => {
		for (let i = 0; i < 9; i++) recordFailure('Me@Example.test', IP);
		expect(isLockedOut('me@example.test', IP)).toBe(false);
		recordFailure(' me@example.test ', IP);
		expect(isLockedOut('ME@EXAMPLE.TEST', IP)).toBe(true);
		expect(isLockedOut('me@example.test', '198.51.100.1')).toBe(false);

		recordSuccess('me@example.test', IP);
		expect(isLockedOut('me@example.test', IP)).toBe(false);
	});

	it('stores a fixed-size key however long the email is', () => {
		recordFailure('x'.repeat(100_000), IP);
		const [row] = rows();
		expect(row.key.length).toBeLessThanOrEqual(100);
		expect(row.key).not.toContain('xxxx');
	});

	it('clears out attempts whose window and lockout have both run out', () => {
		vi.useFakeTimers({ now: new Date('2026-11-01T09:00:00Z') });
		recordFailure('stale@example.test', IP);
		for (let i = 0; i < 10; i++) recordFailure('locked@example.test', IP);

		// Twenty minutes on: the first window is over, the lockout too.
		vi.setSystemTime(new Date('2026-11-01T09:20:00Z'));
		recordFailure('new@example.test', IP);
		expect(rows()).toHaveLength(1);

		// A lockout still running is kept.
		for (let i = 0; i < 10; i++) recordFailure('again@example.test', IP);
		vi.setSystemTime(new Date('2026-11-01T09:25:00Z'));
		recordFailure('other@example.test', IP);
		expect(isLockedOut('again@example.test', IP)).toBe(true);
	});
});

describe('the per-address limit behind a proxy', () => {
	it('knows a private or loopback address when it sees one', () => {
		for (const ip of ['127.0.0.1', '::1', '10.0.0.4', '172.18.0.1', '172.31.255.1', '192.168.1.9', '::ffff:172.17.0.1', 'fd00::1', 'fe80::1']) {
			expect(isPrivateAddress(ip), ip).toBe(true);
		}
		for (const ip of ['203.0.113.7', '172.32.0.1', '8.8.8.8', '2001:db8::1', '::ffff:8.8.8.8']) {
			expect(isPrivateAddress(ip), ip).toBe(false);
		}
	});

	it('names ADDRESS_HEADER once when a private address trips it, since then every client shares it', () => {
		for (let i = 0; i < 31; i++) recordIpFailure('172.18.0.1');
		expect(isIpLockedOut('172.18.0.1')).toBe(true);
		const warnings = mocks.logEvent.mock.calls.filter((c) => c[2] === 'ip_lockout_behind_proxy');
		expect(warnings).toHaveLength(1);
		expect(warnings[0][3]).toMatchObject({ ip: '172.18.0.1', hint: 'ADDRESS_HEADER' });
		expect(vi.mocked(console.warn).mock.calls[0]?.[0]).toContain('ADDRESS_HEADER=X-Forwarded-For');
	});

	it('says nothing for a public address, which is one client', () => {
		for (let i = 0; i < 31; i++) recordIpFailure(IP);
		expect(isIpLockedOut(IP)).toBe(true);
		expect(mocks.logEvent).not.toHaveBeenCalled();
	});
});
