// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';

import AIAssistantRail from './AIAssistantRail.svelte';

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
	new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });

const card = {
	id: 'action-1',
	kind: 'send_email',
	label: 'Send email',
	title: 'Re: Lunch?',
	lines: ['To dana@example.test'],
	body: 'Thursday works.',
	confirmLabel: 'Send',
	danger: false
};

const session = (running: boolean, messages: { role: 'user' | 'assistant'; content: string }[]) => ({
	id: 's1',
	messages: messages.map((m, i) => ({ id: String(i + 1), ...m, html: '', createdAt: 0 })),
	pending: running ? [] : [card],
	running
});

/** A held-open reply whose body is cut off after the heartbeat, as a dropped connection leaves it. */
function cutOff(headers: Record<string, string>): Response {
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(new TextEncoder().encode(' '));
			controller.error(new TypeError('network error'));
		}
	});
	return new Response(body, { status: 200, headers: { 'Content-Type': 'application/json', ...headers } });
}

const fetchMock = vi.fn();
const props = { open: true, aiEnabled: true, onClose: () => {} };

beforeEach(() => {
	vi.stubGlobal('fetch', fetchMock);
	Element.prototype.scrollTo = vi.fn();
});

afterEach(() => {
	cleanup();
	fetchMock.mockReset();
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

async function send(text: string) {
	const field = screen.getByLabelText('Message Zajel');
	await fireEvent.input(field, { target: { value: text } });
	await fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
}

describe('the cards a session still has', () => {
	it('shows them when the session is opened from History', async () => {
		fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url === '/api/ai/conversations') {
				return json({ conversations: [{ id: 's1', title: 'Tell Dana', createdAt: 0, updatedAt: Date.now(), messageCount: 2 }], retentionDays: 7 });
			}
			if (url === '/api/ai/conversations/s1') {
				return json(session(false, [{ role: 'user', content: 'Tell Dana Thursday works' }, { role: 'assistant', content: 'It is waiting for you.' }]));
			}
			throw new Error(`unexpected ${url}`);
		});
		render(AIAssistantRail, props);
		await fireEvent.click(screen.getByRole('button', { name: 'Conversation history' }));
		await fireEvent.click(await screen.findByText('Tell Dana'));

		expect(await screen.findByText('It is waiting for you.')).toBeTruthy();
		expect(screen.getByText('Re: Lunch?')).toBeTruthy();
		expect(screen.getByRole('button', { name: 'Send' })).toBeTruthy();
	});

	it('waits out a turn whose reply was cut off, then shows its reply and card', async () => {
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
		const prompt = 'Tell Dana Thursday works';
		let polls = 0;
		fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url === '/api/ai/conversations') return json({ conversations: [], retentionDays: 7 });
			if (url === '/api/ai/agent') return cutOff({ 'X-Conversation-Id': 's1' });
			if (url === '/api/ai/conversations/s1') {
				polls += 1;
				// Still running at the first look, saved at the second.
				return json(
					polls === 1
						? session(true, [])
						: session(false, [{ role: 'user', content: prompt }, { role: 'assistant', content: 'The reply is waiting for you.' }])
				);
			}
			throw new Error(`unexpected ${url}`);
		});
		render(AIAssistantRail, props);
		await send(prompt);

		for (let i = 0; i < 6 && polls < 2; i += 1) await vi.advanceTimersByTimeAsync(4_000);
		expect(await screen.findByText('The reply is waiting for you.')).toBeTruthy();
		expect(screen.getByRole('button', { name: 'Send' })).toBeTruthy();
		expect(screen.queryByText('The connection dropped before the reply arrived')).toBeNull();
		expect(polls).toBe(2);
	});

	it('says the reply was lost when the request never got through', async () => {
		fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url === '/api/ai/conversations') return json({ conversations: [], retentionDays: 7 });
			throw new TypeError('Failed to fetch');
		});
		render(AIAssistantRail, props);
		await send('Archive the receipts');

		await waitFor(() => expect(screen.getByText('The connection dropped before the reply arrived')).toBeTruthy());
		// A new chat with no session yet has nothing to wait for.
		expect(fetchMock.mock.calls.map(([url]) => String(url))).not.toContain('/api/ai/conversations/s1');
	});
});
