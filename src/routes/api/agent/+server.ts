import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { listAudit } from '$lib/server/agent/store';
import { assistantStatus } from '$lib/server/ai/status';
import { describeSchedule } from '$lib/server/jobs/schedule';
import { describeSpec } from '$lib/server/jobs/specs';
import { deleteJob, jobsPaused, listJobs, setJobEnabled, setJobsPaused } from '$lib/server/jobs/store';

/** Settings → Assistant: the AI in use, the scheduled jobs, the pause-all switch, and the activity log. */

export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.user) error(401, 'Not signed in');
	const userId = locals.user.id;
	return json({
		assistant: assistantStatus(),
		paused: jobsPaused(userId),
		jobs: listJobs(userId).map((job) => ({
			id: job.id,
			title: job.title,
			what: describeSpec(job.spec),
			when: describeSchedule(job.schedule, job.timeZone),
			enabled: job.enabled,
			nextRunAt: job.nextRunAt,
			lastRunAt: job.lastRunAt,
			lastResult: job.lastResult
		})),
		activity: listAudit(userId, 100)
	});
};

// Switching off, pausing and deleting only ever take power away, so none of
// them asks for a re-check. Switching a job back on resumes what was
// already confirmed.
export const PATCH: RequestHandler = async ({ locals, request }) => {
	if (!locals.user) error(401, 'Not signed in');
	const body = (await request.json().catch(() => null)) as { id?: unknown; enabled?: unknown; paused?: unknown } | null;
	if (typeof body?.paused === 'boolean') {
		setJobsPaused(locals.user.id, body.paused);
		return json({ success: true });
	}
	if (typeof body?.id !== 'string' || typeof body.enabled !== 'boolean') error(400, 'id and enabled are required');
	if (!setJobEnabled(locals.user.id, body.id, body.enabled)) error(404, 'Unknown job');
	return json({ success: true });
};

export const DELETE: RequestHandler = async ({ locals, url }) => {
	if (!locals.user) error(401, 'Not signed in');
	const id = url.searchParams.get('id') ?? '';
	if (!deleteJob(locals.user.id, id)) error(404, 'Unknown job');
	return json({ success: true });
};
