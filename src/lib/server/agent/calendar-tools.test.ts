import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

process.env.DATABASE_PATH = join(mkdtempSync(join(tmpdir(), 'ameera-cal-tools-')), 'test.db');

const mocks = vi.hoisted(() => ({
	createEvent: vi.fn(async () => ({ id: 'ev-new' })),
	deleteEvent: vi.fn(),
	getEventSummary: vi.fn()
}));
vi.mock('$lib/server/calendar/service', () => ({
	createEvent: mocks.createEvent,
	deleteEvent: mocks.deleteEvent,
	getEventSummary: mocks.getEventSummary,
	getEventsInRange: vi.fn(),
	listCalendarsWithMeta: async () => [
		{ id: 'work', name: 'Work', isDefault: false },
		{ id: 'default', name: 'Personal', isDefault: true }
	]
}));
vi.mock('$lib/server/db/queries/app-prefs', () => ({ getDisplayName: () => 'Me' }));
vi.mock('$lib/server/auth/accounts', () => ({
	getAccount: (id: string) => ({ id, user_id: 'user-1', email: 'me@example.test' }),
	authStateForAccount: () => ({ accountId: 'jmap' })
}));
vi.mock('./compose', () => ({ sendComposed: vi.fn() }));

import { getDb } from '../db/index';
import { runMigrations } from '../db/migrate';
import { CALENDAR_TOOLS } from './calendar-tools';
import { decidePendingAction, pendingView } from './actions';
import type { ToolContext } from './tools';
import type { AuthState } from '$lib/jmap/types';

const tool = (name: string) => CALENDAR_TOOLS.find((t) => t.name === name)!;
const ctx = (source: ToolContext['source'] = 'chat'): ToolContext => ({
	auth: { accountId: 'jmap' } as AuthState,
	client: {} as ToolContext['client'],
	userId: 'user-1',
	userEmail: 'me@example.test',
	accountRowId: 'acct-1',
	conversationId: null,
	source,
	timeZone: 'Asia/Amman',
	mailboxes: async () => []
});
const event = (extra: Record<string, unknown> = {}) => ({
	title: 'Dentist',
	start: '2026-11-03T10:00',
	end: '2026-11-03T11:00',
	all_day: false,
	location: null,
	description: null,
	attendees: [],
	calendar_id: null,
	...extra
});

beforeAll(() => {
	runMigrations();
	getDb().prepare(`INSERT INTO app_user (id, email, password_hash) VALUES ('user-1', 'u@example.test', 'x')`).run();
	getDb()
		.prepare(
			`INSERT INTO mail_accounts (id, user_id, email, server_url, jmap_account_id, secret_enc)
			 VALUES ('acct-1', 'user-1', 'me@example.test', 'https://mail.example', 'jmap', 'x')`
		)
		.run();
});

beforeEach(() => {
	vi.clearAllMocks();
	getDb().prepare('DELETE FROM agent_actions').run();
});

