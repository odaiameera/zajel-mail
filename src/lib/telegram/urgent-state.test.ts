import { describe, expect, it } from 'vitest';
import { fixFor, urgentState } from './urgent-state';

const read = (email: string) => ({ email, blocked: null });
const off = (email: string) => ({ email, blocked: 'account' as const });

describe('urgentState', () => {
	it('shows the setting when Jev reads the account', () => {
		expect(urgentState([read('me@x.test')], true)).toEqual({ checked: true, disabled: false, skipped: [] });
		expect(urgentState([read('me@x.test')], false).checked).toBe(false);
	});

	it('is off and fixed in place while Jev reads no account, whatever was saved', () => {
		expect(urgentState([off('me@x.test')], true)).toMatchObject({ checked: false, disabled: true });
		expect(urgentState([off('a@x.test'), off('b@x.test')], true)).toMatchObject({ checked: false, disabled: true });
		expect(urgentState([], true)).toMatchObject({ checked: false, disabled: true });
	});

	it('lists the accounts Jev skips when it reads some', () => {
		const state = urgentState([read('a@x.test'), off('b@x.test')], true);
		expect(state).toMatchObject({ checked: true, disabled: false });
		expect(state.skipped.map((a) => a.email)).toEqual(['b@x.test']);
	});
});

describe('fixFor', () => {
	it('sends a lost sign-in to Accounts and everything else to Jev', () => {
		expect(fixFor('sign-in')).toEqual({ href: '/settings/accounts', label: 'Sign in' });
		expect(fixFor('account')).toEqual({ href: '/settings/jev', label: 'Jev' });
		expect(fixFor('server')).toEqual({ href: '/settings/jev', label: 'Jev' });
	});
});
