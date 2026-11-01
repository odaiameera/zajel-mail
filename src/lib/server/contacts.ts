import { randomUUID } from 'node:crypto';
import type { AddressBook, ContactCard, ContactCardCreate, JSContactEmail, JSContactPhone } from '../jmap/types';

const MAX_NAME_LENGTH = 255;
const MAX_EMAIL_LENGTH = 320;
const MAX_PHONE_LENGTH = 100;
const MAX_NOTES_LENGTH = 10_000;
const MAX_ENTRIES = 20;

export class ContactValidationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'ContactValidationError';
	}
}

export interface ContactFormInput {
	name?: unknown;
	emails?: unknown;
	phones?: unknown;
	organization?: unknown;
	organizationId?: unknown;
	notes?: unknown;
	noteId?: unknown;
	favorite?: unknown;
	addressBookIds?: unknown;
}

function optionalText(value: unknown, field: string, maxLength: number): string {
	if (value === undefined || value === null) return '';
	if (typeof value !== 'string') throw new ContactValidationError(`${field} must be text`);
	const text = value.trim();
	if (text.length > maxLength) {
		throw new ContactValidationError(`${field} is too long`);
	}
	return text;
}

function context(value: unknown): Record<string, boolean> | undefined {
	if (value === 'work') return { work: true };
	if (value === 'home' || value === 'private') return { private: true };
	if (value === undefined || value === null || value === '' || value === 'other') return undefined;
	throw new ContactValidationError('Contact entry type is invalid');
}

function contextType(value: Record<string, boolean> | undefined): 'work' | 'home' | 'other' {
	if (value?.work) return 'work';
	if (value?.private) return 'home';
	return 'other';
}

function entryId(value: unknown, field: string): string | undefined {
	if (value === undefined || value === null || value === '') return undefined;
	return optionalText(value, field, 255);
}

function preference(value: unknown, field: string): number | undefined {
	if (value === undefined || value === null || value === '') return undefined;
	if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 100) {
		throw new ContactValidationError(`${field} is invalid`);
	}
	return value;
}

function mergedContexts(
	existing: Record<string, boolean> | undefined,
	value: unknown
): Record<string, boolean> | undefined {
	if (existing && (value === undefined || value === null || value === '')) return existing;
	const submitted = value === 'private' ? 'home' : (value ?? 'other');
	if (existing && submitted === contextType(existing)) return existing;
	const contexts = { ...existing };
	delete contexts.work;
	delete contexts.private;
	Object.assign(contexts, context(value));
	return Object.keys(contexts).length > 0 ? contexts : undefined;
}

function nextMapId(prefix: string, used: Set<string>): string {
	let index = 1;
	while (used.has(`${prefix}${index}`)) index += 1;
	const id = `${prefix}${index}`;
	used.add(id);
	return id;
}

function parseEmails(
	value: unknown,
	existing: Record<string, JSContactEmail> | undefined = undefined
): Record<string, JSContactEmail> | undefined {
	if (value === undefined || value === null) return undefined;
	if (!Array.isArray(value)) throw new ContactValidationError('emails must be a list');
	if (value.length > MAX_ENTRIES) throw new ContactValidationError('Too many email addresses');

	const parsed: Array<[string, JSContactEmail]> = [];
	const seen = existing ? null : new Set<string>();
	const usedIds = new Set(Object.keys(existing ?? {}));
	for (const item of value) {
		if (!item || typeof item !== 'object') throw new ContactValidationError('Email entry is invalid');
		const id = entryId((item as { id?: unknown }).id, 'Email entry id');
		if (id && !existing?.[id]) throw new ContactValidationError('Email entry id is invalid');
		const raw = optionalText((item as { address?: unknown }).address, 'Email address', MAX_EMAIL_LENGTH);
		if (!raw) continue;
		const address = raw.toLowerCase();
		if (!/^[^\s@]+@[^\s@]+$/.test(address)) {
			throw new ContactValidationError(`Invalid email address: ${raw}`);
		}
		if (seen?.has(address)) continue;
		seen?.add(address);
		const previous = id ? existing?.[id] : undefined;
		const parsedEntry: JSContactEmail = { ...previous, address };
		const contexts = mergedContexts(previous?.contexts, (item as { type?: unknown }).type);
		if (contexts) parsedEntry.contexts = contexts;
		else delete parsedEntry.contexts;
		const submittedPreference = preference((item as { pref?: unknown }).pref, 'Email preference');
		if (submittedPreference !== undefined) parsedEntry.pref = submittedPreference;
		else if (!existing && parsed.length === 0) parsedEntry.pref = 1;
		parsed.push([id ?? nextMapId('email', usedIds), parsedEntry]);
	}
	if (parsed.length === 0) return undefined;
	return Object.fromEntries(parsed);
}

