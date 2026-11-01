import type { InboxCategory } from '$lib/types/categories';

/**
 * What a job does: one of three typed kinds, never free-form code.
 * - digest: a short summary of unread Inbox mail, sent to Telegram;
 * - tidy: mark read or archive old mail in chosen Inbox tabs;
 * - agent: an instruction the agent carries out with reversible tools only.
 */

export type JobSpec =
	| { kind: 'digest'; scope: 'important_unread' | 'unread' }
	| { kind: 'tidy'; tabs: InboxCategory[]; olderThanHours: number; action: 'mark_read' | 'archive' }
	| { kind: 'agent'; instructions: string };

const TIDY_TABS: InboxCategory[] = ['updates', 'newsletters', 'promotions'];

export function parseSpec(raw: unknown): JobSpec | null {
	const s = (raw ?? {}) as Record<string, unknown>;
	switch (s.kind) {
		case 'digest':
			return { kind: 'digest', scope: s.scope === 'unread' ? 'unread' : 'important_unread' };
		case 'tidy': {
			// Never the Important tab: tidying is for mail that can wait.
			const tabs = (Array.isArray(s.tabs) ? s.tabs : []).filter((t): t is InboxCategory =>
				TIDY_TABS.includes(t as InboxCategory)
			);
			const hours = Number(s.olderThanHours);
			if (tabs.length === 0 || !Number.isFinite(hours)) return null;
			return {
				kind: 'tidy',
				tabs: [...new Set(tabs)],
				olderThanHours: Math.min(Math.max(Math.round(hours), 1), 24 * 90),
				action: s.action === 'archive' ? 'archive' : 'mark_read'
			};
		}
		case 'agent': {
			const instructions = typeof s.instructions === 'string' ? s.instructions.trim().slice(0, 1500) : '';
			return instructions ? { kind: 'agent', instructions } : null;
		}
		default:
			return null;
	}
}

export function describeSpec(spec: JobSpec): string {
	switch (spec.kind) {
		case 'digest':
			return spec.scope === 'unread' ? 'Telegram digest of unread Inbox mail' : 'Telegram digest of unread Important mail';
		case 'tidy':
			return `${spec.action === 'archive' ? 'Archive' : 'Mark read'} ${spec.tabs.join(', ')} older than ${spec.olderThanHours} h`;
		case 'agent':
			return `Agent: ${spec.instructions}`;
	}
}
