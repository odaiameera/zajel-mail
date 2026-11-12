import { describe, expect, it } from 'vitest';
import { isRedirect } from '@sveltejs/kit';
import { load as folders } from './folders/+page.server';
import { load as labels } from './labels/+page.server';
import { load as rules } from './rules/+page.server';
import { load as jev } from './jev/+page.server';
import { load as account } from './account/+page.server';
import { load as signatures } from './signatures/+page.server';
import { load as composer } from './composer/+page.server';
import { load as autoReply } from './auto-reply/+page.server';
import { load as search } from './search/+page.server';
import { load as agent } from './agent/+page.server';
import { load as importExport } from './import-export/+page.server';
import { load as reset } from './reset/+page.server';

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
	it('send Folders and Labels to Folders & labels, for good', async () => {
		for (const load of [folders, labels]) {
			expect(await whereTo(load as never)).toEqual({ status: 308, location: '/settings/folders-labels' });
		}
	});

	it('sends Filters & Rules to the list of all rules on Folders & labels, for good', async () => {
		expect(await whereTo(rules as never)).toEqual({ status: 308, location: '/settings/folders-labels#rules' });
	});

	it('sends Jev to Inbox tabs, for good', async () => {
		expect(await whereTo(jev as never)).toEqual({ status: 308, location: '/settings/inbox-tabs' });
	});

	it('sends the pages folded into others to where their settings are now, for good', async () => {
		const moved: [(event: never) => unknown, string][] = [
			[account as never, '/settings/accounts'],
			[signatures as never, '/settings/messages/signatures'],
			[composer as never, '/settings/messages#composer'],
			[autoReply as never, '/settings/messages/out-of-office'],
			[search as never, '/settings/assistant#search'],
			[agent as never, '/settings/assistant'],
			[importExport as never, '/settings/backup'],
			[reset as never, '/settings/backup#reset']
		];
		for (const [load, location] of moved) {
			expect(await whereTo(load)).toEqual({ status: 308, location });
		}
	});
});
