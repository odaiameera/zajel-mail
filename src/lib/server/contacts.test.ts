import { describe, expect, it } from 'vitest';
import type { ContactCard } from '$lib/jmap/types';
import {
	ContactValidationError,
	contactCreateFromInput,
	contactPatchFromInput,
	validateAddressBookSelection
} from './contacts';

describe('contactCreateFromInput', () => {
	it('normalizes a supported contact form into a valid flattened JSContact create object', () => {
		expect(
			contactCreateFromInput(
				{
					name: '  Ada Lovelace  ',
					emails: [
						{ address: ' ADA@Example.TEST ', type: 'work' },
						{ address: '', type: 'home' }
					],
					phones: [{ number: ' +353 21 555 0100 ', type: 'work' }],
					organization: '  Analytical Engine  ',
					notes: '  First programmer  ',
					favorite: true,
					addressBookIds: ['book-1']
				},
				() => 'test-uuid'
			)
		).toEqual({
			'@type': 'Card',
			version: '1.0',
			uid: 'urn:uuid:test-uuid',
			kind: 'individual',
			name: { full: 'Ada Lovelace' },
			emails: {
				email1: { address: 'ada@example.test', contexts: { work: true }, pref: 1 }
			},
			phones: {
				phone1: { number: '+353 21 555 0100', contexts: { work: true }, pref: 1 }
			},
			organizations: { org1: { name: 'Analytical Engine' } },
			notes: { note1: { note: 'First programmer' } },
			keywords: { favorite: true },
			addressBookIds: { 'book-1': true }
		});
	});

	it('rejects a malformed email instead of forwarding it to JMAP', () => {
		expect(() =>
			contactCreateFromInput(
				{ name: '', emails: [{ address: 'not-an-email' }], addressBookIds: ['book-1'] },
				() => 'test-uuid'
			)
		).toThrow(ContactValidationError);
	});

	it('preserves valid imported email and phone preferences in the JSContact create object', () => {
		const contact = contactCreateFromInput({
			name: 'Preferred Contact',
			emails: [
				{ address: 'first@example.test', type: 'work', pref: 42 },
				{ address: 'second@example.test', type: 'home', pref: 7 }
			],
			phones: [{ number: '555-0100', type: 'work', pref: 25 }],
			addressBookIds: ['book-1']
		}, () => 'test-uuid');

		expect(contact.emails).toEqual({
			email1: { address: 'first@example.test', contexts: { work: true }, pref: 42 },
			email2: { address: 'second@example.test', contexts: { private: true }, pref: 7 }
		});
		expect(contact.phones).toEqual({
			phone1: { number: '555-0100', contexts: { work: true }, pref: 25 }
		});
	});

	it('rejects preferences outside the JSContact integer range at the server boundary', () => {
		for (const pref of [0, 1.5, 101]) {
			expect(() => contactCreateFromInput({
				name: 'Invalid Preference',
				emails: [{ address: 'person@example.test', type: 'work', pref }],
				phones: [],
				addressBookIds: ['book-1']
			}, () => 'test-uuid')).toThrow(ContactValidationError);
		}
	});

	it('rejects read-only address books and the advertised per-card limit', () => {
		const writable = {
			id: 'book-1',
			name: 'Personal',
			description: null,
			sortOrder: 0,
			isDefault: true,
			isSubscribed: true,
			myRights: { mayRead: true, mayWrite: true, mayShare: false, mayDelete: false }
		};
		const readOnly = {
			...writable,
			id: 'book-2',
			name: 'Directory',
			isDefault: false,
			myRights: { ...writable.myRights, mayWrite: false }
		};

		expect(() => validateAddressBookSelection({ 'book-2': true }, [writable, readOnly], null))
			.toThrow('Selected address book is not writable');
		expect(() => validateAddressBookSelection({ 'book-1': true, 'book-2': true }, [writable, readOnly], 1))
			.toThrow('Too many address books selected');
	});
});

