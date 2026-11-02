import type { JMAPClient } from './client';

export const MAX_FOLDER_NAME_LENGTH = 100;

/**
 * Validate a user-facing folder name. JMAP treats the `/` character as part
 * of the string, but many downstream IMAP bridges use it as a hierarchy
 * separator — reject it to avoid ambiguous folder trees. The `labels/`
 * prefix is reserved for Phase-1 label mailboxes.
 */
export function validateFolderName(name: string): string | null {
	const trimmed = name?.trim() ?? '';
	if (!trimmed) return 'Name is required';
	if (trimmed.length > MAX_FOLDER_NAME_LENGTH) return `Name must be ${MAX_FOLDER_NAME_LENGTH} characters or fewer`;
	if (trimmed.includes('/')) return 'Folder names cannot contain "/"';
	if (trimmed.toLowerCase().startsWith('labels/')) return 'The "labels/" prefix is reserved';
	return null;
}

export type CreateFolderResult = { id: string } | { error: string };
export type MutateFolderResult = { success: true; id?: string } | { success: false; error: string };

/**
 * Create a mailbox as a user folder. `parentId` places it inside another
 * mailbox; null creates a root-level folder.
 */
export async function createFolder(
	client: JMAPClient,
	accountId: string,
	{ name, parentId }: { name: string; parentId: string | null }
): Promise<CreateFolderResult> {
	const response = await client.request([
		[
			'Mailbox/set',
			{
				accountId,
				create: {
					fld1: { name: name.trim(), role: null, parentId }
				}
			},
			'0'
		]
	]);

	const result = response.methodResponses[0][1] as {
		created?: Record<string, { id: string }>;
		notCreated?: Record<string, { type: string; description?: string }>;
	};

	if (result.notCreated?.fld1) {
		const err = result.notCreated.fld1;
		return { error: err.description ?? err.type ?? 'Failed to create folder' };
	}

	const id = result.created?.fld1?.id;
	if (!id) return { error: 'Folder created but no id returned' };
	return { id };
}

/** Rename a user folder. */
export async function renameFolder(
	client: JMAPClient,
	accountId: string,
	id: string,
	newName: string
): Promise<MutateFolderResult> {
	const response = await client.request([
		[
			'Mailbox/set',
			{
				accountId,
				update: { [id]: { name: newName.trim() } }
			},
			'0'
		]
	]);

	const result = response.methodResponses[0][1] as {
		notUpdated?: Record<string, { type: string; description?: string }>;
	};

	if (result.notUpdated?.[id]) {
		const err = result.notUpdated[id];
		return { success: false, error: err.description ?? err.type ?? 'Rename failed' };
	}
	return { success: true, id };
}

/**
 * Destroy a user folder. We pass `onDestroyRemoveEmails: false` — it is
 * the user's job to move messages to Trash first; deleting a folder
 * should never delete messages outright.
 */
export async function deleteFolder(
	client: JMAPClient,
	accountId: string,
	id: string
): Promise<MutateFolderResult> {
	const response = await client.request([
		[
			'Mailbox/set',
			{
				accountId,
				destroy: [id],
				onDestroyRemoveEmails: false
			},
			'0'
		]
	]);

	const result = response.methodResponses[0][1] as {
		destroyed?: string[];
		notDestroyed?: Record<string, { type: string; description?: string }>;
	};

	if (result.notDestroyed?.[id]) {
		const err = result.notDestroyed[id];
		return { success: false, error: err.description ?? err.type ?? 'Delete failed' };
	}
	return { success: true, id };
}

/**
 * Place several mailboxes at once: their `sortOrder`, and for the one being
 * moved its `parentId`. One Mailbox/set, so a rearranged level lands whole
 * or not at all as far as one request can promise.
 */
export async function reorderMailboxes(
	client: JMAPClient,
	accountId: string,
	placements: Record<string, { parentId: string | null; sortOrder: number }>
): Promise<MutateFolderResult> {
	const ids = Object.keys(placements);
	if (ids.length === 0) return { success: true };

	const response = await client.request([
		['Mailbox/set', { accountId, update: placements }, '0']
	]);

	const result = response.methodResponses[0][1] as {
		notUpdated?: Record<string, { type: string; description?: string }>;
	};

	const failed = ids.find((id) => result.notUpdated?.[id]);
	if (failed) {
		const err = result.notUpdated![failed];
		return { success: false, error: err.description ?? err.type ?? 'Move failed' };
	}
	return { success: true };
}

/** Reparent a folder (the Edit dialog's parent picker; drags use {@link reorderMailboxes}). */
export async function moveFolder(
	client: JMAPClient,
	accountId: string,
	id: string,
	newParentId: string | null
): Promise<MutateFolderResult> {
	const response = await client.request([
		[
			'Mailbox/set',
			{
				accountId,
				update: { [id]: { parentId: newParentId } }
			},
			'0'
		]
	]);

	const result = response.methodResponses[0][1] as {
		notUpdated?: Record<string, { type: string; description?: string }>;
	};

	if (result.notUpdated?.[id]) {
		const err = result.notUpdated[id];
		return { success: false, error: err.description ?? err.type ?? 'Move failed' };
	}
	return { success: true, id };
}
