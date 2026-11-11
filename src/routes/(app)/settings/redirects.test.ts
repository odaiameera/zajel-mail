import { describe, expect, it } from 'vitest';
import { isRedirect } from '@sveltejs/kit';
import { load as folders } from './folders/+page.server';
import { load as labels } from './labels/+page.server';
import { load as rules } from './rules/+page.server';
import { load as jev } from './jev/+page.server';

/** Where a settings page that moved sends its old address, and how. */
async function whereTo(load: (event: never) => unknown): Promise<{ status: number; location: string }> {
	try {
		await load({} as never);
	} catch (thrown) {
		if (isRedirect(thrown)) return { status: thrown.status, location: thrown.location };
		throw thrown;
	}
	throw new Error('no redirect');
}

describe('settings pages that moved', () => {
	it('send Folders, Labels and Filters & Rules to Folders & labels, for good', async () => {
		for (const load of [folders, labels, rules]) {
			expect(await whereTo(load as never)).toEqual({ status: 308, location: '/settings/folders-labels' });
		}
	});

	it('sends Jev to Inbox tabs, for good', async () => {
		expect(await whereTo(jev as never)).toEqual({ status: 308, location: '/settings/inbox-tabs' });
	});
});
