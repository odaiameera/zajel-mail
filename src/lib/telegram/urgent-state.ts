/** One linked account as Settings → Notifications sees it. */
export interface AccountReach {
	email: string;
	/** What keeps Jev from reading it (see jevBlock), or null. */
	blocked: 'server' | 'account' | 'sign-in' | null;
}

/** Where the fix for a blocked account is, and the label for the link there. */
export function fixFor(blocked: NonNullable<AccountReach['blocked']>): { href: string; label: string } {
	return blocked === 'sign-in' ? { href: '/settings/accounts', label: 'Sign in' } : { href: '/settings/jev', label: 'Jev' };
}

/**
 * The Urgent mail switch as it can honestly be shown. Urgency is Jev's call,
 * so it is on only when the setting is and Jev reads at least one account,
 * and it can't be switched while Jev reads none. Showing it off saves
 * nothing: the stored setting comes back once Jev reads an account.
 */
export function urgentState(accounts: AccountReach[], urgent: boolean) {
	const skipped = accounts.filter((account) => account.blocked !== null);
	const anyRead = skipped.length < accounts.length;
	return { checked: anyRead && urgent, disabled: !anyRead, skipped };
}
