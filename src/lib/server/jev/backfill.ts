import { listPendingEmailIds } from '$lib/server/db/queries/jev-decisions';
import { flush, type WriteContext } from '$lib/server/mail-pipeline/write';
import { planJevStep, type StepContext } from './step';

/**
 * Sorting the mail that was already in the Inbox when you asked Jev to
 * ("sort existing mail" in Settings): queued by that page, judged a batch
 * at a time on scheduled passes, after new mail. Its tab only: spam checks
 * and urgent alerts are for new mail.
 */

/** Queued existing emails judged per pass, after the new ones. */
const BACKFILL_BATCH = 100;

export async function runBackfill(step: StepContext, write: WriteContext): Promise<void> {
	const ids = listPendingEmailIds(step.accountRowId, BACKFILL_BATCH, true);
	const planned = await planJevStep(step, ids, { tabs: true, checkSpam: false, alertUrgent: false });
	await planned.finish(await flush(write, planned.changes));
}