describe('create_event', () => {
	it('writes nothing until the user clicks, even with nobody else on it; then adds it in the default calendar and the user’s zone', async () => {
		expect(tool('create_event').tier).toBe('outward');
		const result = await tool('create_event').run(ctx(), event({ description: 'Bring the forms' }));
		expect(mocks.createEvent).not.toHaveBeenCalled();
		expect(result.done).toBeUndefined();
		expect(result.content).toContain('Nothing is in the calendar yet');
		expect(pendingView(result.pending!)).toMatchObject({
			label: 'Add event',
			title: 'Dentist',
			lines: ['2026-11-03 10:00–11:00 (Asia/Amman)', 'In Personal'],
			body: 'Bring the forms',
			confirmLabel: 'Add to calendar'
		});

		expect(await decidePendingAction('user-1', result.pending!.id, 'confirm')).toEqual({ status: 200, message: 'Added “Dentist” to Personal' });
		expect(mocks.createEvent).toHaveBeenCalledWith(
			{ accountId: 'jmap' },
			'me@example.test',
			expect.objectContaining({ calendarId: 'default', start: '2026-11-03T10:00', timeZone: 'Asia/Amman', description: 'Bring the forms', attendees: [] }),
			'Me'
		);
	});

	it('shows every invitee and the whole description before anyone is invited, then adds it and lets the server invite', async () => {
		const description = 'Agenda: <b>cleaning</b> & X-rays. '.repeat(40);
		const result = await tool('create_event').run(
			ctx(),
			event({ attendees: ['Dana@Example.test', 'omar@example.test', 'me@example.test'], description, location: 'Room 2' })
		);
		expect(mocks.createEvent).not.toHaveBeenCalled();
		const card = pendingView(result.pending!);
		expect(card).toMatchObject({
			label: 'Send invitations',
			lines: ['2026-11-03 10:00–11:00 (Asia/Amman)', 'In Personal', 'Room 2', 'Invite dana@example.test, omar@example.test'],
			confirmLabel: 'Add and invite'
		});
		// Cut to fit the card, with an ellipsis; the cut text is what is sent.
		expect(card.body!.length).toBeLessThanOrEqual(1000);
		expect(card.body!.endsWith('…')).toBe(true);
		expect(card.body).toBe(result.pending!.payload.description);

		expect((await decidePendingAction('user-1', result.pending!.id, 'confirm')).message).toBe(
			'Added “Dentist” and invited dana@example.test, omar@example.test'
		);
		expect(mocks.createEvent).toHaveBeenCalledWith(
			{ accountId: 'jmap' },
			'me@example.test',
			expect.objectContaining({ description: card.body, attendees: [{ email: 'dana@example.test' }, { email: 'omar@example.test' }] }),
			'Me'
		);
	});

	it('checks times and addresses', async () => {
		expect((await tool('create_event').run(ctx(), event({ start: 'tomorrow 10am' }))).isError).toBe(true);
		expect((await tool('create_event').run(ctx(), event({ end: '2026-11-03T09:00' }))).isError).toBe(true);
		expect((await tool('create_event').run(ctx(), event({ attendees: ['not-an-address'] }))).isError).toBe(true);
	});

	it('refuses a date or time that doesn’t exist, naming it, instead of rolling it over', async () => {
		for (const start of ['2026-11-31T09:00', '2026-13-05T09:00', '2027-02-29T09:00', '2026-11-03T24:00', '2026-11-03T09:60']) {
			const result = await tool('create_event').run(ctx(), event({ start, end: '2027-12-31T23:59' }));
			expect(result.isError, start).toBe(true);
			expect(result.content).toContain(start);
		}
		expect((await tool('create_event').run(ctx(), event({ all_day: true, start: '2026-02-30', end: '2026-03-01' }))).content).toContain('2026-02-30');
		// A leap day is real.
		expect((await tool('create_event').run(ctx(), event({ all_day: true, start: '2028-02-29', end: '2028-03-01' }))).pending).toBeDefined();
		expect(mocks.createEvent).not.toHaveBeenCalled();
	});
});

describe('delete_event', () => {
	it('shows what the server says the event is, and deletes only the chosen occurrence', async () => {
		mocks.getEventSummary.mockResolvedValue({ title: 'Standup', when: '2026-11-04 09:00 (Asia/Amman)', recurring: true });
		const result = await tool('delete_event').run(ctx(), { event_id: 'ev-1', occurrence: '20261104T090000' });
		expect(mocks.deleteEvent).not.toHaveBeenCalled();
		expect(pendingView(result.pending!)).toMatchObject({
			label: 'Delete event',
			title: 'Standup',
			lines: ['2026-11-04 09:00 (Asia/Amman)', 'This occurrence only'],
			danger: true
		});

		await decidePendingAction('user-1', result.pending!.id, 'confirm');
		expect(mocks.deleteEvent).toHaveBeenCalledWith({ accountId: 'jmap' }, 'me@example.test', 'ev-1', 'instance', '20261104T090000');
	});

	it('refuses an event that does not exist', async () => {
		mocks.getEventSummary.mockResolvedValue(null);
		expect((await tool('delete_event').run(ctx(), { event_id: 'nope', occurrence: null })).isError).toBe(true);
	});
});
