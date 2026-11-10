import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// A test that reaches the database without choosing one gets a scratch
// file, never local-data/ (the developer's own data). Test files that set
// DATABASE_PATH themselves keep theirs.
process.env.DATABASE_PATH ??= join(mkdtempSync(join(tmpdir(), 'zajel-test-')), 'test.db');

// jsdom has no ResizeObserver, which Svelte's bind:clientWidth needs (the
// message list measures its row with it). Browsers all have it; component
// tests just measure nothing.
if (typeof window !== 'undefined' && !('ResizeObserver' in globalThis)) {
	globalThis.ResizeObserver = class {
		observe() {}
		unobserve() {}
		disconnect() {}
	} as unknown as typeof ResizeObserver;
}
