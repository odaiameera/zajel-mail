import { json } from '@sveltejs/kit';

/** How long a re-check lasts before a risky change asks again. */
export const STEP_UP_WINDOW_MS = 10 * 60 * 1000;

/**
 * Risky changes need this session to have proved it's you within the last
 * ten minutes: adding or removing passkeys, the password, the second factor,
 * linked accounts, and (later) the agent's outward powers. A stolen session
 * cookie alone can then neither lock you out nor hand itself more reach.
 *
 * Returns the refusal to send back, or null when the session re-checked
 * recently. The client answers `stepUp: true` by asking for a passkey or a
 * code and retrying.
 */
export function stepUpRequired(locals: App.Locals, nowMs = Date.now()): Response | null {
	const at = locals.sessionVerifiedAt;
	if (at && nowMs - at < STEP_UP_WINDOW_MS) return null;
	return json({ error: 'Confirm it’s you to continue', stepUp: true }, { status: 403 });
}
