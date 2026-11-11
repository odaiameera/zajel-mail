import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Cookies } from '@sveltejs/kit';
import type { JMAPClient } from '$lib/jmap/client';
import type { Mailbox } from '$lib/jmap/types';

const metaWrites = vi.hoisted(() => [] as { mailboxId: string; color: string | null | undefined }[]);
vi.mock('$lib/server/db/queries/mailbox-meta', () => ({
	listMailboxMeta: () => [],
	setMailboxMeta: (_account: string, mailboxId: string, patch: { color?: string | null }) =>
		metaWrites.push({ mailboxId, color: patch.color })
}));

import { migrateKeywordLabelsIfNeeded } from './labels';

function box(id: string, name: string, extra: Partial<Mailbox> = {}): Mailbox {
	return { id, name, role: null, sortOrder: 0, totalEmails: 0, unreadEmails: 0, parentId: null, ...extra };
}

// An in-memory account with messages still marked by the old label keywords.
const state = {
	mailboxes: [] as Mailbox[],
	boxes: {} as Record<string, Record<string, boolean>>,
	keywords: {} as Record<string, Record<string, boolean>>,
	refuse: false,
	requests: 0
};

const client = {
	request: async ([[name, args]]: [string, Record<string, unknown>][]) => {
		state.requests++;
		const reply = (result: unknown) => ({ methodResponses: [[name, result, '0']], sessionState: '' });
		if (name === 'Mailbox/get') return reply({ list: state.mailboxes });
		if (name === 'Mailbox/set') {
			const created: Record<string, { id: string }> = {};
			for (const [key, value] of Object.entries((args.create ?? {}) as Record<string, Partial<Mailbox>>)) {
				const id = `NEW-${value.name}`;
				state.mailboxes.push(box(id, value.name ?? '', { parentId: value.parentId ?? null }));
				created[key] = { id };
			}
			return reply({ created });
		}
		if (name === 'Email/query') {
			const keyword = (args.filter as { hasKeyword: string }).hasKeyword;
			return reply({ ids: Object.keys(state.keywords).filter((id) => state.keywords[id][keyword]) });
		}
		if (name === 'Email/get') {
			return reply({ list: (args.ids as string[]).map((id) => ({ id, mailboxIds: state.boxes[id] })) });
		}
		if (name === 'Email/set') {
			const update = (args.update ?? {}) as Record<string, Record<string, unknown>>;
			if (state.refuse) {
				return reply({ notUpdated: Object.fromEntries(Object.keys(update).map((id) => [id, { type: 'invalidPatch' }])) });
			}
			for (const [id, patch] of Object.entries(update)) {
				for (const [key, value] of Object.entries(patch)) {
					if (key === 'mailboxIds') state.boxes[id] = value as Record<string, boolean>;
					else if (key.startsWith('keywords/')) {
						const keyword = key.slice(9);
						if (value) state.keywords[id][keyword] = true;
						else delete state.keywords[id][keyword];
					} else throw new Error(`unexpected patch ${key}`);
				}
			}
			return reply({ notUpdated: {} });
		}
		throw new Error(`unexpected ${name}`);
	}
} as unknown as JMAPClient;

function cookieJar(values: Record<string, string>) {
	const jar = { ...values };
	/** Every Set-Cookie the response would carry. */
	const written: string[] = [];
	const cookies = {
		get: (name: string) => jar[name],
		set: (name: string, value: string) => {
			written.push(name);
			jar[name] = value;
		},
		delete: (name: string) => {
			written.push(name);
			delete jar[name];
		}
	} as unknown as Cookies;
	return { jar, cookies, written };
}

const HOUR = 60 * 60 * 1000;
const T0 = Date.parse('2026-11-01T09:00:00Z');

const OLD = encodeURIComponent(JSON.stringify([{ id: 'kw_work', name: 'Work', color: '#ff0000' }]));

beforeEach(() => {
	state.mailboxes = [box('IN', 'Inbox', { role: 'inbox' }), box('PRJ', 'Projects')];
	state.boxes = { m1: { IN: true }, m2: { PRJ: true } };
	state.keywords = { m1: { kw_work: true, $seen: true }, m2: { kw_work: true } };
	state.refuse = false;
	state.requests = 0;
	metaWrites.length = 0;
});

