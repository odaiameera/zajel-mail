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
	it('adds an event with nobody else on it straight away, in the default calendar and the user’s zone', async () => {
		const result = await tool('create_event').run(ctx(), event());
		expect(result.done).toBe('Added “Dentist” to Personal, 2026-11-03 10:00–11:00 (Asia/Amman)');
		expect(mocks.createEvent).toHaveBeenCalledWith(
			{ accountId: 'jmap' },
			'me@example.test',
			expect.objectContaining({ calendarId: 'default', start: '2026-11-03T10:00', timeZone: 'Asia/Amman', attendees: [] }),
			'Me'
		);
	});

	it('waits for a click before anyone is invited, then adds it and lets the server invite', async () => {
		const result = await tool('create_event').run(ctx(), event({ attendees: ['Dana@Example.test', 'me@example.test'] }));
		expect(mocks.createEvent).not.toHaveBeenCalled();
		expect(result.pending?.payload).toMatchObject({ attendees: ['dana@example.test'], title: 'Dentist' });
		expect(pendingView(result.pending!)).toMatchObject({
			label: 'Send invitations',
			lines: ['2026-11-03 10:00–11:00 (Asia/Amman)', 'Invite dana@example.test'],
			confirmLabel: 'Add and invite'
		});

		expect((await decidePendingAction('user-1', result.pending!.id, 'confirm')).status).toBe(200);
		expect(mocks.createEvent).toHaveBeenCalledWith(
			{ accountId: 'jmap' },
			'me@example.test',
			expect.objectContaining({ attendees: [{ email: 'dana@example.test' }] }),
			'Me'
		);
	});

	it('refuses invitations from a run the user is not in', async () => {
		const result = await tool('create_event').run(ctx('job'), event({ attendees: ['dana@example.test'] }));
		expect(result.isError).toBe(true);
		expect(result.pending).toBeUndefined();
		expect(mocks.createEvent).not.toHaveBeenCalled();
	});

	it('checks times and addresses', async () => {
		expect((await tool('create_event').run(ctx(), event({ start: 'tomorrow 10am' }))).isError).toBe(true);
		expect((await tool('create_event').run(ctx(), event({ end: '2026-11-03T09:00' }))).isError).toBe(true);
		expect((await tool('create_event').run(ctx(), event({ attendees: ['not-an-address'] }))).isError).toBe(true);
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