function parsePhones(
	value: unknown,
	existing: Record<string, JSContactPhone> | undefined = undefined
): Record<string, JSContactPhone> | undefined {
	if (value === undefined || value === null) return undefined;
	if (!Array.isArray(value)) throw new ContactValidationError('phones must be a list');
	if (value.length > MAX_ENTRIES) throw new ContactValidationError('Too many phone numbers');

	const parsed: Array<[string, JSContactPhone]> = [];
	const usedIds = new Set(Object.keys(existing ?? {}));
	for (const item of value) {
		if (!item || typeof item !== 'object') throw new ContactValidationError('Phone entry is invalid');
		const id = entryId((item as { id?: unknown }).id, 'Phone entry id');
		if (id && !existing?.[id]) throw new ContactValidationError('Phone entry id is invalid');
		const number = optionalText((item as { number?: unknown }).number, 'Phone number', MAX_PHONE_LENGTH);
		if (!number) continue;
		const previous = id ? existing?.[id] : undefined;
		const parsedEntry: JSContactPhone = { ...previous, number };
		const contexts = mergedContexts(previous?.contexts, (item as { type?: unknown }).type);
		if (contexts) parsedEntry.contexts = contexts;
		else delete parsedEntry.contexts;
		const submittedPreference = preference((item as { pref?: unknown }).pref, 'Phone preference');
		if (submittedPreference !== undefined) parsedEntry.pref = submittedPreference;
		else if (!existing && parsed.length === 0) parsedEntry.pref = 1;
		parsed.push([id ?? nextMapId('phone', usedIds), parsedEntry]);
	}
	if (parsed.length === 0) return undefined;
	return Object.fromEntries(parsed);
}

function mergeNamedEntry<T extends Record<string, unknown>>(
	existing: Record<string, T> | undefined,
	submittedId: unknown,
	text: string,
	prefix: string,
	property: string
): Record<string, T> | undefined {
	const merged = { ...existing };
	const parsedId = entryId(submittedId, `${property} entry id`);
	if (parsedId && !existing?.[parsedId]) {
		throw new ContactValidationError(`${property} entry id is invalid`);
	}
	const id = parsedId ?? Object.keys(existing ?? {})[0];
	if (!text) {
		if (id) delete merged[id];
		return Object.keys(merged).length > 0 ? merged : undefined;
	}
	const targetId = id ?? nextMapId(prefix, new Set(Object.keys(merged)));
	merged[targetId] = { ...(existing?.[targetId] ?? {} as T), [property]: text } as T;
	return merged;
}

function parseAddressBookIds(value: unknown): Record<string, boolean> {
	if (!Array.isArray(value) || value.length === 0 || value.length > MAX_ENTRIES) {
		throw new ContactValidationError('At least one address book is required');
	}
	const ids = value.map((id) => optionalText(id, 'Address book id', 255));
	if (ids.some((id) => !id)) throw new ContactValidationError('Address book id is invalid');
	return Object.fromEntries([...new Set(ids)].map((id) => [id, true]));
}

export function validateAddressBookSelection(
	addressBookIds: Record<string, boolean>,
	addressBooks: AddressBook[],
	maxAddressBooksPerCard: number | null
): void {
	const selected = Object.entries(addressBookIds)
		.filter(([, included]) => included)
		.map(([id]) => id);
	if (maxAddressBooksPerCard !== null && selected.length > maxAddressBooksPerCard) {
		throw new ContactValidationError('Too many address books selected');
	}
	const writableIds = new Set(
		addressBooks.filter((book) => book.myRights.mayWrite).map((book) => book.id)
	);
	if (selected.some((id) => !writableIds.has(id))) {
		throw new ContactValidationError('Selected address book is not writable');
	}
}

