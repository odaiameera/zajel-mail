import { describeSchedule, nextRun, parseSchedule } from '$lib/server/jobs/schedule';
import { describeSpec, parseSpec } from '$lib/server/jobs/specs';
import { listJobs, setJobEnabled } from '$lib/server/jobs/store';
import { createPendingAction } from './store';
import type { AgentTool } from './tools';

/**
 * Scheduled jobs. A new job runs later without anyone watching, so making
 * one is outward: the user confirms it on a card, with a fresh re-check.
 * Switching one off is always allowed.
 */

function schema(properties: Record<string, unknown>, required: string[] = Object.keys(properties)) {
	return { type: 'object', properties, required, additionalProperties: false };
}

const scheduleJob: AgentTool = {
	name: 'schedule_job',
	tier: 'outward',
	description: `Propose a job that runs on its own later. Nothing is scheduled until the user confirms it.
what.kind:
- "digest": a short Telegram summary of unread Inbox mail; scope "important_unread" (Jev's Important tab) or "unread".
- "tidy": mark read or archive mail older than older_than_hours in the Updates, Newsletters or Promotions tabs (never starred mail).
- "agent": an instruction you will carry out each time, with reversible tools only (no sending, no invitations).
when.kind: "once" (at = local "YYYY-MM-DDTHH:mm"), "hourly", "daily" or "weekdays" (at = "HH:mm"), "weekly" (at = "HH:mm", day 0 = Sunday).`,
	input_schema: schema({
		title: { type: 'string' },
		what: schema({
			kind: { type: 'string', enum: ['digest', 'tidy', 'agent'] },
			scope: { type: ['string', 'null'], enum: ['important_unread', 'unread', null] },
			tabs: { type: 'array', items: { type: 'string', enum: ['updates', 'newsletters', 'promotions'] } },
			older_than_hours: { type: ['integer', 'null'] },
			action: { type: ['string', 'null'], enum: ['mark_read', 'archive', null] },
			instructions: { type: ['string', 'null'] }
		}),
		when: schema({
			kind: { type: 'string', enum: ['once', 'hourly', 'daily', 'weekdays', 'weekly'] },
			at: { type: ['string', 'null'] },
			day: { type: ['integer', 'null'] }
		})
	}),
	async run(ctx, input) {
		// Only a conversation the user is in can propose a job: a job can't make jobs.
		if (ctx.source !== 'chat') return { content: 'Jobs can only be set up while the user is chatting', isError: true };
		const what = (input.what ?? {}) as Record<string, unknown>;
		const spec = parseSpec({
			kind: what.kind,
			scope: what.scope,
			tabs: what.tabs,
			olderThanHours: what.older_than_hours,
			action: what.action,
			instructions: what.instructions
		});
		const schedule = parseSchedule(input.when);
		const title = typeof input.title === 'string' ? input.title.trim().slice(0, 120) : '';
		if (!spec || !schedule || !title) return { content: 'That job isn’t complete: check what, when and title', isError: true };
		if (nextRun(schedule, ctx.timeZone, Date.now()) === null) return { content: 'That time has already passed', isError: true };
		const pending = createPendingAction({
			userId: ctx.userId,
			accountId: ctx.accountRowId,
			conversationId: ctx.conversationId,
			kind: 'create_job',
			payload: { title, spec, schedule, timeZone: ctx.timeZone }
		});
		return {
			content: `Waiting for the user to confirm the job “${title}”: ${describeSpec(spec)}, ${describeSchedule(schedule, ctx.timeZone)}. Nothing is scheduled yet.`,
			pending
		};
	}
};

const listJobsTool: AgentTool = {
	name: 'list_jobs',
	tier: 'read',
	description: 'The user’s scheduled jobs, with ids.',
	input_schema: schema({}),
	async run(ctx) {
		const jobs = listJobs(ctx.userId);
		if (jobs.length === 0) return { content: 'No jobs.' };
		return {
			content: jobs
				.map((j) => `id=${j.id} | ${j.title} | ${describeSpec(j.spec)} | ${describeSchedule(j.schedule, j.timeZone)} | ${j.enabled ? 'on' : 'off'}`)
				.join('\n')
		};
	}
};

const stopJob: AgentTool = {
	name: 'stop_job',
	tier: 'self',
	description: 'Switch a scheduled job off. It can be switched back on in Settings → Agent.',
	input_schema: schema({ job_id: { type: 'string' } }),
	async run(ctx, input) {
		const id = typeof input.job_id === 'string' ? input.job_id : '';
		const job = listJobs(ctx.userId).find((j) => j.id === id);
		if (!job || !setJobEnabled(ctx.userId, id, false)) return { content: 'No such job', isError: true };
		const done = `Switched off the job “${job.title}”`;
		return { content: `Done: ${done}.`, done };
	}
};

export const JOB_TOOLS: AgentTool[] = [scheduleJob, listJobsTool, stopJob];
