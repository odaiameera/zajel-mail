import type { JMAPClient } from './client';
import type { Mailbox } from './types';
import { REMIND_ME_LATER_NAME, SCHEDULED_NAME, isScheduledMailbox } from '$lib/mailboxes';

// Decided in $lib/mailboxes with the other kinds of mailbox; re-exported for
// the code that has always found them here.
export { REMIND_ME_LATER_NAME, SCHEDULED_NAME, isScheduledMailbox };

export async function getMailboxes(client: JMAPClient, accountId: string): Promise<Mailbox[]> {
	const response = await client.request([
		[
			'Mailbox/get',
			{
				accountId,
				ids: null,
				properties: ['id', 'name', 'role', 'sortOrder', 'totalEmails', 'unreadEmails', 'parentId']
			},
			'0'
		]
	]);

	const [, result] = response.methodResponses[0];
	const list = (result as { list: Mailbox[] }).list;

	return list.sort((a, b) => {
		const roleOrder = getRoleOrder(a.role) - getRoleOrder(b.role);
		if (roleOrder !== 0) return roleOrder;
		return a.sortOrder - b.sortOrder;
	});
}

export async function ensureRemindMeLaterMailbox(
	client: JMAPClient,
	accountId: string
): Promise<string> {
	const mailboxes = await getMailboxes(client, accountId);
	const existing = mailboxes.find(
		(m) => m.name === REMIND_ME_LATER_NAME && m.parentId === null
	);
	if (existing) return existing.id;

	const response = await client.request([
		[
			'Mailbox/set',
			{
				accountId,
				create: { rml1: { name: REMIND_ME_LATER_NAME, parentId: null } }
			},
			'0'
		]
	]);

	const result = response.methodResponses[0][1] as {
		created?: Record<string, { id: string }>;
	};
	return result.created?.rml1?.id ?? '';
}

export async function ensureScheduledMailbox(client: JMAPClient, accountId: string): Promise<string> {
	const mailboxes = await getMailboxes(client, accountId);
	const existing = mailboxes.find(isScheduledMailbox);
	if (existing) return existing.id;

	const response = await client.request([
		['Mailbox/set', { accountId, create: { sch1: { name: SCHEDULED_NAME, parentId: null } } }, '0']
	]);
	const result = response.methodResponses[0][1] as { created?: Record<string, { id: string }> };
	return result.created?.sch1?.id ?? '';
}

export async function ensureArchiveMailbox(client: JMAPClient, accountId: string): Promise<string> {
	const mailboxes = await getMailboxes(client, accountId);
	// A folder with the archive role, or else one the user made and called
	// Archive. Without that fallback, an account whose Archive has no role
	// tried to create a second "Archive", was refused, and nothing archived.
	const archive =
		mailboxes.find((m) => m.role === 'archive') ??
		mailboxes.find((m) => m.parentId === null && m.name.trim().toLowerCase() === 'archive');
	if (archive) return archive.id;

	const response = await client.request([
		[
			'Mailbox/set',
			{
				accountId,
				create: { arch1: { name: 'Archive', role: 'archive' } }
			},
			'0'
		]
	]);

	const result = response.methodResponses[0][1] as {
		created?: Record<string, { id: string }>;
	};

	return result.created?.arch1?.id ?? '';
}

function getRoleOrder(role: string | null): number {
	const order: Record<string, number> = {
		inbox: 0,
		drafts: 1,
		sent: 2,
		trash: 3,
		junk: 4
	};
	if (!role) return 10;
	return order[role] ?? 5;
}
