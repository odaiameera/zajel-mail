/**
 * How much one turn may change without a card. Email content can steer the
 * model, so the server, not the prompt, bounds what a steered turn can do on
 * its own: past a limit the tool refuses and the model has to ask the user.
 * Ordinary tidying stays well inside them.
 */
export const TURN_LIMITS = {
	/** Messages moved to Trash, which is emptied after a while. */
	trashed: 30,
	/** Messages archived or moved to a folder. */
	moved: 100,
	/** Telegram reminders set. */
	reminders: 3,
	/** Drafts saved: never sent from Drafts without the user, but a steered turn shouldn't fill the folder. */
	drafts: 10,
	/** Cards a scheduled job prepares for the user's confirmation (sends, invitations, deletions). */
	proposals: 5
} as const;

export type TurnBudget = { -readonly [K in keyof typeof TURN_LIMITS]: number };

const WHAT: Record<keyof TurnBudget, string> = {
	trashed: 'move to Trash',
	moved: 'archive or move',
	reminders: 'set',
	drafts: 'save',
	proposals: 'prepare'
};
const UNIT: Record<keyof TurnBudget, string> = {
	trashed: 'messages',
	moved: 'messages',
	reminders: 'reminders',
	drafts: 'drafts',
	proposals: 'changes for confirmation'
};

export function newTurnBudget(): TurnBudget {
	return { trashed: 0, moved: 0, reminders: 0, drafts: 0, proposals: 0 };
}

/** Use `n` of the turn's allowance for `kind`, or say why it can't. */
export function spend(budget: TurnBudget, kind: keyof TurnBudget, n: number): string | null {
	const limit = TURN_LIMITS[kind];
	if (budget[kind] + n > limit) {
		return `Not done: one turn may ${WHAT[kind]} at most ${limit} ${UNIT[kind]} on its own, and this one has ${budget[kind]} so far. Tell the user what is left and let them ask for the rest.`;
	}
	budget[kind] += n;
	return null;
}
