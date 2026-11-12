import { fetchWithStepUp } from '$lib/auth/step-up';
import { SaveCancelled } from './draft.svelte';

/**
 * Sends a settings change as JSON and returns the reply's body.
 *
 * Made for a draft's `persist`: when the change wasn't stored it throws an
 * `Error` carrying the server's own reason, or a plain one when it gave
 * none, so the Save bar can show it as it is. With `stepUp`, a server that
 * wants a fresh sign-in check gets the "Confirm it's you" dialog first;
 * closing that dialog is `SaveCancelled`, not an error.
 */
export async function sendJson(
	url: string,
	body: unknown,
	{ method = 'POST', stepUp = false }: { method?: string; stepUp?: boolean } = {}
): Promise<unknown> {
	const init: RequestInit = {
		method,
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(body)
	};
	let res: Response;
	try {
		res = stepUp ? await fetchWithStepUp(url, init) : await fetch(url, init);
	} catch {
		throw new Error('Couldn’t reach the server. Try again.');
	}
	const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
	if (!res.ok) {
		if (data?.stepUp === true) throw new SaveCancelled();
		const reason = data?.message ?? data?.error;
		throw new Error(typeof reason === 'string' && reason ? reason : 'Couldn’t save. Try again.');
	}
	return data;
}

/** One of the requests a page saves with: what it stores, under a name the Save bar can give. */
export interface SaveStep<T> {
	/** The setting as the page calls it ("Theme"), for the message when this one fails. */
	label: string;
	/** The settings this request stores, as `stored` takes them. */
	values: Partial<T>;
	run: () => Promise<unknown>;
}

/**
 * For a page that saves in more than one request. Sends each in turn; the
 * ones that go through are reported to `stored` (so they are no longer
 * unsaved), and a failure doesn't stop the others. Throws when any failed,
 * naming which, since some may have saved.
 */
export async function saveEach<T>(stored: (values: Partial<T>) => void, steps: SaveStep<T>[]): Promise<void> {
	const failed: { label: string; reason: string }[] = [];
	let cancelled = false;
	for (const step of steps) {
		try {
			await step.run();
			stored(step.values);
		} catch (err) {
			if (err instanceof SaveCancelled) {
				cancelled = true;
				continue;
			}
			const reason = err instanceof Error && err.message ? err.message : 'Couldn’t save. Try again.';
			failed.push({ label: step.label, reason });
		}
	}
	if (failed.length > 0) {
		// Nothing saved for the same reason: the reason alone says it.
		const reasons = new Set(failed.map((f) => f.reason));
		if (failed.length === steps.length && reasons.size === 1) throw new Error(failed[0].reason);
		throw new Error(failed.map((f) => `${f.label} wasn’t saved: ${f.reason}`).join(' '));
	}
	if (cancelled) throw new SaveCancelled();
}
