import type { Cookies } from '@sveltejs/kit';
import type { JMAPClient } from '$lib/jmap/client';
import { LEGACY_LABELS_COOKIE, DEFAULT_LABEL_COLOR, type Label } from '$lib/types/labels';
import { createLabelMailbox, listLabelMailboxes } from '$lib/jmap/labels';
import { autoLabelColor } from '$lib/constants/colors';
import { listMailboxMeta, setMailboxMeta } from '$lib/server/db/queries/mailbox-meta';
import { lucideNode } from '$lib/server/lucide-icons';
import { addLabel } from '$lib/server/filing';

/**
 * Merge the JMAP label mailboxes (children of the "Labels" container) with
 * their colour and icon (mailbox_meta, kept by the mail account `accountRowId`)
 * into the Label[] shape the UI consumes. The mailbox's own name is the
 * label's name unless a display name was stored.
 */
export async function listLabels(
	client: JMAPClient,
	accountId: string,
	accountRowId: string | null | undefined
): Promise<Label[]> {
	const mailboxes = await listLabelMailboxes(client, accountId);
	const meta = Object.fromEntries((accountRowId ? listMailboxMeta(accountRowId) : []).map((row) => [row.mailboxId, row]));

	// Labels nobody has coloured used to all fall back to the same blue, so
	// colour told them apart not at all. Give each its own from the automatic
	// palette instead — computed, not stored, so the account's data is
	// untouched until someone picks a colour. Colours already chosen are
	// taken first; the rest are handed out in id order, which keeps each
	// label's colour stable as others are added.
	const taken = new Set(
		mailboxes.map((m) => meta[m.id]?.color?.toLowerCase()).filter((c): c is string => !!c)
	);
	const autoColors = new Map<string, string>();
	for (const m of mailboxes.filter((m) => !meta[m.id]?.color).sort((a, b) => a.id.localeCompare(b.id))) {
		const hex = autoLabelColor(m.id, taken).hex;
		taken.add(hex.toLowerCase());
		autoColors.set(m.id, hex);
	}

	const labels = mailboxes.map<Label>((m) => {
		const entry = meta[m.id];
		return {
			id: m.id,
			name: entry?.displayName?.trim() || m.name,
			color: entry?.color ?? autoColors.get(m.id) ?? DEFAULT_LABEL_COLOR,
			icon: entry?.icon || null,
			iconNode: lucideNode(entry?.icon)
		};
	});

	// In the order the user put them (sidebar drags set sortOrder), then by name.
	const position = new Map(mailboxes.map((m) => [m.id, m.sortOrder]));
	return labels.sort(
		(a, b) => (position.get(a.id) ?? 0) - (position.get(b.id) ?? 0) || a.name.localeCompare(b.name)
	);
}

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/**
 * Per account, after a run that left the cookie in place: when to try
 * again, and when that was last logged. In memory, as the account tasks
 * keep theirs: a restart may try once more straight away.
 */
const keywordMigrationWait = new Map<string, { retryAt: number; warnedAt: number }>();

/**
 * The old keyword labels: an early version kept labels in a `mail_labels`
 * cookie and marked messages with a keyword per label. They become label
 * mailboxes, and each marked message gets the label (through filing, like
 * any other label) with the keyword cleared in the same write.
 *
 * Runs only while that cookie is there, so a page load without it costs
 * nothing. The cookie goes once every label has been carried over. If the
 * mail server refuses a write, or anything else fails, it stays, and the
 * next try for that account waits an hour (the failure is logged the first
 * time, then at most once a day). The cookie's colour is given only to a
 * label this run made: one that already exists keeps the colour its owner
 * gave it.
 */
export async function migrateKeywordLabelsIfNeeded(
	client: JMAPClient,
	accountId: string,
	accountRowId: string | null | undefined,
	cookies: Cookies,
	now = Date.now()
): Promise<void> {
	const rawOld = cookies.get(LEGACY_LABELS_COOKIE);
	if (!rawOld) return;

	const key = accountRowId || accountId;
	const waiting = keywordMigrationWait.get(key);
	if (waiting && now < waiting.retryAt) return;

	type OldLabel = { id: string; name: string; color: string };
	let oldLabels: OldLabel[] = [];
	try {
		const parsed = JSON.parse(decodeURIComponent(rawOld));
		if (Array.isArray(parsed)) {
			oldLabels = parsed.filter(
				(l): l is OldLabel => !!l && typeof l.id === 'string' && l.id !== '' && typeof l.name === 'string' && l.name.trim() !== ''
			);
		}
	} catch {
		// Malformed cookie: nothing in it can be carried over.
	}

	let failure: unknown = null;
	if (oldLabels.length > 0) {
		try {
			// Existing label mailboxes, by lower-cased name, so a label that was
			// carried over before is reused rather than created twice.
			const existing = await listLabelMailboxes(client, accountId);
			const existingByName = new Map(existing.map((m) => [m.name.toLowerCase(), m.id]));

			for (const old of oldLabels) {
				try {
					let newId = existingByName.get(old.name.trim().toLowerCase());
					if (!newId) {
						const result = await createLabelMailbox(client, accountId, old.name);
						if ('error' in result) {
							failure ??= new Error(`the label “${old.name}” could not be made: ${result.error}`);
							continue;
						}
						newId = result.id;
						existingByName.set(old.name.trim().toLowerCase(), newId);
						// Only a label made here takes the old colour.
						if (accountRowId && old.color) setMailboxMeta(accountRowId, newId, { color: old.color });
					}
					await migrateEmailsForLabel(client, accountId, old.id, newId);
				} catch (err) {
					failure ??= err;
				}
			}
		} catch (err) {
			failure ??= err;
		}
	}

	if (failure === null) {
		keywordMigrationWait.delete(key);
		cookies.delete(LEGACY_LABELS_COOKIE, { path: '/' });
		return;
	}
	const warn = !waiting || now - waiting.warnedAt >= DAY;
	keywordMigrationWait.set(key, { retryAt: now + HOUR, warnedAt: warn ? now : waiting.warnedAt });
	if (warn) {
		console.warn(
			'[labels] carrying over the old labels failed; will try again in an hour',
			failure instanceof Error ? failure.message : failure
		);
	}
}

/**
 * Give every message marked with the old keyword the label, clearing the
 * keyword in the same write. A refused write throws (EmailUpdateError), so
 * the caller keeps the cookie. Each round asks again from the start: what
 * was written no longer has the keyword.
 */
async function migrateEmailsForLabel(
	client: JMAPClient,
	accountId: string,
	oldKeyword: string,
	newMailboxId: string
): Promise<void> {
	const PAGE = 200;
	let lastFirst: string | null = null;

	for (let safety = 0; safety < 100; safety++) {
		const response = await client.request([
			['Email/query', { accountId, filter: { hasKeyword: oldKeyword }, limit: PAGE }, 'q']
		]);
		const ids = (response.methodResponses[0][1] as { ids?: string[] }).ids ?? [];
		if (ids.length === 0) return;
		// The same page twice: the server kept the keyword on. Stop rather than spin.
		if (ids[0] === lastFirst) throw new Error('The old label keyword could not be cleared');
		lastFirst = ids[0];

		await addLabel(client, accountId, ids, newMailboxId, { keywords: { [oldKeyword]: false } });
		if (ids.length < PAGE) return;
	}
	throw new Error('Too many messages to carry over in one go');
}
