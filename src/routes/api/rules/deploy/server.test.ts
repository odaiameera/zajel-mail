import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
	scripts: [] as { id: string; name: string; isActive: boolean }[],
	getThrows: null as Error | null,
	setResult: {} as Record<string, unknown>,
	setCalls: [] as Record<string, unknown>[]
}));

vi.mock('$lib/jmap/auth', () => ({
	createClient: () => ({
		request: async (calls: [string, Record<string, unknown>, string][]) => {
			const [name, args] = calls[0];
			if (name === 'Mailbox/get') {
				return {
					methodResponses: [['Mailbox/get', { list: [{ id: 'IN', name: 'Inbox', role: 'inbox', parentId: null }] }, '0']],
					sessionState: ''
				};
			}
			if (name === 'SieveScript/get') {
				if (state.getThrows) throw state.getThrows;
				return { methodResponses: [['SieveScript/get', { list: state.scripts }, '0']], sessionState: '' };
			}
			if (name === 'SieveScript/set') {
				state.setCalls.push(args);
				return { methodResponses: [['SieveScript/set', state.setResult, '0']], sessionState: '' };
			}
			throw new Error(`unexpected ${name}`);
		}
	})
}));
vi.mock('$lib/server/preferences', () => ({ readPreferences: () => ({}) }));

import { JMAPMethodError } from '$lib/jmap/client';
import { POST } from './+server';

async function deploy() {
	const res = await POST({
		request: new Request('http://localhost/api/rules/deploy', { method: 'POST', body: JSON.stringify({ rules: [] }) }),
		locals: {
			auth: { accountId: 'jmap', apiUrl: 'https://mail.example/jmap/', authHeader: 'Basic x' },
			user: { id: 'u1' }
		},
		cookies: {}
	} as unknown as Parameters<typeof POST>[0]);
	return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

beforeEach(() => {
	state.scripts = [];
	state.getThrows = null;
	state.setResult = {};
	state.setCalls = [];
	// The script upload.
	vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ blobId: 'B1' }), { status: 200 })));
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('deploying the Sieve script', () => {
	it('creates and activates the script; an empty refusal map is not a refusal', async () => {
		state.setResult = { created: { script1: { id: 'S1' } }, notCreated: {} };
		const { status, body } = await deploy();
		expect(status).toBe(200);
		expect(body).toMatchObject({ success: true, deactivated: null });
		expect(state.setCalls[0]).toMatchObject({
			create: { script1: { name: 'mailrules', blobId: 'B1' } },
			onSuccessActivateScript: '#script1'
		});
	});

	it('names the script that activating ours switched off', async () => {
		state.scripts = [{ id: 'S9', name: 'thunderbird-filters', isActive: true }];
		state.setResult = { created: { script1: { id: 'S1' } } };
		const { body } = await deploy();
		expect(body).toMatchObject({ success: true, deactivated: 'thunderbird-filters' });
	});

	it('reports a method-level error in the server’s words', async () => {
		state.getThrows = new JMAPMethodError('unknownMethod', 'Sieve is not enabled');
		const { status, body } = await deploy();
		expect(status).toBe(500);
		expect(body.error).toContain('Sieve is not enabled');
	});

	it('reports a refused update', async () => {
		state.scripts = [{ id: 'S1', name: 'mailrules', isActive: true }];
		state.setResult = { notUpdated: { S1: { type: 'invalidScript', description: 'line 3: unknown command' } } };
		const { status, body } = await deploy();
		expect(status).toBe(500);
		expect(body.error).toBe('line 3: unknown command');
		expect(state.setCalls[0]).toMatchObject({ update: { S1: { blobId: 'B1' } }, onSuccessActivateScript: 'S1' });
	});
});
