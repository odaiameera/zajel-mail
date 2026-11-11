import type { PageServerLoad } from './$types';
import { getJevSettings } from '$lib/server/db/queries/jev-settings';
import { decisionStats, getUsage } from '$lib/server/db/queries/jev-decisions';
import { listPins } from '$lib/server/db/queries/jev-learning';
import {
	costUsd,
	jevMode,
	jevModel,
	PRICE_PER_MILLION_INPUT_TOKENS
} from '$lib/server/jev/client';
import { BODY_EXCERPT_CHARS } from '$lib/server/jev/email-state';
import { PREVIEW_LIMIT } from '$lib/server/jev/judge';

function startOfMonthUtc(now = new Date()): number {
	return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
}

export const load: PageServerLoad = async ({ parent }) => {
	const { accounts, activeAccountId } = await parent();
	const monthStart = startOfMonthUtc();
	return {
		jev: {
			mode: jevMode(),
			model: jevModel(),
			pricePerMillion: PRICE_PER_MILLION_INPUT_TOKENS,
			excerptChars: BODY_EXCERPT_CHARS,
			previewLimit: PREVIEW_LIMIT
		},
		jevAccounts: (accounts ?? []).map((a) => {
			const settings = getJevSettings(a.id);
			const usage = getUsage(a.id);
			return {
				id: a.id,
				email: a.email,
				displayName: a.displayName,
				isActive: a.id === activeAccountId,
				inboxTabs: settings.inboxTabs,
				jevEnabled: settings.jevEnabled,
				spamMode: settings.spamMode,
				pins: listPins(a.id).map((p) => ({ sender: p.sender, category: p.category })),
				month: {
					...decisionStats(a.id, monthStart),
					inputTokens: usage.inputTokens,
					costUsd: costUsd(usage.inputTokens)
				}
			};
		})
	};
};
