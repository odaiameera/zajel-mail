// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/svelte';

import SearchHelp from './SearchHelp.svelte';

afterEach(cleanup);

describe('SearchHelp', () => {
	it('says that bare words also search by meaning, how results are then ordered, and what turns it off', () => {
		render(SearchHelp, { onClose: () => {} });
		expect(screen.getByText(/bare words also find mail that means the same/)).toBeTruthy();
		expect(screen.getByText(/ranked by relevance/)).toBeTruthy();
		expect(screen.getByText('body:', { selector: 'code' })).toBeTruthy();
		expect(screen.getByText(/by meaning once the index is ready/)).toBeTruthy();
	});
});
