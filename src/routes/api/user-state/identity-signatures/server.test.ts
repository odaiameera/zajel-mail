import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ setIdentitySignature: vi.fn(), listSignatures: vi.fn() }));

vi.mock('$lib/server/db/queries/identity-signatures', () => ({
	listIdentitySignatures: () => [],
	setIdentitySignature: mocks.setIdentitySignature,
	clearIdentitySignature: vi.fn()
}));
vi.mock('$lib/server/db/queries/signatures', () => ({ listSignatures: mocks.listSignatures }));

import { PUT } from './+server';

const auth = { authHeader: `Basic ${Buffer.from('me@example.test:secret').toString('base64')}` };

function put(body: unknown) {
	return PUT({
		request: new Request('http://localhost/api/user-state/identity-signatures', { method: 'PUT', body: JSON.stringify(body) }),
		locals: { auth }
	} as unknown as Parameters<typeof PUT>[0]);
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.listSignatures.mockReturnValue([{ id: 1, name: 'Work', html: '', isDefault: true }]);
});

describe('PUT /api/user-state/identity-signatures', () => {
	it('stores one of the login’s own signatures for an address', async () => {
		expect((await put({ identityId: 'id-2', signatureId: 1 })).status).toBe(200);
		expect(mocks.listSignatures).toHaveBeenCalledWith('me@example.test');
		expect(mocks.setIdentitySignature).toHaveBeenCalledWith('me@example.test', 'id-2', 1);
	});

	it('refuses a signature that doesn’t exist (deleted while the choice waited for Save)', async () => {
		const res = await put({ identityId: 'id-2', signatureId: 2 });
		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({ error: 'That signature no longer exists.' });
		expect(mocks.setIdentitySignature).not.toHaveBeenCalled();
	});
});