describe('migrateKeywordLabelsIfNeeded', () => {
	it('does nothing at all without the old cookie, and sends no cookie', async () => {
		const { jar, cookies, written } = cookieJar({});
		await migrateKeywordLabelsIfNeeded(client, 'acct', 'row-1', cookies);
		expect(state.requests).toBe(0);
		expect(jar).toEqual({});
		expect(written).toEqual([]);
	});

	it('makes the label, labels each marked message where it is, clears the keyword, then drops the cookie', async () => {
		const { jar, cookies } = cookieJar({ mail_labels: OLD });
		await migrateKeywordLabelsIfNeeded(client, 'acct', 'row-1', cookies);
		expect(state.boxes).toEqual({ m1: { IN: true, 'NEW-Work': true }, m2: { PRJ: true, 'NEW-Work': true } });
		expect(state.keywords).toEqual({ m1: { $seen: true }, m2: {} });
		expect(metaWrites).toEqual([{ mailboxId: 'NEW-Work', color: '#ff0000' }]);
		expect(jar.mail_labels).toBeUndefined();
	});

	it('keeps the cookie when the server refuses a write, so a load an hour later tries again', async () => {
		state.refuse = true;
		const { jar, cookies } = cookieJar({ mail_labels: OLD });
		await migrateKeywordLabelsIfNeeded(client, 'acct', 'row-retry', cookies, T0);
		expect(jar.mail_labels).toBe(OLD);
		expect(state.keywords.m1.kw_work).toBe(true);

		// It does, and reuses the label it made the first time.
		state.refuse = false;
		await migrateKeywordLabelsIfNeeded(client, 'acct', 'row-retry', cookies, T0 + HOUR);
		expect(jar.mail_labels).toBeUndefined();
		expect(state.mailboxes.filter((m) => m.name === 'Work')).toHaveLength(1);
		expect(state.boxes.m1).toEqual({ IN: true, 'NEW-Work': true });
	});

	it('tries once an hour while a write is refused for good, and writes the old colour only once', async () => {
		// The reviewer's case: before, every page load re-ran it all and wrote
		// the cookie's colour over the label's again.
		state.refuse = true;
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const { jar, cookies } = cookieJar({ mail_labels: OLD });
		await migrateKeywordLabelsIfNeeded(client, 'acct', 'row-refused', cookies, T0);
		const firstAttempt = state.requests;
		expect(firstAttempt).toBeGreaterThan(0);
		// Two more loads within the hour ask the mail server nothing.
		for (const minutes of [10, 59]) {
			await migrateKeywordLabelsIfNeeded(client, 'acct', 'row-refused', cookies, T0 + minutes * 60_000);
		}
		expect(state.requests).toBe(firstAttempt);
		expect(jar.mail_labels).toBe(OLD);
		expect(metaWrites).toEqual([{ mailboxId: 'NEW-Work', color: '#ff0000' }]);
		expect(warn).toHaveBeenCalledTimes(1);

		// An hour after the first: a second attempt, which finds the label it
		// made and leaves its colour alone. No second warning the same day.
		await migrateKeywordLabelsIfNeeded(client, 'acct', 'row-refused', cookies, T0 + HOUR);
		expect(state.requests).toBeGreaterThan(firstAttempt);
		expect(metaWrites).toHaveLength(1);
		expect(jar.mail_labels).toBe(OLD);
		expect(warn).toHaveBeenCalledTimes(1);

		// A day on, still failing: said once more.
		await migrateKeywordLabelsIfNeeded(client, 'acct', 'row-refused', cookies, T0 + 25 * HOUR);
		expect(warn).toHaveBeenCalledTimes(2);
		warn.mockRestore();
	});

	it('leaves the colour of a label that already exists as its owner set it', async () => {
		state.mailboxes.push(box('LBLS', 'Labels'), box('WK', 'Work', { parentId: 'LBLS' }));
		const { jar, cookies } = cookieJar({ mail_labels: OLD });
		await migrateKeywordLabelsIfNeeded(client, 'acct', 'row-existing', cookies, T0);
		expect(metaWrites).toEqual([]);
		expect(state.boxes.m1).toEqual({ IN: true, WK: true });
		expect(jar.mail_labels).toBeUndefined();
	});

	it('drops a cookie that holds nothing to carry over', async () => {
		const { jar, cookies } = cookieJar({ mail_labels: 'not json' });
		await migrateKeywordLabelsIfNeeded(client, 'acct', 'row-1', cookies);
		expect(jar.mail_labels).toBeUndefined();
	});
});
