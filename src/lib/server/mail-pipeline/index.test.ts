import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthState } from '$lib/jmap/types';

// The pass itself and everything the pipeline starts are stand-ins here:
// what is tested is how passes are asked for and started.
const fakes = vi.hoisted(() => ({
	schedule: (() => {}) as (...args: unknown[]) => void,
	passes: [] as { account: string; opts: { fromStream?: boolean } }[],
	release: [] as (() => void)[]
}));
vi.mock('node-cron', () => ({ default: { schedule: (...args: unknown[]) => fakes.schedule(...args) } }));
vi.mock('./pass', () => ({
	runPass: (account: string, _auth: AuthState, opts: { fromStream?: boolean } = {}) => {
		fakes.passes.push({ account, opts });
		return new Promise<void>((resolve) => fakes.release.push(resolve));
	}
}));
vi.mock('./stream', () => ({ startStreams: () => {}, refreshStreams: () => {} }));
vi.mock('./arrivals', () => ({ pruneArrivals: () => 0, keepHoldInStep: () => null }));
vi.mock('./needs', () => ({ pipelineNeeds: () => ({ hold: false }) }));
vi.mock('$lib/server/auth/accounts', () => ({
	listAllMailAccounts: () => [],
	listSchedulableAuths: () => [],
	markNeedsReauth: () => {}
}));
vi.mock('$lib/server/auto-reply', () => ({ pruneOldAutoReplies: () => {} }));
vi.mock('$lib/server/jev/health', () => ({ noteFailure: () => {}, noteRecovered: () => {} }));
vi.mock('$lib/server/log', () => ({ errorFields: (e: unknown) => ({ error: String(e) }) }));

const auth = { accountId: 'jmap-acc' } as AuthState;

/** Let the pass that is running finish, and whatever it set going. */
async function finishPass() {
	fakes.release.shift()?.();
	await new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
	fakes.passes = [];
	fakes.release = [];
	delete (globalThis as Record<symbol, unknown>)[Symbol.for('zajel.mailPipeline')];
	vi.resetModules();
});

describe('the pipeline’s start and its passes', () => {
	it('starts one minute’s run, and guards each account once, when the module is loaded twice', async () => {
		const schedule = vi.fn();
		fakes.schedule = schedule;
		const first = await import('./index');
		first.startMailPipeline();
		const running = first.requestPass('acct', auth, { fromStream: true });

		// A reload loads the module afresh.
		vi.resetModules();
		const second = await import('./index');
		expect(second).not.toBe(first);
		second.startMailPipeline();
		// The minute's run and the daily prune, once.
		expect(schedule.mock.calls.map(([when]) => when)).toEqual(['* * * * *', '41 3 * * *']);

		// Asked for from the reloaded module while the first's pass runs: run after it, not beside it.
		const asked = second.requestPass('acct', auth, { fromStream: true });
		expect(fakes.passes).toHaveLength(1);
		await finishPass();
		expect(fakes.passes).toHaveLength(2);
		await finishPass();
		await Promise.all([running, asked]);
		expect(fakes.passes).toHaveLength(2);
	});

	it('runs a re-run merged from a stream request and a scheduled one as a scheduled pass', async () => {
		const { requestPass } = await import('./index');
		const running = requestPass('acct', auth, { fromStream: true });
		void requestPass('acct', auth, { fromStream: true });
		void requestPass('acct', auth);
		void requestPass('acct', auth, { fromStream: true });
		await finishPass();
		await finishPass();
		await running;
		expect(fakes.passes.map((p) => !!p.opts.fromStream)).toEqual([true, false]);
	});

	it('runs a re-run merged from two stream requests as a stream pass', async () => {
		const { requestPass } = await import('./index');
		const running = requestPass('acct', auth);
		void requestPass('acct', auth, { fromStream: true });
		void requestPass('acct', auth, { fromStream: true });
		await finishPass();
		await finishPass();
		await running;
		expect(fakes.passes.map((p) => !!p.opts.fromStream)).toEqual([false, true]);
	});
});