describe('contactPatchFromInput', () => {
	it('keeps stable duplicate entries, contexts, and preferences on an unchanged edit', () => {
		const existing: ContactCard = {
			id: 'contact-1',
			'@type': 'Card',
			version: '1.0',
			uid: 'urn:uuid:contact-1',
			addressBookIds: { 'book-1': true },
			name: { full: 'Same Contact' },
			emails: {
				work: {
					address: 'same@example.test',
					contexts: { work: true, private: true, billing: true },
					pref: 42,
					label: 'Shared address at work'
				},
				home: {
					address: 'same@example.test',
					contexts: { private: true },
					pref: 7,
					label: 'Shared address at home'
				}
			},
			phones: {
				main: {
					number: '555-0100',
					contexts: { work: true, private: true, emergency: true },
					pref: 25
				}
			}
		};

		const patch = contactPatchFromInput({
			name: 'Same Contact',
			emails: [
				{ id: 'work', address: 'same@example.test', type: 'work' },
				{ id: 'home', address: 'same@example.test', type: 'home' }
			],
			phones: [{ id: 'main', number: '555-0100', type: 'work' }],
			organization: '',
			notes: '',
			favorite: false,
			addressBookIds: ['book-1']
		}, existing);

		expect(patch.emails).toEqual(existing.emails);
		expect(patch.phones).toEqual(existing.phones);
	});

	it('treats an omitted entry type and preference as unchanged during an edit', () => {
		const existing: ContactCard = {
			id: 'contact-1',
			'@type': 'Card',
			version: '1.0',
			uid: 'urn:uuid:contact-1',
			addressBookIds: { 'book-1': true },
			emails: {
				primary: {
					address: 'person@example.test',
					contexts: { work: true, private: true, billing: true },
					pref: 42
				}
			}
		};

		const patch = contactPatchFromInput({
			name: '',
			emails: [{ id: 'primary', address: 'person@example.test' }],
			phones: [],
			organization: '',
			notes: '',
			favorite: false,
			addressBookIds: ['book-1']
		}, existing);

		expect(patch.emails).toEqual(existing.emails);
	});

	it('preserves structured and unexposed JSContact data while applying supported edits', () => {
		const existing: ContactCard = {
			id: 'contact-1',
			'@type': 'Card',
			version: '1.0',
			uid: 'urn:uuid:contact-1',
			addressBookIds: { 'book-1': true },
			name: {
				full: 'Ada Lovelace',
				components: [
					{ kind: 'given', value: 'Ada' },
					{ kind: 'surname', value: 'Lovelace' }
				],
				isOrdered: true
			},
			emails: {
				primary: {
					address: 'ada@example.test',
					contexts: { work: true, billing: true },
					pref: 1,
					label: 'Office',
					features: { messaging: true }
				},
				secondary: { address: 'home@example.test', label: 'Personal' }
			},
			phones: {
				mobile: { number: '+353 87 555 0100', label: 'Mobile', features: { mobile: true } }
			},
			organizations: {
				org1: { name: 'Analytical Engine', units: [{ name: 'Research' }] },
				org2: { name: 'Second organization', title: 'Preserve me' }
			},
			notes: {
				note1: { note: 'First programmer', author: 'CardDAV' },
				note2: { note: 'Preserve this note' }
			},
			'x-example:custom': { preserve: true }
		};

		expect(
			contactPatchFromInput({
				name: 'Ada Byron',
				emails: [
					{ id: 'primary', address: 'ada.byron@example.test', type: 'home' },
					{ id: 'secondary', address: 'home@example.test', type: 'other' }
				],
				phones: [{ id: 'mobile', number: '+353 87 555 0101', type: 'work' }],
				organization: 'Difference Engine',
				organizationId: 'org1',
				notes: 'Edited note',
				noteId: 'note1',
				favorite: false,
				addressBookIds: ['book-1']
			}, existing)
		).toEqual({
			name: {
				full: 'Ada Byron',
				components: [
					{ kind: 'given', value: 'Ada' },
					{ kind: 'surname', value: 'Lovelace' }
				],
				isOrdered: true
			},
			emails: {
				primary: {
					address: 'ada.byron@example.test',
					contexts: { billing: true, private: true },
					pref: 1,
					label: 'Office',
					features: { messaging: true }
				},
				secondary: { address: 'home@example.test', label: 'Personal' }
			},
			phones: {
				mobile: {
					number: '+353 87 555 0101',
					contexts: { work: true },
					label: 'Mobile',
					features: { mobile: true }
				}
			},
			organizations: {
				org1: { name: 'Difference Engine', units: [{ name: 'Research' }] },
				org2: { name: 'Second organization', title: 'Preserve me' }
			},
			notes: {
				note1: { note: 'Edited note', author: 'CardDAV' },
				note2: { note: 'Preserve this note' }
			},
			keywords: null,
			addressBookIds: { 'book-1': true }
		});
	});

	describe('favourite', () => {
		const card = (keywords?: Record<string, boolean>): ContactCard => ({
			id: 'contact-1',
			'@type': 'Card',
			version: '1.0',
			uid: 'urn:uuid:contact-1',
			addressBookIds: { 'book-1': true },
			name: { full: 'Dana' },
			...(keywords && { keywords })
		});
		const save = (existing: ContactCard, favorite: boolean) =>
			contactPatchFromInput(
				{ name: 'Dana', emails: [], phones: [], organization: '', notes: '', favorite, addressBookIds: ['book-1'] },
				existing
			);

		// Stalwart rejects a `keywords/favorite` pointer into a card that has no
		// keywords (invalidPatch), so keywords always go as a whole property.
		it('never patches through a keywords/ pointer', () => {
			for (const patch of [save(card(), true), save(card(), false), save(card({ favorite: true }), false)]) {
				expect(Object.keys(patch).some((key) => key.startsWith('keywords/'))).toBe(false);
			}
		});

		it('adds and removes the favourite and keeps other categories', () => {
			expect(save(card(), true).keywords).toEqual({ favorite: true });
			expect(save(card(), false).keywords).toBeNull();
			expect(save(card({ work: true }), true).keywords).toEqual({ work: true, favorite: true });
			expect(save(card({ work: true, favorite: true }), false).keywords).toEqual({ work: true });
			expect(save(card({ favorite: true }), false).keywords).toBeNull();
		});
	});
});
