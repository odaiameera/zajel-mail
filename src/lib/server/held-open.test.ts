import { describe, expect, it } from 'vitest';
import { heldOpen } from './held-open';

describe('heldOpen', () => {
	it('starts the reply at once and ends it with the JSON', async () => {
		let finish!: (payload: Record<string, unknown>) => void;
		const response = heldOpen(new Promise((resolve) => (finish = resolve)), 5);
		expect(response.status).toBe(200);
		expect(response.headers.get('content-type')).toBe('application/json');

		const reader = response.body!.getReader();
		const first = await reader.read();
		expect(new TextDecoder().decode(first.value)).toBe(' ');

		// A few heartbeats go out while the work runs.
		await new Promise((resolve) => setTimeout(resolve, 30));
		finish({ message: 'Done' });
		let text = ' ';
		for (;;) {
			const chunk = await reader.read();
			if (chunk.done) break;
			text += new TextDecoder().decode(chunk.value);
		}
		expect(text.trim()).toBe('{"message":"Done"}');
		expect(text.length).toBeGreaterThan('{"message":"Done"}'.length + 1);
		expect(JSON.parse(text)).toEqual({ message: 'Done' });
	});

	it('parses with Response.json(), as the panel reads it', async () => {
		const response = heldOpen(Promise.resolve({ error: 'The assistant took too long to respond' }));
		expect(await response.json()).toEqual({ error: 'The assistant took too long to respond' });
	});
});
