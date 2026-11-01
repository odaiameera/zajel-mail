import { writable } from 'svelte/store';

/**
 * Client side of re-checks. A risky request the server refuses with
 * `stepUp: true` opens the "Confirm it's you" dialog (StepUpDialog, mounted
 * once in the app layout) and, once that succeeds, is sent again.
 */

export const stepUpPrompt = writable<((ok: boolean) => void) | null>(null);

/** Open the dialog; resolves true once the session has re-checked. */
export function requestStepUp(): Promise<boolean> {
	return new Promise((resolve) => {
		stepUpPrompt.set((ok) => {
			stepUpPrompt.set(null);
			resolve(ok);
		});
	});
}

async function needsStepUp(res: Response): Promise<boolean> {
	if (res.status !== 403) return false;
	const body = await res.clone().json().catch(() => null);
	return body?.stepUp === true;
}

/** `fetch`, asking for a re-check and retrying once when the server wants one. */
export async function fetchWithStepUp(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
	const res = await fetch(input, init);
	if (!(await needsStepUp(res))) return res;
	if (!(await requestStepUp())) return res;
	return fetch(input, init);
}
