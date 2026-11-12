// @vitest-environment jsdom
// (jsdom, so the runes compile for the browser, as they run in the app.)
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Draft, SaveCancelled, SaveHost, type Persist } from './draft.svelte';

type Values = { name: string; size: number; folders: string[] };

const initial = (): Values => ({ name: 'Ada', size: 50, folders: ['a', 'b'] });

function make(persist: Persist<Values> = async () => {}, preview?: (v: Values) => void) {
	const spy = vi.fn(persist);
	return { draft: new Draft<Values>({ initial: initial(), persist: spy, preview }), persist: spy };
}

afterEach(() => vi.useRealTimers());

describe('Draft', () => {
	it('is dirty only while a value differs from what was saved', () => {
		const { draft } = make();
		expect(draft.dirty).toBe(false);

		draft.value.name = 'Grace';
		expect(draft.dirty).toBe(true);
		draft.value.name = 'Ada';
		expect(draft.dirty).toBe(false);

		draft.value.folders = ['a'];
		expect(draft.dirty).toBe(true);
		draft.value.folders = ['a', 'b'];
		expect(draft.dirty).toBe(false);
	});

	it('sends nothing until save, then only the keys that changed, with every value alongside', async () => {
		const { draft, persist } = make();
		draft.value.size = 25;
		draft.value.folders = ['a', 'b', 'c'];
		expect(persist).not.toHaveBeenCalled();

		expect(await draft.save()).toBe(true);
		expect(persist).toHaveBeenCalledTimes(1);
		expect(persist).toHaveBeenCalledWith(
			{ size: 25, folders: ['a', 'b', 'c'] },
			{ name: 'Ada', size: 25, folders: ['a', 'b', 'c'] },
			expect.any(Function)
		);
	});

	it('takes the saved values as the new baseline', async () => {
		const { draft, persist } = make();
		draft.value.name = 'Grace';
		await draft.save();
		expect(draft.dirty).toBe(false);
		expect(draft.baseline.name).toBe('Grace');

		// Saving again with nothing changed sends nothing.
		expect(await draft.save()).toBe(true);
		expect(persist).toHaveBeenCalledTimes(1);

		// The next change is measured against what was just saved.
		draft.value.size = 10;
		await draft.save();
		expect(persist).toHaveBeenLastCalledWith(
			{ size: 10 },
			{ name: 'Grace', size: 10, folders: ['a', 'b'] },
			expect.any(Function)
		);
	});

	it('shows a value the way the server stored it when persist returns one', async () => {
		const { draft } = make(async (_changed, all) => ({ name: all.name.trim() }));
		draft.value.name = '  Grace ';
		await draft.save();
		expect(draft.value.name).toBe('Grace');
		expect(draft.dirty).toBe(false);
	});

	it('keeps the changes and gives the reason when a save fails', async () => {
		let fail = true;
		const { draft } = make(async () => {
			if (fail) throw new Error('Name is too long');
		});
		draft.value.name = 'Grace';

		expect(await draft.save()).toBe(false);
		expect(draft.error).toBe('Name is too long');
		expect(draft.value.name).toBe('Grace');
		expect(draft.dirty).toBe(true);
		expect(draft.saving).toBe(false);

		// Pressing Save again tries again, and the old reason goes.
		fail = false;
		expect(await draft.save()).toBe(true);
		expect(draft.error).toBe('');
		expect(draft.dirty).toBe(false);
	});

	it('treats a cancelled save as neither saved nor failed', async () => {
		const { draft } = make(async () => {
			throw new SaveCancelled();
		});
		draft.value.name = 'Grace';
		expect(await draft.save()).toBe(false);
		expect(draft.error).toBe('');
		expect(draft.dirty).toBe(true);
	});

	it('goes back to the saved values on discard, and previews them', async () => {
		const preview = vi.fn();
		const { draft, persist } = make(async () => {}, preview);
		draft.value.name = 'Grace';
		draft.value.folders.push('c');

		draft.discard();
		expect(draft.value).toEqual(initial());
		expect(draft.dirty).toBe(false);
		expect(preview).toHaveBeenCalledWith(initial());
		expect(persist).not.toHaveBeenCalled();
	});

	it('discards back to the last save, not to what the page opened with', async () => {
		const { draft } = make();
		draft.value.name = 'Grace';
		await draft.save();
		draft.value.name = 'Edsger';
		draft.discard();
		expect(draft.value.name).toBe('Grace');
	});

	it('clears a failed save’s reason on discard', async () => {
		const { draft } = make(async () => {
			throw new Error('nope');
		});
		draft.value.name = 'Grace';
		await draft.save();
		draft.discard();
		expect(draft.error).toBe('');
	});

	it('does not share its values with the object it was made from', () => {
		const loaded = initial();
		const draft = new Draft<Values>({ initial: loaded, persist: async () => {} });
		// A reload that changes the page's data must not move the baseline...
		loaded.name = 'Reloaded';
		loaded.folders.push('z');
		expect(draft.baseline).toEqual(initial());
		expect(draft.dirty).toBe(false);
		// ...and editing the form must not either.
		draft.value.folders.push('c');
		expect(draft.baseline.folders).toEqual(['a', 'b']);
		expect(draft.dirty).toBe(true);
	});

	it('keeps what was typed while a save was on its way', async () => {
		let release!: () => void;
		const { draft } = make(() => new Promise<void>((resolve) => (release = resolve)));
		draft.value.name = 'Grace';
		const saving = draft.save();
		expect(draft.saving).toBe(true);
		// A second press while it is out does nothing.
		expect(await draft.save()).toBe(false);

		draft.value.name = 'Grace Hopper';
		release();
		await saving;
		expect(draft.baseline.name).toBe('Grace');
		expect(draft.value.name).toBe('Grace Hopper');
		expect(draft.dirty).toBe(true);
	});

	it('takes late-loaded values as saved, leaving alone a field already typed in', () => {
		const { draft } = make();
		draft.value.name = 'Grace';
		draft.seed({ name: 'Loaded', size: 100 });
		expect(draft.value).toEqual({ name: 'Grace', size: 100, folders: ['a', 'b'] });
		expect(draft.baseline).toEqual({ name: 'Loaded', size: 100, folders: ['a', 'b'] });
		expect(draft.dirty).toBe(true);
	});

	it('keeps what one request stored when a later one fails', async () => {
		const { draft } = make(async (changed, _all, stored) => {
			stored({ name: changed.name });
			throw new Error('Size wasn’t saved: no');
		});
		draft.value.name = 'Grace';
		draft.value.size = 10;
		expect(await draft.save()).toBe(false);
		expect(draft.error).toBe('Size wasn’t saved: no');
		expect(draft.baseline.name).toBe('Grace');
		expect(draft.baseline.size).toBe(50);
		expect(draft.value).toEqual({ name: 'Grace', size: 10, folders: ['a', 'b'] });
		expect(draft.dirty).toBe(true);
	});

	it('keeps a value as the page reported it stored, over what was sent', async () => {
		const { draft } = make(async (_changed, all, stored) => {
			stored({ name: all.name.trim() });
		});
		draft.value.name = ' Grace ';
		draft.value.size = 10;
		expect(await draft.save()).toBe(true);
		expect(draft.value).toEqual({ name: 'Grace', size: 10, folders: ['a', 'b'] });
		expect(draft.dirty).toBe(false);
	});

	it('won’t save values its check refuses, and says why only while they are changed', async () => {
		const persist = vi.fn(async () => {});
		const draft = new Draft<Values>({
			initial: initial(),
			persist,
			check: (v) => (v.size > 100 ? 'Too many' : '')
		});
		expect(draft.problem).toBe('');
		draft.value.size = 500;
		expect(draft.problem).toBe('Too many');
		expect(await draft.save()).toBe(false);
		expect(persist).not.toHaveBeenCalled();
		draft.value.size = 100;
		expect(draft.problem).toBe('');
		expect(await draft.save()).toBe(true);
		expect(persist).toHaveBeenCalledTimes(1);
	});

	it('takes a setting added after it opened as saved, and forgets one that is gone', () => {
		const draft = new Draft<Record<string, string>>({ initial: { a: '1' }, persist: async () => {} });
		draft.seed({ b: '2' });
		expect(draft.value).toEqual({ a: '1', b: '2' });
		expect(draft.dirty).toBe(false);

		draft.value.b = '3';
		expect(draft.dirty).toBe(true);
		draft.forget(['b']);
		expect(draft.value).toEqual({ a: '1' });
		expect(draft.baseline).toEqual({ a: '1' });
		expect(draft.dirty).toBe(false);
	});
});

