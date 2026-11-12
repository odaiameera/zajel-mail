/**
 * "Save & apply": run one saved rule over the Inbox now, reading the
 * server's progress as it goes (an event stream from /api/rules/apply).
 * The rule was saved a moment before; the server applies the saved copy,
 * named by its id.
 */

export interface ApplyProgress {
	status: 'idle' | 'running' | 'done' | 'error';
	scanned: number;
	matched: number;
	applied: number;
	total: number;
	error?: string;
}

export const IDLE_PROGRESS: ApplyProgress = { status: 'idle', scanned: 0, matched: 0, applied: 0, total: 0 };

/** The progress after one event from the stream. */
export function applyEvent(progress: ApplyProgress, data: { type: string; [k: string]: unknown }): ApplyProgress {
	if (data.type === 'start') {
		return { ...progress, total: (data.total as number) ?? 0 };
	}
	if (data.type === 'progress') {
		return {
			...progress,
			scanned: (data.scanned as number) ?? progress.scanned,
			matched: (data.matched as number) ?? progress.matched,
			applied: (data.applied as number) ?? progress.applied,
			total: (data.total as number) ?? progress.total
		};
	}
	if (data.type === 'done') {
		const failed = (data.failed as number) ?? 0;
		return {
			...progress,
			scanned: (data.scanned as number) ?? progress.scanned,
			matched: (data.matched as number) ?? progress.matched,
			applied: (data.applied as number) ?? progress.applied,
			status: failed > 0 ? 'error' : 'done',
			error:
				failed > 0
					? `The mail server rejected ${failed} update${failed === 1 ? '' : 's'}${data.failedReason ? ` — ${data.failedReason}` : ''}.`
					: undefined
		};
	}
	if (data.type === 'error') {
		return { ...progress, status: 'error', error: (data.message as string) ?? 'Error' };
	}
	return progress;
}

/**
 * Apply the saved rule `ruleId`, calling `onProgress` with each new state.
 * Resolves when the stream ends; a cancel (`signal`) ends it quietly.
 */
export async function streamApply(
	ruleId: string,
	onProgress: (progress: ApplyProgress) => void,
	signal?: AbortSignal
): Promise<void> {
	let progress: ApplyProgress = { status: 'running', scanned: 0, matched: 0, applied: 0, total: 0 };
	const set = (next: ApplyProgress) => {
		progress = next;
		onProgress(next);
	};
	set(progress);

	try {
		const res = await fetch('/api/rules/apply', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ ruleIds: [ruleId] }),
			signal
		});
		if (!res.ok || !res.body) {
			set({ ...progress, status: 'error', error: `HTTP ${res.status}` });
			return;
		}

		const reader = res.body.getReader();
		const decoder = new TextDecoder();
		let buffer = '';

		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			const events = buffer.split('\n\n');
			buffer = events.pop() ?? '';
			for (const ev of events) {
				if (!ev.startsWith('data: ')) continue;
				try {
					set(applyEvent(progress, JSON.parse(ev.slice(6))));
				} catch {
					// skip malformed SSE frame
				}
			}
		}

		if (progress.status === 'running') set({ ...progress, status: 'done' });
	} catch (err) {
		if ((err as Error)?.name === 'AbortError') return;
		set({ ...progress, status: 'error', error: err instanceof Error ? err.message : 'Apply failed' });
	}
}
