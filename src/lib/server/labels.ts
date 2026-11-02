import type { Cookies } from '@sveltejs/kit';
import type { JMAPClient } from '$lib/jmap/client';
import {
	LABEL_MIGRATION_COOKIE,
	LEGACY_LABELS_COOKIE,
	DEFAULT_LABEL_COLOR,
	type Label
} from '$lib/types/labels';
import { createLabelMailbox, listLabelMailboxes } from '$lib/jmap/labels';
import { autoLabelColor } from '$lib/constants/colors';
import {
	deleteLabelMeta,
	getLabelsForUser,
	upsertLabelMeta
} from '$lib/server/db/queries/label-meta';
import { lucideNode } from '$lib/server/lucide-icons';

export interface LabelMetaEntry {
	color: string;
	displayName: string;
	icon: string | null;
	createdAt: number;
}

export type LabelMeta = Record<string, LabelMetaEntry>;

const COOKIE_BASE = {
	path: '/',
	maxAge: 60 * 60 * 24 * 365,
	httpOnly: false,
	sameSite: 'strict',
	secure: true
} as const;

/** Hydrate the per-user label metadata into the `Record<id, …>` shape the
 *  rest of the server code expects. The data lives in SQLite; this reshapes it. */
export function getLabelMeta(userEmail: string): LabelMeta {
	const rows = getLabelsForUser(userEmail);
	const out: LabelMeta = {};
	for (const r of rows) {
		out[r.mailboxId] = {
			color: r.color,
			displayName: r.displayName,
			icon: r.icon,
			createdAt: r.createdAt
		};
	}
	return out;
}

export function updateLabelMeta(
	userEmail: string,
	id: string,
	patch: Partial<LabelMetaEntry>
): void {
	upsertLabelMeta(userEmail, id, {
		displayName: patch.displayName ?? null,
		color: patch.color ?? null
	});
}

export function removeLabelMeta(userEmail: string, id: string): void {
	deleteLabelMeta(userEmail, id);
}

/**
 * Merge the JMAP label mailboxes (children of the "Labels" container) with
 * SQLite-backed color meta into the Label[] shape the UI consumes. The
 * mailbox's own name is the display name; SQLite only overrides color (and an
 * optional renamed display name kept in sync on rename).
 */
export async function listLabels(
	client: JMAPClient,
	accountId: string,
	userEmail: string
): Promise<Label[]> {
	const [mailboxes, meta] = [await listLabelMailboxes(client, accountId), getLabelMeta(userEmail)];

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
			iconNode: lucideNode(entry?.icon),
			createdAt: entry?.createdAt ?? 0
		};
	});

	// In the order the user put them (sidebar drags set sortOrder), then by name.
	const position = new Map(mailboxes.map((m) => [m.id, m.sortOrder]));
	return labels.sort(
		(a, b) => (position.get(a.id) ?? 0) - (position.get(b.id) ?? 0) || a.name.localeCompare(b.name)
	);
}

/**
 * One-shot migration from keyword-based labels (cookie `mail_labels` +
 * `keywords/<id>` on emails) to mailbox-based labels. Idempotent; the marker
 * cookie makes subsequent loads a no-op. Most accounts have nothing to migrate.
 */
export async function migrateKeywordLabelsIfNeeded(
	client: JMAPClient,
	accountId: string,
	userEmail: string,
	cookies: Cookies
): Promise<void> {
	if (cookies.get(LABEL_MIGRATION_COOKIE) === 'v1') return;

	const rawOld = cookies.get(LEGACY_LABELS_COOKIE);
	if (!rawOld) {
		cookies.set(LABEL_MIGRATION_COOKIE, 'v1', COOKIE_BASE);
		return;
	}

	type OldLabel = { id: string; name: string; color: string; createdAt?: number };
	let oldLabels: OldLabel[] = [];
	try {
		const parsed = JSON.parse(decodeURIComponent(rawOld));
		if (Array.isArray(parsed)) oldLabels = parsed;
	} catch {
		// Malformed cookie — treat as empty and move on.
	}

	if (oldLabels.length === 0) {
		cookies.set(LABEL_MIGRATION_COOKIE, 'v1', COOKIE_BASE);
		cookies.delete(LEGACY_LABELS_COOKIE, { path: '/' });
		return;
	}

	// Existing label mailboxes, indexed by lowercased display name, so we can
	// reuse a child instead of failing on a duplicate-name create.
	const existing = await listLabelMailboxes(client, accountId);
	const existingByName = new Map(existing.map((m) => [m.name.toLowerCase(), m.id]));

	for (const old of oldLabels) {
		try {
			let newId = existingByName.get(old.name.trim().toLowerCase());

			if (!newId) {
				const result = await createLabelMailbox(client, accountId, old.name);
				if ('error' in result) continue;
				newId = result.id;
			}

			upsertLabelMeta(userEmail, newId, {
				displayName: old.name,
				color: old.color || DEFAULT_LABEL_COLOR
			});

			await migrateEmailsForLabel(client, accountId, old.id, newId);
		} catch {
			// Per-label failures are non-fatal; the next load will retry.
		}
	}

	cookies.set(LABEL_MIGRATION_COOKIE, 'v1', COOKIE_BASE);
	cookies.delete(LEGACY_LABELS_COOKIE, { path: '/' });
}

async function migrateEmailsForLabel(
	client: JMAPClient,
	accountId: string,
	oldKeyword: string,
	newMailboxId: string
): Promise<void> {
	const PAGE = 200;
	let position = 0;

	for (let safety = 0; safety < 100; safety++) {
		const response = await client.request([
			[
				'Email/query',
				{
					accountId,
					filter: { hasKeyword: oldKeyword },
					position,
					limit: PAGE,
					calculateTotal: true
				},
				'q'
			]
		]);

		const queryResult = response.methodResponses[0][1] as {
			ids?: string[];
			total?: number;
		};
		const ids = queryResult.ids ?? [];
		if (ids.length === 0) return;

		const update: Record<string, Record<string, unknown>> = {};
		for (const id of ids) {
			update[id] = {
				[`mailboxIds/${newMailboxId}`]: true,
				[`keywords/${oldKeyword}`]: null
			};
		}

		await client.request([['Email/set', { accountId, update }, 's']]);

		if (ids.length < PAGE) return;
		position += ids.length;
	}
}
