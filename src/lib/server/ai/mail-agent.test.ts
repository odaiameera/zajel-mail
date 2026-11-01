import { describe, expect, it, vi } from 'vitest';

vi.mock('$env/dynamic/private', () => ({ env: {} }));
vi.mock('$lib/jmap/auth', () => ({ createClient: vi.fn() }));
vi.mock('$lib/jmap/email', () => ({ getEmailDetail: vi.fn() }));
vi.mock('$lib/jmap/mailbox', () => ({ getMailboxes: vi.fn() }));
vi.mock('$lib/server/calendar/service', () => ({ getEventsInRange: vi.fn() }));
vi.mock('./mail-assistant', () => ({ runAIChat: vi.fn() }));

import type { AuthState } from '$lib/jmap/types';
import { runAIChat } from './mail-assistant';
import { inferMailAgentAction, runMailAgent } from './mail-agent';

describe('inferMailAgentAction', () => {
	it('routes natural mailbox and calendar requests to real context tools', () => {
		expect(inferMailAgentAction('chat', "What's important in today's email?", false)).toBe(
			'summarize_today'
		);
		expect(inferMailAgentAction('chat', 'What meetings do I have tomorrow?', false)).toBe(
			'calendar_tomorrow'
		);
	});

	it('turns task language into a proposal, never direct creation', () => {
		expect(inferMailAgentAction('chat', 'Turn this into a task for Friday', true)).toBe(
			'propose_task'
		);
	});

	it('uses the current email only when one is actually open', () => {
		expect(inferMailAgentAction('chat', 'Summarize this email', true)).toBe(
			'summarize_current'
		);
		expect(inferMailAgentAction('chat', 'Summarize this email', false)).toBe('chat');
	});
});

describe("today's date in the prompts", () => {
	const DAY_MS = 86_400_000;

	// What the rail sends for 1 November 2026 in Amman (UTC+3): local
	// midnight, serialised to UTC, which is still 31 October.
	function ammanInput(message: string) {
		const todayStartMs = Date.parse('2026-10-31T21:00:00Z');
		return {
			action: 'chat' as const,
			message,
			conversation: [],
			currentEmailId: null,
			timeZone: 'Asia/Amman',
			todayStartMs,
			todayEndMs: todayStartMs + DAY_MS,
			tomorrowStartMs: todayStartMs + DAY_MS,
			tomorrowEndMs: todayStartMs + 2 * DAY_MS
		};
	}

	function systemPrompts(): string[] {
		return vi.mocked(runAIChat).mock.calls.map(([options]) => options.system ?? '');
	}

	it('gives the retrieval loop the local date, not the UTC one', async () => {
		vi.mocked(runAIChat).mockReset().mockResolvedValue('{"tool":"done"}');
		await runMailAgent({ accountId: 'a' } as AuthState, 'me@example.com', ammanInput('Who wrote to me?'));
		expect(systemPrompts()[0]).toContain('Today is 2026-11-01 (Sunday) in timezone Asia/Amman.');
	});

	it('gives the event proposal the local date, not the UTC one', async () => {
		vi.mocked(runAIChat).mockReset().mockResolvedValue('{"tool":"done"}');
		await runMailAgent(
			{ accountId: 'a' } as AuthState,
			'me@example.com',
			ammanInput('Schedule a dentist appointment tomorrow at 10')
		);
		expect(systemPrompts().at(-1)).toContain('Today is 2026-11-01 (Sunday).');
	});
});
