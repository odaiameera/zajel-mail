import { jevMode } from './client';
import { getJevSettings } from '$lib/server/db/queries/jev-settings';

/**
 * What keeps Jev from reading an account, or null when it reads it: Jev is
 * off on the server, switched off for the account, or the account's stored
 * password stopped working (the background passes skip it until the user
 * signs in again). Urgent alerts depend on it, since urgency is Jev's call.
 * Mirrors the gates in pipelineNeeds (mail-pipeline/needs.ts) and
 * listSchedulableAuths.
 */
export type JevBlock = 'server' | 'account' | 'sign-in';

export function jevBlock(account: { id: string; needs_reauth: number }): JevBlock | null {
	if (jevMode() === 'off') return 'server';
	if (account.needs_reauth === 1) return 'sign-in';
	if (!getJevSettings(account.id).jevEnabled) return 'account';
	return null;
}