describe('SaveHost', () => {
	it('shows the bar only while something is unsaved, and briefly after a save', async () => {
		vi.useFakeTimers();
		const host = new SaveHost();
		expect(host.visible).toBe(false);
		const { draft } = make();
		host.register(draft);
		// A page with settings, none of them changed: no bar.
		expect(host.visible).toBe(false);

		draft.value.size = 10;
		expect(host.visible).toBe(true);
		// Changed back by hand: nothing to save, no bar.
		draft.value.size = 50;
		expect(host.visible).toBe(false);

		draft.value.size = 10;
		await host.saveAll();
		expect(host.dirty).toBe(false);
		expect(host.visible).toBe(true);
		vi.advanceTimersByTime(2000);
		expect(host.visible).toBe(false);

		host.unregister(draft);
		expect(host.visible).toBe(false);
	});

	it('is dirty when any draft is, and saves only those', async () => {
		const host = new SaveHost();
		const one = make();
		const two = make();
		host.register(one.draft);
		host.register(two.draft);
		expect(host.dirty).toBe(false);
		// Nothing changed: nothing to do.
		expect(await host.saveAll()).toBe(false);

		two.draft.value.size = 10;
		expect(host.dirty).toBe(true);
		expect(await host.saveAll()).toBe(true);
		expect(one.persist).not.toHaveBeenCalled();
		expect(two.persist).toHaveBeenCalledTimes(1);
		expect(host.dirty).toBe(false);
	});

	it('says "saved" for two seconds after a save that worked', async () => {
		vi.useFakeTimers();
		const host = new SaveHost();
		const { draft } = make();
		host.register(draft);
		draft.value.size = 10;
		await host.saveAll();
		expect(host.justSaved).toBe(true);
		vi.advanceTimersByTime(1999);
		expect(host.justSaved).toBe(true);
		vi.advanceTimersByTime(1);
		expect(host.justSaved).toBe(false);
	});

	it('reports the reason of a failed save and does not say "saved"', async () => {
		const host = new SaveHost();
		const { draft } = make(async () => {
			throw new Error('Server said no');
		});
		host.register(draft);
		draft.value.size = 10;
		expect(await host.saveAll()).toBe(false);
		expect(host.error).toBe('Server said no');
		expect(host.justSaved).toBe(false);
		expect(host.dirty).toBe(true);

		// Putting the value back by hand leaves nothing unsaved, so no error either.
		draft.value.size = 50;
		expect(host.error).toBe('');
	});

	it('saves what it can when one of two drafts fails, and leaves only the failed one unsaved', async () => {
		const host = new SaveHost();
		const one = make();
		const two = make(async () => {
			throw new Error('Server said no');
		});
		host.register(one.draft);
		host.register(two.draft);
		one.draft.value.name = 'Grace';
		two.draft.value.size = 10;
		expect(await host.saveAll()).toBe(false);
		expect(one.draft.dirty).toBe(false);
		expect(two.draft.dirty).toBe(true);
		expect(host.error).toBe('Server said no');
		expect(host.justSaved).toBe(false);
	});

	it('won’t save while a draft’s values are refused by its check', async () => {
		const host = new SaveHost();
		const persist = vi.fn(async () => {});
		const draft = new Draft<Values>({ initial: initial(), persist, check: (v) => (v.size > 100 ? 'Too many' : '') });
		host.register(draft);
		draft.value.size = 500;
		expect(host.problem).toBe('Too many');
		expect(await host.saveAll()).toBe(false);
		expect(persist).not.toHaveBeenCalled();
	});

	it('discards every draft', () => {
		const host = new SaveHost();
		const one = make();
		const two = make();
		host.register(one.draft);
		host.register(two.draft);
		one.draft.value.name = 'x';
		two.draft.value.size = 1;
		host.discardAll();
		expect(host.dirty).toBe(false);
		expect(one.draft.value.name).toBe('Ada');
		expect(two.draft.value.size).toBe(50);
	});
});
