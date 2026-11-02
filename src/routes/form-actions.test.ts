import { describe, expect, it } from 'vitest';

/**
 * SvelteKit answers every POST to a page with a 500 ("When using named
 * actions, the default action cannot be used") when the page's `actions` mix
 * `default` with named actions. Tests that call an action directly never go
 * through that check, so it once broke sign-in unnoticed. This loads each
 * page's server module and checks the shape of its exported `actions`.
 */
const modules = import.meta.glob<{ actions?: Record<string, unknown> }>('./**/+page.server.ts');
const pages = Object.keys(modules).sort();

async function actionNames(file: string): Promise<string[] | null> {
	const mod = await modules[file]();
	return mod.actions ? Object.keys(mod.actions) : null;
}

describe('form actions', () => {
	it('finds the pages that have actions', async () => {
		expect(pages.length).toBeGreaterThan(0);
		expect(await actionNames('./login/+page.server.ts')).toEqual(['password', 'code', 'cancel']);
	});

	it.each(pages)('%s does not mix a default action with named ones', async (file) => {
		const names = (await actionNames(file)) ?? [];
		expect(names.includes('default') && names.length > 1).toBe(false);
	});
});
