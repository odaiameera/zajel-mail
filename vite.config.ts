// eslint-disable-next-line @typescript-eslint/triple-slash-reference -- how Vitest types the `test` block
/// <reference types="vitest/config" />
import { svelteTesting } from '@testing-library/svelte/vite';
import tailwindcss from '@tailwindcss/vite';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';
import { configDefaults } from 'vitest/config';

export default defineConfig({
	plugins: [tailwindcss(), sveltekit(), svelteTesting()],
	// better-sqlite3 ships a native binary; Vite must not try to optimise
	// or bundle it. SvelteKit's adapter-node leaves it external at build
	// time, but the dev server also needs it kept out of the optimiser.
	optimizeDeps: { exclude: ['better-sqlite3'] },
	ssr: { external: ['better-sqlite3'] },
	test: {
		setupFiles: ['src/test-setup.ts'],
		// Other sessions' git worktrees live under .claude/ and carry their own copies of the tests.
		exclude: [...configDefaults.exclude, '.claude/**']
	}
});
