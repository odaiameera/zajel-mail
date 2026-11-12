import { describe, expect, it } from 'vitest';
import { notifiedFolders } from './notification-folders';

const mailboxes = [
	{ id: 'mb-inbox', role: 'inbox' },
	{ id: 'mb-news', role: null }
];

describe('notifiedFolders', () => {
	it('is the Inbox when nothing was ever chosen, since that is what notifies', () => {
		expect(notifiedFolders([], mailboxes)).toEqual(['mb-inbox']);
	});

	it('is the Inbox for the old default, the word "inbox", which is no folder’s id', () => {
		expect(notifiedFolders(['inbox'], mailboxes)).toEqual(['inbox', 'mb-inbox']);
	});

	it('is the stored choice when it names a folder of this account', () => {
		expect(notifiedFolders(['mb-news'], mailboxes)).toEqual(['mb-news']);
	});

	it('adds this account’s Inbox to another account’s folders, and keeps those', () => {
		expect(notifiedFolders(['other-account-inbox'], mailboxes)).toEqual(['other-account-inbox', 'mb-inbox']);
	});

	it('adds nothing for an account with no Inbox', () => {
		expect(notifiedFolders([], [{ id: 'mb-news', role: null }])).toEqual([]);
	});
});
