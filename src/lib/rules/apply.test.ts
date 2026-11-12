import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyEvent, IDLE_PROGRESS, streamApply, type ApplyProgress } from './apply';

afterEach(() => vi.unstubAllGlobals());

describe('streamApply', () => {
	it('applies the saved rule by its id and follows the stream to the end', async () => {
		const fetch = vi.fn(
			async () =>
				new Response(
					'data: {"type":"start","total":10}\n\n' +
						'data: {"type":"progress","scanned":5,"matched":2,"applied":2}\n\n' +
						'data: not json\n\n' +
						'data: {"type":"done","scanned":10,"matched":3,"applied":3,"failed":0}\n\n'
				)
		);
		vi.stubGlobal('fetch', fetch);
		const seen: ApplyProgress[] = [];
		await streamApply('r~2', (p) => seen.push(p));
		expect(fetch).toHaveBeenCalledWith('/api/rules/apply', expect.objectContaining({ method: 'POST', body: '{"ruleIds":["r~2"]}' }));
		expect(seen[0].status).toBe('running');
		expect(seen.at(-1)).toEqual({ status: 'done', scanned: 10, matched: 3, applied: 3, total: 10, error: undefined });
	});

	it('says how many updates the mail server rejected', () => {
		const p = applyEvent({ ...IDLE_PROGRESS, status: 'running' }, { type: 'done', scanned: 4, matched: 4, applied: 2, failed: 2, failedReason: 'over quota' });
		expect(p).toMatchObject({ status: 'error', error: 'The mail server rejected 2 updates — over quota.' });
	});

	it('reports a refused request, and ends quietly when cancelled', async () => {
		vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 500 })));
		const seen: ApplyProgress[] = [];
		await streamApply('r', (p) => seen.push(p));
		expect(seen.at(-1)).toMatchObject({ status: 'error', error: 'HTTP 500' });

		vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
		const cancelled: ApplyProgress[] = [];
		await streamApply('r', (p) => cancelled.push(p));
		expect(cancelled.map((p) => p.status)).toEqual(['running']);
	});
});
