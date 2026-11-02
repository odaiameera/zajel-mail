import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * SvelteKit answers every POST to a page with a 500 ("When using named
 * actions, the default action cannot be used") when the page's `actions` mix
 * `default` with named actions. Tests that call an action directly never go
 * through that check, so it once broke sign-in unnoticed. This reads each
 * page's source and checks the shape of its actions instead.
 */
function actionNames(source: string): string[] | null {
	const block = source.match(/export const actions[^=]*=\s*\{([\s\S]*?)\n\};/);
	if (!block) return null;
	return [...block[1].matchAll(/^\t(\w+)\s*[:(]/gm)].map((m) => m[1]);
}

const pages = (readdirSync('src/routes', { recursive: true }) as string[])
	.filter((file) => file.endsWith('+page.server.ts'))
	.map((file) => join('src/routes', file));

describe('form actions', () => {
	it('finds the pages that have actions', () => {
		const withActions = pages.filter((file) => actionNames(readFileSync(file, 'utf8')));
		expect(withActions).toContain(join('src/routes', 'login', '+page.server.ts'));
		expect(actionNames(readFileSync(join('src/routes', 'login', '+page.server.ts'), 'utf8'))).toEqual([
			'password',
			'code',
			'cancel'
		]);
	});

	it.each(pages)('%s does not mix a default action with named ones', (file) => {
		const names = actionNames(readFileSync(file, 'utf8')) ?? [];
		expect(names.includes('default') && names.length > 1).toBe(false);
	});
});
