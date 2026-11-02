import { embedSettings } from './embed';
import { getIndexState, indexProgress } from './store';

/** What Settings shows for one account's index. */
export interface IndexStatus {
	/** An endpoint is set, in Settings or EMBED_URL. */
	configured: boolean;
	model: string | null;
	enabled: boolean;
	ready: boolean;
	/** Messages known to the index. */
	total: number;
	/** Of those, embedded or given up on. */
	indexed: number;
	/** What stopped the last attempt; the indexer tries again every minute. */
	lastError: string | null;
}

export function indexStatus(accountRowId: string): IndexStatus {
	const settings = embedSettings();
	const state = getIndexState(accountRowId);
	const enabled = !!state?.enabled;
	const progress = enabled ? indexProgress(accountRowId) : { total: 0, done: 0, failed: 0, pending: 0 };
	const ready = enabled && !!state?.ready && state.model === settings?.model;
	return {
		configured: !!settings,
		model: settings?.model ?? null,
		enabled,
		ready,
		total: progress.total,
		indexed: progress.done + progress.failed,
		// A finished index is ready whatever went wrong on the way there.
		lastError: enabled && !ready ? (state?.lastError ?? null) : null
	};
}
