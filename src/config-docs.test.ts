import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The README's Configuration table, `.env.example` and the variables the
 * code reads must name the same set, so a new variable can't ship
 * undocumented and a retired one can't linger in the docs.
 */

const root = join(import.meta.dirname, '..');

/** Read by SvelteKit's Node adapter, not by anything under src/. */
const ADAPTER_VARS = ['ADDRESS_HEADER', 'XFF_DEPTH', 'PORT', 'BODY_SIZE_LIMIT'];

function sourceFiles(dir: string): string[] {
	return readdirSync(dir).flatMap((name) => {
		const path = join(dir, name);
		if (statSync(path).isDirectory()) return sourceFiles(path);
		return /\.(ts|js|svelte)$/.test(name) && !/\.test\.ts$/.test(name) && !path.includes('__fixtures__') ? [path] : [];
	});
}

function varsInCode(): Set<string> {
	const found = new Set<string>();
	for (const file of sourceFiles(join(root, 'src'))) {
		for (const m of readFileSync(file, 'utf8').matchAll(/\benv\.([A-Z][A-Z0-9_]*)\b/g)) found.add(m[1]);
	}
	return found;
}

function varsInReadmeTable(): Set<string> {
	const readme = readFileSync(join(root, 'README.md'), 'utf8');
	const after = readme.split('## Configuration')[1];
	if (after === undefined) throw new Error('README.md has no "## Configuration" section');
	const section = after.split('\n---')[0];
	const found = new Set<string>();
	for (const line of section.split('\n')) {
		if (!line.startsWith('| `')) continue;
		const first = line.split('|')[1];
		for (const m of first.matchAll(/`([A-Z][A-Z0-9_]*)`/g)) found.add(m[1]);
	}
	return found;
}

function varsInEnvExample(): Set<string> {
	const text = readFileSync(join(root, '.env.example'), 'utf8');
	return new Set([...text.matchAll(/^#?\s?([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1]));
}

const sorted = (s: Set<string>) => [...s].sort();

describe('configuration docs', () => {
	it('the README table lists exactly the variables the app reads', () => {
		expect(sorted(varsInReadmeTable())).toEqual(sorted(new Set([...varsInCode(), ...ADAPTER_VARS])));
	});

	it('.env.example has every variable in the README table', () => {
		expect(sorted(varsInEnvExample())).toEqual(sorted(varsInReadmeTable()));
	});
});
