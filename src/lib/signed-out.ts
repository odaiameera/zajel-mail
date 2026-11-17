/**
 * Noticing, in an open app, that the session has ended: signed out from
 * another device, or expired while the computer slept.
 *
 * Moving between pages already leads to the sign-in form. Everything else the
 * app does is a request to its own API, which answers 401; nothing read that,
 * so opening a message, starring it or saving a draft simply did nothing.
 *
 * A 401 alone doesn't say it: the API also answers 401 for a wrong password on
 * a re-check and for a mail account that needs its password again. The server
 * marks the ones that mean "no session" (hooks.server.ts) with this header.
 */
export const SIGNED_OUT_HEADER = 'x-signed-out';

/**
 * Call `onSignedOut` the first time one of the page's requests is answered
 * that way. Returns the function that stops watching.
 */
export function watchForSignOut(onSignedOut: () => void): () => void {
	const native = window.fetch;
	let told = false;
	const watching: typeof fetch = async (input, init) => {
		const response = await native(input, init);
		if (!told && response.headers.get(SIGNED_OUT_HEADER)) {
			told = true;
			onSignedOut();
		}
		return response;
	};
	window.fetch = watching;
	return () => {
		if (window.fetch === watching) window.fetch = native;
	};
}