export function contactPatchFromInput(input: ContactFormInput, existing: ContactCard): Record<string, unknown> {
	if (!input || typeof input !== 'object') throw new ContactValidationError('Contact is required');

	const name = optionalText(input.name, 'Name', MAX_NAME_LENGTH);
	const emails = parseEmails(input.emails, existing.emails);
	const phones = parsePhones(input.phones, existing.phones);
	const organization = optionalText(input.organization, 'Organization', MAX_NAME_LENGTH);
	const notes = optionalText(input.notes, 'Notes', MAX_NOTES_LENGTH);
	const organizations = mergeNamedEntry(existing.organizations, input.organizationId, organization, 'org', 'name');
	const mergedNotes = mergeNamedEntry(existing.notes, input.noteId, notes, 'note', 'note');
	const mergedName = { ...(existing.name ?? {}) };
	delete mergedName.full;
	if (name) mergedName.full = name;
	const favorite = input.favorite === undefined ? false : input.favorite;
	if (typeof favorite !== 'boolean') throw new ContactValidationError('favorite must be a boolean');
	if (Object.keys(mergedName).length === 0 && !emails && !phones && !organizations) {
		throw new ContactValidationError('Enter a name, email address, phone number, or organization');
	}
	// Written whole, never as a `keywords/favorite` pointer: most cards have no
	// keywords (only vCard CATEGORIES create them), and a pointer into a
	// missing property is rejected (RFC 8620 §5.3), which failed every save.
	const keywords = { ...(existing.keywords ?? {}) };
	if (favorite) keywords.favorite = true;
	else delete keywords.favorite;

	return {
		name: Object.keys(mergedName).length > 0 ? mergedName : null,
		emails: emails ?? null,
		phones: phones ?? null,
		organizations: organizations ?? null,
		notes: mergedNotes ?? null,
		keywords: Object.keys(keywords).length > 0 ? keywords : null,
		addressBookIds: parseAddressBookIds(input.addressBookIds)
	};
}

export function contactCreateFromInput(
	input: ContactFormInput,
	uuid: () => string = randomUUID
): ContactCardCreate {
	if (!input || typeof input !== 'object') throw new ContactValidationError('Contact is required');

	const name = optionalText(input.name, 'Name', MAX_NAME_LENGTH);
	const emails = parseEmails(input.emails);
	const phones = parsePhones(input.phones);
	const organization = optionalText(input.organization, 'Organization', MAX_NAME_LENGTH);
	const notes = optionalText(input.notes, 'Notes', MAX_NOTES_LENGTH);
	const favorite = input.favorite === undefined ? false : input.favorite;
	if (typeof favorite !== 'boolean') throw new ContactValidationError('favorite must be a boolean');
	if (!name && !emails && !phones && !organization) {
		throw new ContactValidationError('Enter a name, email address, phone number, or organization');
	}

	return {
		'@type': 'Card',
		version: '1.0',
		uid: `urn:uuid:${uuid()}`,
		kind: 'individual',
		...(name && { name: { full: name } }),
		...(emails && { emails }),
		...(phones && { phones }),
		...(organization && { organizations: { org1: { name: organization } } }),
		...(notes && { notes: { note1: { note: notes } } }),
		...(favorite && { keywords: { favorite: true } }),
		addressBookIds: parseAddressBookIds(input.addressBookIds)
	};
}

// --- Contact lists -----------------------------------------------------------
// A list is a group card (see ContactList in $lib/jmap/contacts). These helpers
// validate what the client sends before any of it reaches the server.

const MAX_LIST_NAME_LENGTH = 100;
const MAX_LIST_CHANGES = 500;

export function listNameFromInput(value: unknown): string {
	const name = optionalText(value, 'List name', MAX_LIST_NAME_LENGTH);
	if (!name) throw new ContactValidationError('Enter a name for the list');
	return name;
}

/** A bounded, de-duplicated array of contact uids. */
export function uidsFromInput(value: unknown, field: string): string[] {
	if (value === undefined || value === null) return [];
	if (!Array.isArray(value) || value.length > MAX_LIST_CHANGES) {
		throw new ContactValidationError(`${field} is invalid`);
	}
	const uids = value.map((uid) => optionalText(uid, field, 255));
	if (uids.some((uid) => !uid)) throw new ContactValidationError(`${field} is invalid`);
	return [...new Set(uids)];
}

/** Where a new list goes: the default address book if writable, else the first writable one. */
export function addressBookForNewList(addressBooks: AddressBook[]): AddressBook | null {
	const writable = addressBooks.filter((book) => book.myRights.mayWrite);
	return writable.find((book) => book.isDefault) ?? writable[0] ?? null;
}

export function contactListCreate(
	name: string,
	addressBookId: string,
	uuid: () => string = randomUUID
): ContactCardCreate {
	return {
		'@type': 'Card',
		version: '1.0',
		uid: `urn:uuid:${uuid()}`,
		kind: 'group',
		name: { full: name },
		addressBookIds: { [addressBookId]: true }
	};
}
