import { embedSettings } from './embed';
import { getIndexState, indexProgress } from './store';

/** What Settings shows for one account's index. */
export interface IndexStatus {
	/** EMBED_URL is set. */
	configured: boolean;
	model: string | null;
	enabled: boolean;
	ready: boolean;
	/** Messages known to the index. */
	total: number;
	/** Of those, embedded or given up on. */
	indexed: number;
	lastError: string | null;
}

export function indexStatus(accountRowId: string): IndexStatus {
	const settings = embedSettings();
	const state = getIndexState(accountRowId);
	const enabled = !!state?.enabled;
	const progress = enabled ? indexProgress(accountRowId) : { total: 0, done: 0, failed: 0, pending: 0 };
	return {
		configured: !!settings,
		model: settings?.model ?? null,
		enabled,
		ready: enabled && !!state?.ready && state.model === settings?.model,
		total: progress.total,
		indexed: progress.done + progress.failed,
		lastError: enabled ? (state?.lastError ?? null) : null
	};
}
