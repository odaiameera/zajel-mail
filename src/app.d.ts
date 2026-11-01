import type { AuthState } from '$lib/jmap/types';
import type { MailAccountPublic } from '$lib/server/auth/accounts';
import type { AppUser } from '$lib/server/auth/user';

declare global {
	namespace App {
		interface Locals {
			/** Webmail identity (master login). Set when the session cookie is valid. */
			user?: AppUser;
			/** The webmail session id backing `user` — used for logout/revoke. */
			sessionId?: string;
			/** When this session last proved a second factor (ms), for re-checks. */
			sessionVerifiedAt?: number | null;
			/** Linked mail accounts (no secrets), in user-defined order. */
			accounts?: MailAccountPublic[];
			/** Which linked account this request acts as. */
			activeAccountId?: string;
			/**
			 * JMAP auth for the active account. Same shape as ever — every API
			 * route and JMAP/CalDAV client consumes this unchanged.
			 */
			auth?: AuthState;
		}
	}
}

export {};
