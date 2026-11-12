// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { SaveCancelled } from './draft.svelte';
import { saveEach } from './send';

const ok = (label: string, key: string) => ({ label, values: { [key]: 1 }, run: async () => {} });
const bad = (label: string, key: string, reason: string) => ({
	label,
	values: { [key]: 1 },
	run: async () => {
		throw new Error(reason);
	}
});

describe('saveEach', () => {
	it('reports each request that went through, and goes on after one that failed', async () => {
		const stored = vi.fn();
		await expect(saveEach(stored, [bad('Theme', 'theme', 'No'), ok('Density', 'density')])).rejects.toThrow(
			'Theme wasn’t saved: No'
		);
		expect(stored.mock.calls).toEqual([[{ density: 1 }]]);
	});

	it('gives the reason alone when nothing saved, for one reason', async () => {
		await expect(saveEach(vi.fn(), [bad('A', 'a', 'Offline'), bad('B', 'b', 'Offline')])).rejects.toThrow(/^Offline$/);
		await expect(saveEach(vi.fn(), [bad('A', 'a', 'Offline')])).rejects.toThrow(/^Offline$/);
	});

	it('names each failure when the reasons differ', async () => {
		await expect(saveEach(vi.fn(), [bad('A', 'a', 'One.'), bad('B', 'b', 'Two.')])).rejects.toThrow(
			'A wasn’t saved: One. B wasn’t saved: Two.'
		);
	});

	it('passes on a cancelled sign-in check as a cancel, not an error', async () => {
		const cancelled = { label: 'A', values: {}, run: async () => Promise.reject(new SaveCancelled()) };
		await expect(saveEach(vi.fn(), [cancelled])).rejects.toBeInstanceOf(SaveCancelled);
	});
});
