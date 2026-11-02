import js from '@eslint/js';
import svelte from 'eslint-plugin-svelte';
import globals from 'globals';
import ts from 'typescript-eslint';
import svelteConfig from './svelte.config.js';

/**
 * A small set: the recommended rules for JavaScript, TypeScript and Svelte.
 * svelte-check already does the type checking; this catches the rest
 * (unused code, unsafe patterns, Svelte mistakes the compiler allows).
 */
export default ts.config(
	{ ignores: ['build/', '.svelte-kit/', 'node_modules/', 'static/', 'local-data/', '.claude/'] },
	js.configs.recommended,
	...ts.configs.recommended,
	...svelte.configs.recommended,
	{
		languageOptions: { globals: { ...globals.browser, ...globals.node } },
		rules: {
			// A leading underscore marks a parameter a signature needs but the body doesn't.
			'@typescript-eslint/no-unused-vars': [
				'error',
				{ argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }
			],
			// The app has no base path; plain hrefs and goto() strings are right.
			'svelte/no-navigation-without-resolve': 'off',
			// Keys are given where row identity matters (moving, animating rows);
			// static lists rerender whole and need none.
			'svelte/require-each-key': 'off',
			// Local Maps and Sets in components are scratch values, not state.
			'svelte/prefer-svelte-reactivity': 'off',
			'svelte/prefer-writable-derived': 'off'
			// `svelte/no-at-html-tags` stays on: each {@html} carries a disable
			// comment saying where its HTML was sanitised.
		}
	},
	{
		files: ['**/*.svelte', '**/*.svelte.ts', '**/*.svelte.js'],
		languageOptions: {
			parserOptions: {
				projectService: true,
				extraFileExtensions: ['.svelte'],
				parser: ts.parser,
				svelteConfig
			}
		},
		rules: {
			// `$effect(() => { value; ... })` reads `value` to depend on it.
			'@typescript-eslint/no-unused-expressions': 'off'
		}
	}
);
