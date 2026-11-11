import { isRunnable, type Rule } from '$lib/types/rules';
import { listRules } from '$lib/server/rules/store';
import { getJevSettings, type SpamMode } from '$lib/server/db/queries/jev-settings';
import { listPins, type SenderPin } from '$lib/server/db/queries/jev-learning';
import { jevMode } from '$lib/server/jev/client';
import { outOfOfficeFor, type OutOfOffice } from '$lib/server/auto-reply';
import { urgentAlertsWanted } from '$lib/server/telegram/notifier';

/**
 * What a new-mail pass has to do for one account. The one place that reads
 * the switches: the rules, out-of-office, the Inbox tabs, Jev and its
 * add-ons. The pass, the Inbox's hold on new mail and the event streams
 * all decide from this, so they can't disagree.
 */
export interface PipelineNeeds {
	/** Rules that may run, in order. */
	rules: Rule[];
	/** One of them takes mail out of the Inbox (a folder, Archive, Trash or Junk; not a label). */
	rulesMoveMail: boolean;
	/** Out-of-office, when it is on for the account's login right now. */
	outOfOffice: OutOfOffice | null;
	/** Jev may read this account's mail: switched on, and configured on the server. */
	jev: boolean;
	/** When Jev was switched on: mail received before it is never sent to Jev. */
	jevSince: string | null;
	/** The Inbox is split into tabs. */
	tabs: boolean;
	/** Sender pins, which act only while the Inbox has tabs. */
	pins: SenderPin[];
	/** The spam add-on; 'off' whenever Jev can't be asked. */
	spamMode: SpamMode;
	/** Telegram alerts for urgent mail: one more question for Jev. */
	urgent: boolean;
	/** Jev's step has work: sorting the tabs (tabs and Jev), pins, spam or urgent alerts. */
	jevStep: boolean;
	/** New Inbox mail is held back until a pass has marked it (see `$lib/inbox-hold`). */
	hold: boolean;
	/** Anything at all acts on new mail: without it a pass asks the mail server nothing. */
	wantsArrivals: boolean;
}

/** A rule that files mail somewhere other than a label moves it out of the Inbox. */
function movesMail(rule: Rule): boolean {
	return rule.target.kind !== 'none' && rule.target.kind !== 'label';
}

export function pipelineNeeds(accountRowId: string, now = new Date()): PipelineNeeds {
	const settings = getJevSettings(accountRowId);
	const rules = listRules(accountRowId).filter(isRunnable);
	const outOfOffice = outOfOfficeFor(accountRowId, now);
	const jev = settings.jevEnabled && jevMode() !== 'off';
	const tabs = settings.inboxTabs;
	const pins = tabs ? listPins(accountRowId) : [];
	const spamMode: SpamMode = jev ? settings.spamMode : 'off';
	const urgent = jev && urgentAlertsWanted(accountRowId);
	const jevStep = (tabs && jev) || pins.length > 0 || spamMode !== 'off' || urgent;
	// Held only while a pass will mark it: while something puts new mail in
	// the tabs (Jev or a pin). Without the hold, such mail would show in
	// Important for a moment and then jump to its tab.
	const hold = tabs && (jev || pins.length > 0);
	return {
		rules,
		rulesMoveMail: rules.some(movesMail),
		outOfOffice,
		jev,
		jevSince: settings.jevSince,
		tabs,
		pins,
		spamMode,
		urgent,
		jevStep,
		hold,
		wantsArrivals: rules.length > 0 || !!outOfOffice || jevStep || hold
	};
}
