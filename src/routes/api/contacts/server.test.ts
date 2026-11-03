import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	createClient: vi.fn(),
	fetchSession: vi.fn(),
	getAddressBooks: vi.fn(),
	getContacts: vi.fn(),
	queryAllContacts: vi.fn(),
	queryContacts: vi.fn(),
	queryContactLists: vi.fn(),
	createContact: vi.fn(),
	createContacts: vi.fn(),
	updateContact: vi.fn(),
	deleteContact: vi.fn()
}));

vi.mock('$lib/jmap/auth', () => ({
	createClient: mocks.createClient,
	fetchSession: mocks.fetchSession
}));

vi.mock('$lib/jmap/contacts', async (importOriginal) => ({
	...(await importOriginal<typeof import('$lib/jmap/contacts')>()),
	getAddressBooks: mocks.getAddressBooks,
	getContacts: mocks.getContacts,
	queryAllContacts: mocks.queryAllContacts,
	queryContacts: mocks.queryContacts,
	queryContactLists: mocks.queryContactLists,
	createContact: mocks.createContact,
	createContacts: mocks.createContacts,
	updateContact: mocks.updateContact,
	deleteContact: mocks.deleteContact
}));

import { CONTACTS_CAPABILITY, ContactSetError } from '$lib/jmap/contacts';
import { JMAPAuthError, JMAPError } from '$lib/jmap/client';
import { GET, POST } from './+server';
import type { AuthState, JMAPSession } from '$lib/jmap/types';

const auth: AuthState = {
	authHeader: 'Basic secret',
	accountId: 'mail-account',
	apiUrl: 'https://mail.example.test/jmap/',
	sessionState: ''
};

function contactsSession(): JMAPSession {
	return {
		apiUrl: auth.apiUrl,
		downloadUrl: '',
		uploadUrl: '',
		eventSourceUrl: '',
		primaryAccounts: { [CONTACTS_CAPABILITY]: 'contacts-account' },
		accounts: {
			'contacts-account': {
				name: 'Example',
				isPersonal: true,
				isReadOnly: false,
				accountCapabilities: {
					[CONTACTS_CAPABILITY]: {
						maxAddressBooksPerCard: null,
						mayCreateAddressBook: true
					}
				}
			}
		},
		capabilities: { [CONTACTS_CAPABILITY]: {} },
		state: 'state-1'
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.createClient.mockReturnValue({ client: true });
	mocks.queryAllContacts.mockResolvedValue([]);
	mocks.queryContactLists.mockResolvedValue([]);
	mocks.getAddressBooks.mockResolvedValue([{
		id: 'book-1',
		name: 'Personal',
		description: null,
		sortOrder: 0,
		isDefault: true,
		isSubscribed: true,
		myRights: { mayRead: true, mayWrite: true, mayShare: false, mayDelete: false }
	}]);
});

describe('GET /api/contacts', () => {
	it('requires an authenticated active mail account', async () => {
		const response = await GET({
			locals: {},
			url: new URL('https://webmail.example.test/api/contacts')
		} as never);

		expect(response.status).toBe(401);
		await expect(response.json()).resolves.toEqual({ error: 'Not authenticated' });
	});

	it('detects the Contacts account and returns address books plus a bounded query page', async () => {
		mocks.fetchSession.mockResolvedValue(contactsSession());
		mocks.getAddressBooks.mockResolvedValue([{ id: 'book-1', name: 'Contacts' }]);
		mocks.queryContacts.mockResolvedValue({
			contacts: [{ id: 'contact-1', name: { full: 'Ada Lovelace' } }],
			queryState: 'query-1',
			total: 1
		});

		const response = await GET({
			locals: { auth },
			url: new URL('https://webmail.example.test/api/contacts?q=%20ada%20&limit=999&position=-4')
		} as never);

		expect(response.status).toBe(200);
		expect(response.headers.get('cache-control')).toBe('private, no-store');
		await expect(response.json()).resolves.toEqual({
			supported: true,
			capabilities: { maxAddressBooksPerCard: null, mayCreateAddressBook: true },
			addressBooks: [{ id: 'book-1', name: 'Contacts' }],
			contacts: [{ id: 'contact-1', name: { full: 'Ada Lovelace' } }],
			queryState: 'query-1',
			total: 1,
			listsSupported: true,
			lists: []
		});
		expect(mocks.queryContacts).toHaveBeenCalledWith(
			{ client: true },
			'contacts-account',
			'ada',
			100,
			0
		);
	});

	it('returns a graceful unsupported state without breaking other app capabilities', async () => {
		const session = contactsSession();
		session.capabilities = {};
		mocks.fetchSession.mockResolvedValue(session);

		const response = await GET({
			locals: { auth },
			url: new URL('https://webmail.example.test/api/contacts')
		} as never);

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual({
			supported: false,
			capabilities: null,
			addressBooks: [],
			contacts: [],
			queryState: '',
			total: 0,
			listsSupported: false,
			lists: []
		});
	});

	it('maps rejected stored credentials to a non-sensitive reauthentication response', async () => {
		mocks.fetchSession.mockRejectedValue(new JMAPAuthError('secret upstream detail'));

		const response = await GET({
			locals: { auth },
			url: new URL('https://webmail.example.test/api/contacts')
		} as never);

		expect(response.status).toBe(401);
		await expect(response.json()).resolves.toEqual({
			error: 'Mail account authentication failed'
		});
	});

	it('does not expose arbitrary upstream failure details', async () => {
		mocks.fetchSession.mockRejectedValue(new JMAPError('internal host and account details'));

		const response = await GET({
			locals: { auth },
			url: new URL('https://webmail.example.test/api/contacts')
		} as never);

		expect(response.status).toBe(502);
		await expect(response.json()).resolves.toEqual({ error: 'Unable to load contacts' });
	});
});

