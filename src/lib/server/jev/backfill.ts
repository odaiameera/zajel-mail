import { listPendingEmailIds } from '$lib/server/db/queries/jev-decisions';
import { judgeAndApply, type Batch } from './step';

/**
 * Sorting the mail that was already in the Inbox when you asked Jev to
 * ("sort existing mail" in Settings): queued by that page, judged a batch
 * at a time on scheduled passes, after new mail. Its tab only: spam checks
 * and urgent alerts are for new mail.
 */

/** Queued existing emails judged per pass, after the new ones. */
const BACKFILL_BATCH = 100;

export async function runBackfill(b: Batch): Promise<void> {
	await judgeAndApply(b, listPendingEmailIds(b.accountRowId, BACKFILL_BATCH, true), true, false, false);
}
