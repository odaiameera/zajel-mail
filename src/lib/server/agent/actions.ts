import { authStateForAccount, getAccount } from '$lib/server/auth/accounts';
import { sendComposed, type ComposedMessage } from './compose';
import {
	claimPendingAction,
	finishPendingAction,
	getPendingAction,
	recordAudit,
	type PendingAction
} from './store';

/**
 * Deciding a pending action. Confirming runs it in the account the agent
 * was working in, whichever account is active now, and only once.
 */

export type Decision = 'confirm' | 'cancel';

type Executor = (action: PendingAction) => Promise<{ success: boolean; message: string }>;

const ADDRESS = /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[^\s@<>()",;:]+$/;

function asMessage(payload: Record<string, unknown>): ComposedMessage | null {
	const list = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
	const message: ComposedMessage = {
		to: list(payload.to),
		cc: list(payload.cc),
		subject: typeof payload.subject === 'string' ? payload.subject : '',
		text: typeof payload.text === 'string' ? payload.text : '',
		inReplyTo: typeof payload.inReplyTo === 'string' ? payload.inReplyTo : null,
		references: typeof payload.references === 'string' ? payload.references : null,
		replyToEmailId: typeof payload.replyToEmailId === 'string' ? payload.replyToEmailId : null
	};
	const valid = message.to.length > 0 && [...message.to, ...message.cc].every((a) => ADDRESS.test(a)) && message.subject;
	return valid ? message : null;
}

const EXECUTORS: Record<string, Executor> = {
	async send_email(action) {
		const message = asMessage(action.payload);
		const account = getAccount(action.accountId);
		if (!message || !account || account.user_id !== action.userId) {
			return { success: false, message: 'That message can no longer be sent' };
		}
		const result = await sendComposed(authStateForAccount(account), account.email, message);
		return result.success
			? { success: true, message: `Sent to ${message.to.join(', ')}` }
			: { success: false, message: result.error ?? 'The message could not be sent' };
	}
};

export async function decidePendingAction(
	userId: string,
	id: string,
	decision: Decision
): Promise<{ status: number; message: string }> {
	const action = getPendingAction(userId, id);
	if (!action) return { status: 404, message: 'Unknown action' };
	const executor = EXECUTORS[action.kind];
	if (!executor) return { status: 400, message: 'Unknown action' };
	if (!claimPendingAction(userId, id, decision === 'confirm' ? 'done' : 'cancelled')) {
		return { status: 409, message: action.status === 'expired' ? 'This has expired' : 'This was already decided' };
	}

	const audit = (summary: string, outcome: 'done' | 'refused' | 'failed') =>
		recordAudit({ userId, accountId: action.accountId, source: 'chat', tool: action.kind, tier: 'outward', summary, outcome });

	if (decision === 'cancel') {
		audit(`Cancelled ${action.kind.replace('_', ' ')}`, 'refused');
		return { status: 200, message: 'Cancelled' };
	}
	try {
		const result = await executor(action);
		finishPendingAction(id, result.success ? 'done' : 'failed', result.message);
		audit(result.message, result.success ? 'done' : 'failed');
		return { status: result.success ? 200 : 502, message: result.message };
	} catch (err) {
		const message = err instanceof Error ? err.message.slice(0, 200) : 'Failed';
		finishPendingAction(id, 'failed', message);
		audit(message, 'failed');
		return { status: 502, message };
	}
}

/** What the card shows: exactly what will run. */
export function pendingView(action: PendingAction) {
	return {
		id: action.id,
		kind: action.kind,
		status: action.status,
		expiresAt: action.expiresAt,
		to: action.payload.to,
		cc: action.payload.cc,
		subject: action.payload.subject,
		text: action.payload.text
	};
}