describe('POST /api/contacts', () => {
	it('validates and creates a flattened JSContact in the resolved Contacts account', async () => {
		mocks.fetchSession.mockResolvedValue(contactsSession());
		const created = {
			id: 'contact-1',
			addressBookIds: { 'book-1': true },
			'@type': 'Card',
			version: '1.0',
			uid: 'urn:uuid:created',
			name: { full: 'Ada Lovelace' }
		};
		mocks.createContact.mockResolvedValue(created);
		const request = new Request('https://webmail.example.test/api/contacts', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				action: 'create',
				contact: {
					name: ' Ada Lovelace ',
					emails: [{ address: ' ADA@EXAMPLE.TEST ', type: 'work' }],
					phones: [],
					organization: '',
					notes: '',
					favorite: false,
					addressBookIds: ['book-1']
				}
			})
		});

		const response = await POST({ locals: { auth }, request } as never);

		expect(response.status).toBe(201);
		expect(response.headers.get('cache-control')).toBe('private, no-store');
		await expect(response.json()).resolves.toEqual({ success: true, contact: created });
		expect(mocks.createContact).toHaveBeenCalledWith(
			{ client: true },
			'contacts-account',
			expect.objectContaining({
				addressBookIds: { 'book-1': true },
				'@type': 'Card',
				version: '1.0',
				uid: expect.stringMatching(/^urn:uuid:/),
				name: { full: 'Ada Lovelace' },
				emails: {
					email1: { address: 'ada@example.test', contexts: { work: true }, pref: 1 }
				}
			})
		);
	});

	it('rejects a mutation targeting an address book without write rights', async () => {
		mocks.fetchSession.mockResolvedValue(contactsSession());
		mocks.getAddressBooks.mockResolvedValue([{
			id: 'book-2',
			name: 'Directory',
			description: null,
			sortOrder: 0,
			isDefault: false,
			isSubscribed: true,
			myRights: { mayRead: true, mayWrite: false, mayShare: false, mayDelete: false }
		}]);
		const request = new Request('https://webmail.example.test/api/contacts', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				action: 'create',
				contact: { name: 'Ada', emails: [], addressBookIds: ['book-2'] }
			})
		});

		const response = await POST({ locals: { auth }, request } as never);

		expect(response.status).toBe(400);
		await expect(response.json()).resolves.toEqual({ error: 'Selected address book is not writable' });
		expect(mocks.createContact).not.toHaveBeenCalled();
	});

	it('imports at most 50 contacts in one JMAP batch and reports validation plus set failures by source row', async () => {
		mocks.fetchSession.mockResolvedValue(contactsSession());
		const created = {
			id: 'contact-1',
			addressBookIds: { 'book-1': true },
			'@type': 'Card',
			version: '1.0',
			uid: 'urn:uuid:created',
			name: { full: 'Ada' }
		};
		mocks.createContacts.mockResolvedValue({
			created: [{ creationId: 'import0', contact: created }],
			failures: [{
				operation: 'create',
				id: 'import1',
				type: 'invalidProperties',
				description: 'server rejected Grace',
				properties: ['name']
			}]
		});
		const form = (name: string, address: string) => ({
			name,
			emails: [{ address, type: 'work' }],
			phones: [],
			organization: '',
			notes: '',
			favorite: false,
			addressBookIds: ['book-1']
		});
		const request = new Request('https://webmail.example.test/api/contacts', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				action: 'import',
				contacts: [
					form('Ada', 'ada@example.test'),
					form('Broken', 'not-an-email'),
					form('Grace', 'grace@example.test')
				]
			})
		});

		const response = await POST({ locals: { auth }, request } as never);

		expect(response.status).toBe(207);
		await expect(response.json()).resolves.toEqual({
			success: false,
			imported: 1,
			failed: 2,
			created: [{ index: 0, contact: created }],
			failures: [
				{ index: 1, error: 'Invalid email address: not-an-email' },
				{
					index: 2,
					error: 'One or more contact fields were rejected',
					type: 'invalidProperties',
					properties: ['name']
				}
			]
		});
		expect(mocks.createContacts).toHaveBeenCalledWith(
			{ client: true },
			'contacts-account',
			expect.arrayContaining([
				expect.objectContaining({ name: { full: 'Ada' } }),
				expect.objectContaining({ name: { full: 'Grace' } })
			])
		);
	});

	it('rejects import duplicates against the complete server-side contact inventory', async () => {
		mocks.fetchSession.mockResolvedValue(contactsSession());
		mocks.queryAllContacts.mockResolvedValue([{
			id: 'contact-100',
			addressBookIds: { 'book-1': true },
			'@type': 'Card',
			version: '1.0',
			uid: 'urn:uuid:existing',
			emails: { primary: { address: 'existing@example.test' } }
		}]);
		const created = {
			id: 'contact-new',
			addressBookIds: { 'book-1': true },
			'@type': 'Card',
			version: '1.0',
			uid: 'urn:uuid:new',
			name: { full: 'New contact' }
		};
		mocks.createContacts.mockResolvedValue({
			created: [{ creationId: 'import0', contact: created }],
			failures: []
		});
		const form = (name: string, address: string) => ({
			name,
			emails: [{ address, type: 'work' }],
			phones: [],
			organization: '',
			notes: '',
			favorite: false,
			addressBookIds: ['book-1']
		});
		const request = new Request('https://webmail.example.test/api/contacts', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				action: 'import',
				contacts: [
					form('Existing', 'EXISTING@example.test'),
					form('New contact', 'new@example.test')
				]
			})
		});

		const response = await POST({ locals: { auth }, request } as never);

		expect(response.status).toBe(207);
		await expect(response.json()).resolves.toEqual({
			success: false,
			imported: 1,
			failed: 1,
			created: [{ index: 1, contact: created }],
			failures: [{
				index: 0,
				error: 'A contact with this email address already exists',
				type: 'duplicate'
			}]
		});
		expect(mocks.queryAllContacts).toHaveBeenCalledWith({ client: true }, 'contacts-account');
		expect(mocks.createContacts).toHaveBeenCalledWith(
			{ client: true },
			'contacts-account',
			[expect.objectContaining({
				name: { full: 'New contact' },
				emails: { email1: expect.objectContaining({ address: 'new@example.test' }) }
			})]
		);
	});

	it('fetches the current card before updating so unexposed data survives the edit', async () => {
		mocks.fetchSession.mockResolvedValue(contactsSession());
		mocks.getContacts.mockResolvedValue([{
			id: 'contact-1',
			'@type': 'Card',
			version: '1.0',
			uid: 'urn:uuid:contact-1',
			addressBookIds: { 'book-1': true },
			name: {
				full: 'Ada Lovelace',
				components: [{ kind: 'given', value: 'Ada' }, { kind: 'surname', value: 'Lovelace' }]
			},
			emails: {
				primary: { address: 'ada@example.test', label: 'Office' }
			}
		}]);
		mocks.updateContact.mockResolvedValue(undefined);
		const request = new Request('https://webmail.example.test/api/contacts', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				action: 'update',
				id: 'contact-1',
				contact: {
					name: 'Ada Byron',
					emails: [{ id: 'primary', address: 'ada@example.test', type: 'home' }],
					phones: [],
					organization: '',
					notes: '',
					favorite: false,
					addressBookIds: ['book-1']
				}
			})
		});

		const response = await POST({ locals: { auth }, request } as never);

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual({ success: true });
		expect(mocks.getContacts).toHaveBeenCalledWith(
			{ client: true },
			'contacts-account',
			['contact-1']
		);
		expect(mocks.updateContact).toHaveBeenCalledWith(
			{ client: true },
			'contacts-account',
			'contact-1',
			{
				// The label the form never showed survives; the name parts follow
				// the new name rather than describing the old one.
				name: {
					full: 'Ada Byron',
					components: [{ kind: 'given', value: 'Ada' }, { kind: 'surname', value: 'Byron' }],
					isOrdered: true
				},
				emails: {
					primary: {
						address: 'ada@example.test',
						contexts: { private: true },
						label: 'Office'
					}
				},
				phones: null,
				organizations: null,
				notes: null,
				keywords: null,
				addressBookIds: { 'book-1': true }
			}
		);
	});

	it('deletes only the requested contact id', async () => {
		mocks.fetchSession.mockResolvedValue(contactsSession());
		mocks.deleteContact.mockResolvedValue(undefined);
		const request = new Request('https://webmail.example.test/api/contacts', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ action: 'delete', id: ' contact-1 ' })
		});

		const response = await POST({ locals: { auth }, request } as never);

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual({ success: true });
		expect(mocks.deleteContact).toHaveBeenCalledWith(
			{ client: true },
			'contacts-account',
			'contact-1'
		);
	});

	it('rejects malformed client fields before any JMAP mutation', async () => {
		mocks.fetchSession.mockResolvedValue(contactsSession());
		const request = new Request('https://webmail.example.test/api/contacts', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				action: 'create',
				contact: {
					name: '',
					emails: [{ address: 'not-an-email' }],
					addressBookIds: ['book-1']
				}
			})
		});

		const response = await POST({ locals: { auth }, request } as never);

		expect(response.status).toBe(400);
		await expect(response.json()).resolves.toEqual({
			error: 'Invalid email address: not-an-email'
		});
		expect(mocks.createContact).not.toHaveBeenCalled();
	});

	it('returns structured JMAP set failures without arbitrary upstream descriptions', async () => {
		mocks.fetchSession.mockResolvedValue(contactsSession());
		const failures = [
			{
				operation: 'create' as const,
				id: 'contact',
				type: 'invalidProperties',
				description: 'uid is required',
				properties: ['uid']
			}
		];
		mocks.createContact.mockRejectedValue(
			new ContactSetError('Contact create rejected: uid is required (uid)', failures)
		);
		const request = new Request('https://webmail.example.test/api/contacts', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				action: 'create',
				contact: { name: 'Ada', emails: [], addressBookIds: ['book-1'] }
			})
		});

		const response = await POST({ locals: { auth }, request } as never);

		expect(response.status).toBe(422);
		await expect(response.json()).resolves.toEqual({
			error: 'Contact change was rejected',
			failures: [{
				operation: 'create',
				id: 'contact',
				type: 'invalidProperties',
				description: 'One or more contact fields were rejected',
				properties: ['uid']
			}]
		});
	});

	it('returns an explicit unsupported response when Contacts is disabled', async () => {
		const session = contactsSession();
		session.capabilities = {};
		mocks.fetchSession.mockResolvedValue(session);
		const request = new Request('https://webmail.example.test/api/contacts', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				action: 'create',
				contact: { name: 'Ada', emails: [], addressBookIds: ['book-1'] }
			})
		});

		const response = await POST({ locals: { auth }, request } as never);

		expect(response.status).toBe(501);
		await expect(response.json()).resolves.toEqual({
			supported: false,
			error: 'JMAP Contacts is not available for this account'
		});
		expect(mocks.createContact).not.toHaveBeenCalled();
	});

	it('maps mutation authentication failures without exposing upstream details', async () => {
		mocks.fetchSession.mockRejectedValue(new JMAPAuthError('secret upstream detail'));
		const request = new Request('https://webmail.example.test/api/contacts', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				action: 'create',
				contact: { name: 'Ada', emails: [], addressBookIds: ['book-1'] }
			})
		});

		const response = await POST({ locals: { auth }, request } as never);

		expect(response.status).toBe(401);
		await expect(response.json()).resolves.toEqual({
			error: 'Mail account authentication failed'
		});
	});

	it('maps arbitrary mutation failures to a non-sensitive gateway response', async () => {
		mocks.fetchSession.mockResolvedValue(contactsSession());
		mocks.createContact.mockRejectedValue(new JMAPError('internal host and account details'));
		const request = new Request('https://webmail.example.test/api/contacts', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				action: 'create',
				contact: { name: 'Ada', emails: [], addressBookIds: ['book-1'] }
			})
		});

		const response = await POST({ locals: { auth }, request } as never);

		expect(response.status).toBe(502);
		await expect(response.json()).resolves.toEqual({ error: 'Unable to update contacts' });
	});
});

