import { afterEach, describe, expect, it, vi } from 'vitest';

// Both providers configured: OpenAI's key wins.
vi.mock('$env/dynamic/private', () => ({
	env: {
		OPENAI_API_KEY: 'test-openai-key',
		OLLAMA_URL: 'https://ai.example.test',
		OLLAMA_MODEL: 'test-model'
	}
}));

import { aiModel, aiProvider, MailAssistantError, runAIChat } from './mail-assistant';

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

function openAIResponse(text: string): Response {
	return new Response(
		JSON.stringify({
			output: [
				{ type: 'reasoning', summary: [] },
				{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }
			]
		}),
		{ status: 200, headers: { 'Content-Type': 'application/json' } }
	);
}

describe('runAIChat with OpenAI', () => {
	it('prefers OpenAI and defaults to GPT-5.6 Terra', () => {
		expect(aiProvider()).toBe('openai');
		expect(aiModel()).toBe('gpt-5.6-terra');
	});

	it('sends a Responses API request and returns the message text', async () => {
		const fetchMock = vi.fn().mockResolvedValue(openAIResponse('  Two new messages today.  '));
		vi.stubGlobal('fetch', fetchMock);

		await expect(
			runAIChat({
				system: 'You are Zajel.',
				messages: [
					{ role: 'user', content: 'Anything new?' },
					{ role: 'assistant', content: 'Let me look.' },
					{ role: 'user', content: 'Thanks' }
				],
				temperature: 0.2
			})
		).resolves.toBe('Two new messages today.');

		const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(url).toBe('https://api.openai.com/v1/responses');
		expect((init.headers as Record<string, string>).Authorization).toBe('Bearer test-openai-key');
		const body = JSON.parse(String(init.body));
		expect(body).toMatchObject({
			model: 'gpt-5.6-terra',
			instructions: 'You are Zajel.',
			store: false,
			reasoning: { effort: 'low' }
		});
		expect(body.input).toHaveLength(3);
		expect(body.input[1]).toEqual({ role: 'assistant', content: 'Let me look.' });
		// GPT-5.6 takes no temperature, and Ollama's fields don't belong here.
		expect(body).not.toHaveProperty('temperature');
		expect(body).not.toHaveProperty('options');
		expect(body).not.toHaveProperty('messages');
	});

	it('asks for JSON through text.format', async () => {
		const fetchMock = vi.fn().mockResolvedValue(openAIResponse('{"tool":"done"}'));
		vi.stubGlobal('fetch', fetchMock);
		const schema = { type: 'object', properties: { tool: { type: 'string' } }, required: ['tool'] };

		await runAIChat({ system: 's', messages: [{ role: 'user', content: 'u' }], format: schema });

		const body = JSON.parse(String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body));
		expect(body.text.format).toEqual({ type: 'json_schema', name: 'answer', schema, strict: false });
	});

	it('points to Settings for an unknown model and skips Ollama tag listing', async () => {
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		const fetchMock = vi.fn().mockResolvedValue(new Response('{"error":{}}', { status: 404 }));
		vi.stubGlobal('fetch', fetchMock);

		const error = await runAIChat({ system: 's', messages: [{ role: 'user', content: 'u' }] }).catch(
			(caught) => caught
		);
		expect(error).toBeInstanceOf(MailAssistantError);
		expect(error.message).toContain('choose another in Settings → Assistant');
		expect(fetchMock).toHaveBeenCalledOnce();
	});
});
