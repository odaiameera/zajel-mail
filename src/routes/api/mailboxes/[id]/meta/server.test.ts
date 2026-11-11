import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

process.env.DATABASE_PATH = join(mkdtempSync(join(tmpdir(), 'zajel-meta-route-')), 'test.db');
vi.mock('$lib/server/log', () => ({ logEvent: vi.fn(), errorFields: (e: unknown) => ({ error: String(e) }) }));

// The active account's mailboxes. Another account's ids are simply not here.
const MAILBOXES = [
	{ id: 'IN', name: 'Inbox', role: 'inbox', parentId: null, sortOrder: 0, totalEmails: 0, unreadEmails: 0 },
	{ id: 'RML', name: 'Remind Me Later', role: null, parentId: null, sortOrder: 0, totalEmails: 0, unreadEmails: 0 },
	{ id: 'PRJ', name: 'Projects', role: null, parentId: null, sortOrder: 0, totalEmails: 0, unreadEmails: 0 },
	{ id: 'LBLS', name: 'Labels', role: null, parentId: null, sortOrder: 0, totalEmails: 0, unreadEmails: 0 },
	{ id: 'WORK', name: 'Work', role: null, parentId: 'LBLS', sortOrder: 0, totalEmails: 0, unreadEmails: 0 }
];
vi.mock('$lib/jmap/auth', () => ({ createClient: () => ({}) }));
vi.mock('$lib/jmap/mailbox', () => ({
	getMailboxes: async () => MAILBOXES,
	ensureArchiveMailbox: async () => 'AR'
}));
vi.mock('$lib/jmap/folders', () => ({
	deleteFolder: async () => ({ success: true }),
	createFolder: vi.fn(),
	moveFolder: vi.fn(),
	renameFolder: vi.fn(),
	reorderMailboxes: vi.fn(),
	validateFolderName: () => null
}));
vi.mock('$lib/jmap/labels', () => ({
	deleteLabelMailbox: async (_c: unknown, _a: string, id: string) => ({ success: true, id }),
	createLabelMailbox: vi.fn(),
	renameLabelMailbox: vi.fn(),
	listLabelMailboxes: async () => MAILBOXES.filter((m) => m.parentId === 'LBLS')
}));

import { getDb } from '$lib/server/db/index';
import { runMigrations } from '$lib/server/db/migrate';
import { getMailboxMeta, setMailboxMeta } from '$lib/server/db/queries/mailbox-meta';
import { PATCH } from './+server';
import { POST as foldersPOST } from '../../../folders/+server';

const ACCT = 'acct-meta';
const locals = { auth: { accountId: 'jmap' }, activeAccountId: ACCT };

async function patch(id: string, body: unknown) {
	const res = await PATCH({
		request: new Request(`http://localhost/api/mailboxes/${id}/meta`, { method: 'PATCH', body: JSON.stringify(body) }),
		params: { id },
		locals
	} as unknown as Parameters<typeof PATCH>[0]);
	return { status: res.status, body: await res.json() };
}

type Post = (event: never) => Promise<Response>;
async function post(handler: Post, body: unknown) {
	const res = await handler({
		request: new Request('http://localhost/api', { method: 'POST', body: JSON.stringify(body) }),
		locals
	} as never);
	return res.status;
}

beforeAll(() => {
	runMigrations();
	getDb().exec(`
		INSERT INTO app_user (id, email, password_hash) VALUES ('u1', 'u1@example.test', 'x');
		INSERT INTO mail_accounts (id, user_id, email, server_url, jmap_account_id, secret_enc)
			VALUES ('${ACCT}', 'u1', 'me@example.test', 'https://mail.example', 'j1', 'x');
	`);
});

beforeEach(() => {
	getDb().exec(`DELETE FROM mailbox_meta`);
});

describe('PATCH /api/mailboxes/[id]/meta', () => {
	it('sets a folder’s colour and icon in one write, and sends the icon’s drawing back', async () => {
		const { status, body } = await patch('PRJ', { color: '#ff0000', icon: 'star' });
		expect(status).toBe(200);
		expect(body).toMatchObject({ mailboxId: 'PRJ', color: '#ff0000', icon: 'star', displayName: null });
		expect(Array.isArray(body.iconNode)).toBe(true);
		expect(getMailboxMeta(ACCT, 'PRJ')).toMatchObject({ color: '#ff0000', icon: 'star' });
	});

	it('clears a colour set to null and keeps the icon', async () => {
		setMailboxMeta(ACCT, 'WORK', { color: '#00ff00', icon: 'star' });
		const { status, body } = await patch('WORK', { color: null });
		expect(status).toBe(200);
		expect(body).toMatchObject({ color: null, icon: 'star' });
		expect(getMailboxMeta(ACCT, 'WORK')?.color).toBeNull();
	});

	it('refuses a mailbox the active account doesn’t have', async () => {
		expect((await patch('SOMEONE-ELSES', { color: '#ff0000' })).status).toBe(404);
		expect(getMailboxMeta(ACCT, 'SOMEONE-ELSES')).toBeNull();
	});

	it('refuses system folders, the app’s own and the Labels container, and bad values', async () => {
		for (const id of ['IN', 'RML', 'LBLS']) expect((await patch(id, { color: '#ff0000' })).status).toBe(400);
		expect((await patch('PRJ', { color: 'red' })).status).toBe(400);
		expect((await patch('PRJ', { icon: 'not-an-icon' })).status).toBe(400);
		expect(getMailboxMeta(ACCT, 'PRJ')).toBeNull();
	});
});

describe('deleting a folder or a label', () => {
	it('deletes its colour and icon with it', async () => {
		setMailboxMeta(ACCT, 'PRJ', { color: '#ff0000' });
		setMailboxMeta(ACCT, 'WORK', { color: '#00ff00' });
		expect(await post(foldersPOST as Post, { action: 'delete', id: 'PRJ' })).toBe(200);
		expect(getMailboxMeta(ACCT, 'PRJ')).toBeNull();
		expect(await post(foldersPOST as Post, { action: 'delete', id: 'WORK' })).toBe(200);
		expect(getMailboxMeta(ACCT, 'WORK')).toBeNull();
	});
});