describe('POST /api/contacts — lists', () => {
	function post(body: Record<string, unknown>) {
		const request = new Request('https://webmail.example.test/api/contacts', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(body)
		});
		return POST({ locals: { auth }, request } as never);
	}

	beforeEach(() => {
		mocks.fetchSession.mockResolvedValue(contactsSession());
	});

	it('creates a list as a group card in the default writable address book', async () => {
		mocks.createContact.mockImplementation(async (_client, _account, card) => ({ ...card, id: 'list-1' }));
		const response = await post({ action: 'createList', name: '  Family  ' });

		expect(response.status).toBe(201);
		const created = mocks.createContact.mock.calls[0][2];
		expect(created).toMatchObject({
			'@type': 'Card',
			kind: 'group',
			name: { full: 'Family' },
			addressBookIds: { 'book-1': true }
		});
		expect(created.uid).toMatch(/^urn:uuid:/);
		await expect(response.json()).resolves.toMatchObject({
			success: true,
			list: { id: 'list-1', name: 'Family', memberUids: [], addressBookIds: { 'book-1': true } }
		});
	});

	it('rejects a list with no name before any JMAP call', async () => {
		const response = await post({ action: 'createList', name: '   ' });
		expect(response.status).toBe(400);
		expect(mocks.createContact).not.toHaveBeenCalled();
	});

	it('refuses to treat a person as a list, so list actions cannot rename or delete them', async () => {
		mocks.getContacts.mockResolvedValue([{ id: 'contact-1', uid: 'urn:uuid:c1', kind: 'individual' }]);
		for (const action of ['renameList', 'deleteList', 'setListMembers']) {
			const response = await post({ action, id: 'contact-1', name: 'x', add: ['urn:uuid:z'] });
			expect(response.status).toBe(404);
		}
		expect(mocks.updateContact).not.toHaveBeenCalled();
		expect(mocks.deleteContact).not.toHaveBeenCalled();
	});

	it('sets the whole members map, so it works on a new list that has none yet', async () => {
		// A fresh list has no `members` property; a `members/<uid>` patch into
		// it is what Stalwart rejected.
		mocks.getContacts.mockResolvedValue([{ id: 'list-1', uid: 'urn:uuid:l1', kind: 'group' }]);
		mocks.updateContact.mockResolvedValue(undefined);
		const response = await post({ action: 'setListMembers', id: 'list-1', add: ['urn:uuid:a', 'urn:uuid:a'] });

		expect(response.status).toBe(200);
		expect(mocks.updateContact).toHaveBeenCalledWith({ client: true }, 'contacts-account', 'list-1', {
			members: { 'urn:uuid:a': true }
		});
	});

	it('keeps existing members when adding, and clears the map when the last one leaves', async () => {
		mocks.updateContact.mockResolvedValue(undefined);
		mocks.getContacts.mockResolvedValue([{
			id: 'list-1', uid: 'urn:uuid:l1', kind: 'group', members: { 'urn:uuid:a': true, 'urn:uuid:b': true }
		}]);
		await post({ action: 'setListMembers', id: 'list-1', add: ['urn:uuid:c'], remove: ['urn:uuid:b'] });
		expect(mocks.updateContact).toHaveBeenLastCalledWith({ client: true }, 'contacts-account', 'list-1', {
			members: { 'urn:uuid:a': true, 'urn:uuid:c': true }
		});

		mocks.getContacts.mockResolvedValue([{
			id: 'list-1', uid: 'urn:uuid:l1', kind: 'group', members: { 'urn:uuid:a': true }
		}]);
		await post({ action: 'setListMembers', id: 'list-1', remove: ['urn:uuid:a'] });
		expect(mocks.updateContact).toHaveBeenLastCalledWith({ client: true }, 'contacts-account', 'list-1', {
			members: null
		});
	});

	it('renames a list by replacing its name, and deletes only the list card', async () => {
		mocks.getContacts.mockResolvedValue([{ id: 'list-1', uid: 'urn:uuid:l1', kind: 'group' }]);
		mocks.updateContact.mockResolvedValue(undefined);
		mocks.deleteContact.mockResolvedValue(undefined);

		expect((await post({ action: 'renameList', id: 'list-1', name: 'Close family' })).status).toBe(200);
		expect(mocks.updateContact).toHaveBeenCalledWith({ client: true }, 'contacts-account', 'list-1', {
			name: { full: 'Close family' }
		});

		expect((await post({ action: 'deleteList', id: 'list-1' })).status).toBe(200);
		expect(mocks.deleteContact).toHaveBeenCalledWith({ client: true }, 'contacts-account', 'list-1');
	});
});
