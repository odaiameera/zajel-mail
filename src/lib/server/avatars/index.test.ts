import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	rows: new Map<string, unknown>(),
	resolveBimi: vi.fn(),
	resolveFavicon: vi.fn(),
	resolveGravatar: vi.fn()
}));

vi.mock('./store', () => ({
	getCache: (key: string) => mocks.rows.get(key),
	putCache: (key: string, row: unknown) => {
		mocks.rows.set(key, row);
	}
}));

vi.mock('./resolve', async (importOriginal) => ({
	...(await importOriginal<typeof import('./resolve')>()),
	resolveBimi: mocks.resolveBimi,
	resolveFavicon: mocks.resolveFavicon,
	resolveGravatar: mocks.resolveGravatar
}));

import { getAvatar } from './index';
import type { Lookup } from './resolve';

const NONE: Lookup = { outcome: 'none' };
const UNREACHABLE: Lookup = { outcome: 'unreachable' };
const GRAVATAR: Lookup = {
	outcome: 'found',
	asset: { contentType: 'image/png', bytes: Buffer.from('png'), source: 'gravatar' }
};

function answers(bimi: Lookup, favicon: Lookup, gravatar: Lookup) {
	mocks.resolveBimi.mockResolvedValue(bimi);
	mocks.resolveFavicon.mockResolvedValue(favicon);
	mocks.resolveGravatar.mockResolvedValue(gravatar);
}

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(new Date('2026-11-02T12:00:00Z'));
	mocks.rows.clear();
});

afterEach(() => {
	vi.useRealTimers();
	mocks.resolveBimi.mockReset();
	mocks.resolveFavicon.mockReset();
	mocks.resolveGravatar.mockReset();
});

describe('getAvatar', () => {
	it('tries again after minutes when nothing answered, after a week when there was nothing', async () => {
		// The uplink is down while the inbox renders.
		answers(UNREACHABLE, UNREACHABLE, UNREACHABLE);
		expect(await getAvatar('ada@example.test')).toEqual({ status: 'missing' });
		expect(mocks.resolveFavicon).toHaveBeenCalledTimes(1);
		expect(mocks.resolveGravatar).toHaveBeenCalledTimes(1);

		// Minutes later it is tried again rather than remembered as "no avatar".
		vi.advanceTimersByTime(16 * MINUTE);
		answers(NONE, NONE, NONE);
		expect(await getAvatar('ada@example.test')).toEqual({ status: 'missing' });
		expect(mocks.resolveFavicon).toHaveBeenCalledTimes(2);
		expect(mocks.resolveGravatar).toHaveBeenCalledTimes(2);

		// A real "none" is kept for the week.
		vi.advanceTimersByTime(16 * MINUTE);
		await getAvatar('ada@example.test');
		expect(mocks.resolveFavicon).toHaveBeenCalledTimes(2);
		expect(mocks.resolveGravatar).toHaveBeenCalledTimes(2);

		vi.advanceTimersByTime(8 * DAY);
		await getAvatar('ada@example.test');
		expect(mocks.resolveFavicon).toHaveBeenCalledTimes(3);
		expect(mocks.resolveGravatar).toHaveBeenCalledTimes(3);
	});

	it('does not let one source failing to answer hide behind another saying no', async () => {
		answers(UNREACHABLE, NONE, NONE);
		await getAvatar('ada@example.test');
		vi.advanceTimersByTime(16 * MINUTE);
		await getAvatar('ada@example.test');
		expect(mocks.resolveBimi).toHaveBeenCalledTimes(2);
	});

	it('gives a freemail sender their own Gravatar, never the provider logo', async () => {
		answers(NONE, NONE, GRAVATAR);
		const out = await getAvatar('Alice <alice@gmail.com>');
		expect(out.status).toBe('found');
		if (out.status === 'found') expect(out.source).toBe('gravatar');
		expect(mocks.resolveBimi).not.toHaveBeenCalled();
		expect(mocks.resolveFavicon).not.toHaveBeenCalled();
		expect(mocks.resolveGravatar).toHaveBeenCalledWith('alice@gmail.com');
	});

	it('keeps a found logo for a month', async () => {
		answers(NONE, { outcome: 'found', asset: { contentType: 'image/png', bytes: Buffer.from('f'), source: 'favicon' } }, NONE);
		await getAvatar('a@brand.test');
		vi.advanceTimersByTime(20 * DAY);
		const out = await getAvatar('b@brand.test');
		expect(out.status).toBe('found');
		expect(mocks.resolveFavicon).toHaveBeenCalledTimes(1);
	});
});
