import cron from 'node-cron';
import { listSchedulableAuths, markNeedsReauth } from '$lib/server/auth/accounts';
import { createClient } from '$lib/jmap/auth';
import { JMAPAuthError, JMAPMethodError, type JMAPClient } from '$lib/jmap/client';
import type { AuthState, Email } from '$lib/jmap/types';
import { errorFields, logEvent } from '$lib/server/log';
import { emailDocument, INDEX_PROPERTIES, MAX_BODY_BYTES } from './document';
import { embed, embedSettings, EmbedError, promptStyle } from './embed';
import {
	enabledIndexes,
	getIndexState,
	indexProgress,
	pendingEmailIds,
	recordAttempt,
	removeEmails,
	removeUnseen,
	restartWithModel,
	storeVectors,
	updateIndexState,
	upsertEmails,
	type IndexedEmail,
	type IndexState
} from './store';
import { forgetVectors, loadedVectors, loadVectors, quantize } from './vectors';

/**
 * Keeps each enabled account's index current. Every minute, per account:
 * catch up on `Email/changes` (new mail queued, deleted mail dropped, moves
 * noted), and list a few more pages of existing mail, newest first, until
 * all of it is queued. Then one loop embeds the queue a few messages at a
 * time, newest first, resting between batches so that Ollama is busy at
 * most DUTY of the time and a small server stays usable.
 *
 * Everything lives in SQLite, so a restart resumes where it stopped.
 */

/** Messages per listing request. */
const LIST_PAGE = 500;
/** Listing requests per account per minute. */
const LIST_PAGES_PER_TICK = 20;
const CHANGES_PER_CALL = 500;
const CHANGE_CALLS_PER_TICK = 10;
/** Messages per embedding request (up to MAX_CHUNKS chunks each). */
const EMBED_BATCH = 8;
const EMBED_TIMEOUT_MS = 120_000;
/** Share of the time the backfill keeps Ollama busy. */
const DUTY = 0.5;
/** How long an account whose turn failed sits out before the loop tries it again. */
const RETRY_MS = 60_000;

interface ListedEmail {
	id: string;
	receivedAt: string;
	mailboxIds: Record<string, boolean>;
}

function toIndexed(email: ListedEmail | Email): IndexedEmail {
	return {
		id: email.id,
		receivedAt: email.receivedAt,
		mailboxIds: Object.keys(email.mailboxIds ?? {}).filter((id) => email.mailboxIds[id])
	};
}

/** JMAP dates carry no fractional seconds. */
function utc(ms: number): string {
	return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

async function currentEmailState(client: JMAPClient, accountId: string): Promise<string> {
	const res = await client.request([['Email/get', { accountId, ids: [], properties: ['id'] }, 's']]);
	return (res.methodResponses[0][1] as { state: string }).state;
}

async function listPage(
	client: JMAPClient,
	accountId: string,
	filter: Record<string, unknown> | null,
	position = 0
): Promise<ListedEmail[]> {
	const res = await client.request([
		[
			'Email/query',
			{ accountId, filter, sort: [{ property: 'receivedAt', isAscending: false }], position, limit: LIST_PAGE },
			'q'
		],
		[
			'Email/get',
			{
				accountId,
				'#ids': { resultOf: 'q', name: 'Email/query', path: '/ids' },
				properties: ['id', 'receivedAt', 'mailboxIds']
			},
			'g'
		]
	]);
	return (res.methodResponses[1][1] as { list?: ListedEmail[] }).list ?? [];
}

async function getListed(client: JMAPClient, accountId: string, ids: string[]): Promise<ListedEmail[]> {
	const out: ListedEmail[] = [];
	for (let i = 0; i < ids.length; i += LIST_PAGE) {
		const res = await client.request([
			['Email/get', { accountId, ids: ids.slice(i, i + LIST_PAGE), properties: ['id', 'receivedAt', 'mailboxIds'] }, 'g']
		]);
		out.push(...((res.methodResponses[0][1] as { list?: ListedEmail[] }).list ?? []));
	}
	return out;
}

function remember(accountRowId: string, emails: ListedEmail[], gen: number): void {
	const indexed = emails.map(toIndexed);
	upsertEmails(accountRowId, indexed, gen);
	const loaded = loadedVectors(accountRowId);
	if (loaded) for (const e of indexed) loaded.setMailboxes(e.id, e.mailboxIds);
}

function forget(accountRowId: string, ids: string[]): void {
	if (ids.length === 0) return;
	removeEmails(accountRowId, ids);
	const loaded = loadedVectors(accountRowId);
	if (loaded) for (const id of ids) loaded.remove(id);
}

/** Apply what changed since the saved state. False when the server can no longer say. */
async function applyChanges(client: JMAPClient, accountId: string, state: IndexState): Promise<boolean> {
	let since = state.emailState!;
	for (let call = 0; call < CHANGE_CALLS_PER_TICK; call++) {
		let changes: { created: string[]; updated: string[]; destroyed: string[]; newState: string; hasMoreChanges: boolean };
		try {
			const res = await client.request([
				['Email/changes', { accountId, sinceState: since, maxChanges: CHANGES_PER_CALL }, 'c']
			]);
			changes = res.methodResponses[0][1] as typeof changes;
		} catch (err) {
			if (err instanceof JMAPMethodError && err.type === 'cannotCalculateChanges') return false;
			throw err;
		}
		forget(state.accountId, changes.destroyed ?? []);
		const touched = [...(changes.created ?? []), ...(changes.updated ?? [])];
		if (touched.length) remember(state.accountId, await getListed(client, accountId, touched), state.listGen);
		since = changes.newState;
		updateIndexState(state.accountId, { emailState: since });
		if (!changes.hasMoreChanges) break;
	}
	return true;
}

/** Queue more existing mail, newest first, from where the listing stopped. */
async function listMore(client: JMAPClient, accountId: string, state: IndexState): Promise<void> {
	let cursor = state.listCursor;
	for (let page = 0; page < LIST_PAGES_PER_TICK; page++) {
		const emails = await listPage(client, accountId, cursor ? { before: cursor } : null);
		remember(state.accountId, emails, state.listGen);
		if (emails.length < LIST_PAGE) {
			updateIndexState(state.accountId, { listed: true, listCursor: null });
			if (state.listGen > 0) forget(state.accountId, removeUnseen(state.accountId, state.listGen));
			return;
		}
		// The next page is everything before the oldest seen; messages sharing
		// its second that didn't fit on this page are listed first.
		const oldest = emails[emails.length - 1].receivedAt;
		const second = Math.floor(Date.parse(oldest) / 1000) * 1000;
		const tie = { after: utc(second), before: utc(second + 1000) };
		for (let position = 0; ; position += LIST_PAGE) {
			const tied = await listPage(client, accountId, tie, position);
			remember(state.accountId, tied, state.listGen);
			if (tied.length < LIST_PAGE) break;
		}
		cursor = utc(second);
		updateIndexState(state.accountId, { listCursor: cursor });
	}
}

/** One account's catch-up: model check, changes, listing. */
export async function syncAccount(accountRowId: string, auth: AuthState): Promise<void> {
	const settings = embedSettings();
	let state = getIndexState(accountRowId);
	if (!settings || !state?.enabled) return;

	if (state.model !== settings.model) {
		if (state.model) logEvent('info', 'search', 'model_changed', { from: state.model, to: settings.model });
		restartWithModel(accountRowId, settings.model);
		forgetVectors(accountRowId);
		state = getIndexState(accountRowId)!;
	}

	const client = createClient(auth);
	const { accountId } = auth;
	if (!state.emailState) {
		updateIndexState(accountRowId, { emailState: await currentEmailState(client, accountId) });
	} else if (!(await applyChanges(client, accountId, state))) {
		// Too far behind for the server to list changes: list everything
		// again, and drop whatever that doesn't find.
		logEvent('info', 'search', 'relisting', {});
		updateIndexState(accountRowId, {
			emailState: await currentEmailState(client, accountId),
			listGen: state.listGen + 1,
			listed: false,
			listCursor: null
		});
	}

	state = getIndexState(accountRowId)!;
	if (!state.listed) await listMore(client, accountId, state);
	markReadyIfDone(accountRowId);
}

function markReadyIfDone(accountRowId: string): void {
	const state = getIndexState(accountRowId);
	if (!state || state.ready || !state.listed) return;
	const progress = indexProgress(accountRowId);
	if (progress.pending > 0) return;
	if (progress.total > 0 && progress.done === 0) {
		// Every message was refused: an index with no vectors answers nothing.
		noteFailure(accountRowId, 'The endpoint refused every message', { model: embedSettings()?.model });
		return;
	}
	// Whatever went wrong on the way here is over.
	updateIndexState(accountRowId, { ready: true, lastError: null });
	logEvent('info', 'search', 'index_ready', { messages: progress.total, failed: progress.failed });
}

async function fetchForIndex(client: JMAPClient, accountId: string, ids: string[]): Promise<{ list: Email[]; notFound: string[] }> {
	const res = await client.request([
		[
			'Email/get',
			{
				accountId,
				ids,
				properties: INDEX_PROPERTIES,
				fetchTextBodyValues: true,
				fetchHTMLBodyValues: true,
				maxBodyValueBytes: MAX_BODY_BYTES
			},
			'g'
		]
	]);
	const result = res.methodResponses[0][1] as { list?: Email[]; notFound?: string[] };
	return { list: result.list ?? [], notFound: result.notFound ?? [] };
}

/** Record a failure once per streak, so a down endpoint isn't a line a minute. */
function noteFailure(accountRowId: string, message: string, fields: Record<string, unknown>): void {
	const state = getIndexState(accountRowId);
	if (state?.lastError !== message) logEvent('warn', 'search', 'embed_failed', fields);
	updateIndexState(accountRowId, { lastError: message });
}

/** A message's chunk vectors, or the refusal the endpoint answered its text with. */
type Embedded = Float32Array[] | EmbedError;

/**
 * Embed each message's prompted chunks, all in one request when the endpoint
 * takes them. A 400 means it refused the request, not that it is down, and
 * one message's text can be the reason: the messages are then sent one at a
 * time, and the refused ones come back as their error. When it refuses every
 * one of several, the fault is its own (a model that doesn't embed, say), so
 * that error is thrown and nothing is blamed on the mail.
 */
async function embedDocuments(perMessage: string[][]): Promise<Embedded[]> {
	const regroup = (vectors: Float32Array[]) => {
		let next = 0;
		return perMessage.map((inputs) => vectors.slice(next, (next += inputs.length)));
	};
	try {
		return regroup(await embed(perMessage.flat(), EMBED_TIMEOUT_MS));
	} catch (err) {
		if (!(err instanceof EmbedError && err.status === 400)) throw err;
		if (perMessage.length === 1) return [err];
		const each: Embedded[] = [];
		for (const inputs of perMessage) {
			try {
				each.push(await embed(inputs, EMBED_TIMEOUT_MS));
			} catch (one) {
				if (!(one instanceof EmbedError && one.status === 400)) throw one;
				each.push(one);
			}
		}
		if (each.every((e) => e instanceof EmbedError)) throw err;
		return each;
	}
}

/**
 * Embed one batch of an account's queue. False when the endpoint or the mail
 * server failed, which ends the account's turn until the next minute.
 */
export async function embedBatch(accountRowId: string, auth: AuthState): Promise<boolean> {
	const settings = embedSettings();
	const state = getIndexState(accountRowId);
	if (!settings || !state?.enabled || state.model !== settings.model) return false;
	const ids = pendingEmailIds(accountRowId, EMBED_BATCH);
	if (ids.length === 0) {
		markReadyIfDone(accountRowId);
		return true;
	}

	const { list, notFound } = await fetchForIndex(createClient(auth), auth.accountId, ids);
	forget(accountRowId, notFound);
	if (list.length === 0) return true;

	const style = promptStyle(settings.model);
	const docs = list.map(emailDocument);
	let embedded: Embedded[];
	try {
		embedded = await embedDocuments(docs.map((doc) => doc.chunks.map((chunk) => style.document(doc.title, chunk))));
	} catch (err) {
		noteFailure(accountRowId, err instanceof Error ? err.message : String(err), { ...errorFields(err), model: settings.model });
		return false;
	}

	// Switched off, or started over for another model, while the endpoint
	// worked: these vectors belong to neither.
	const fresh = getIndexState(accountRowId);
	if (!fresh?.enabled || fresh.model !== settings.model) return true;

	list.forEach((email, i) => {
		const refusal = embedded[i];
		if (!(refusal instanceof EmbedError)) return;
		// Skipped for good after a few tries; the rest of the batch is unaffected.
		recordAttempt(accountRowId, email.id);
		logEvent('warn', 'search', 'embed_refused', { ...errorFields(refusal), email: email.id, model: settings.model });
	});

	const sample = embedded.find((e): e is Float32Array[] => !(e instanceof EmbedError));
	if (sample) {
		const dims = sample[0].length;
		if (fresh.dimensions === null) updateIndexState(accountRowId, { dimensions: dims });
		else if (fresh.dimensions !== dims) {
			// Same name, different model behind it: start over.
			logEvent('info', 'search', 'model_changed', { from: `${fresh.model}/${fresh.dimensions}`, to: `${settings.model}/${dims}` });
			restartWithModel(accountRowId, settings.model);
			forgetVectors(accountRowId);
			return true;
		}

		const loaded = loadedVectors(accountRowId);
		list.forEach((email, i) => {
			const vectors = embedded[i];
			if (vectors instanceof EmbedError) return;
			const chunks = vectors.map(quantize);
			// Deleted while this batch was being embedded: nothing to store.
			if (!storeVectors(accountRowId, email.id, chunks)) return;
			const meta = toIndexed(email);
			loaded?.add({ id: meta.id, receivedAt: Date.parse(meta.receivedAt), mailboxIds: meta.mailboxIds }, chunks);
		});

		if (fresh.lastError) {
			updateIndexState(accountRowId, { lastError: null });
			logEvent('info', 'search', 'embed_recovered', { model: settings.model });
		}
	}
	markReadyIfDone(accountRowId);
	return true;
}

let started = false;
let ticking = false;
let pumping = false;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** What is failing now, by account and step: logged when it starts or changes, and once on recovery. */
const failing = new Map<string, unknown>();

function failed(accountRowId: string, step: 'sync' | 'index', err: unknown): void {
	const key = `${accountRowId}:${step}`;
	const fields = errorFields(err);
	if (failing.get(key) !== fields.error) logEvent('warn', 'search', `${step}_failed`, fields);
	failing.set(key, fields.error);
}

function recovered(accountRowId: string, step: 'sync' | 'index'): void {
	if (failing.delete(`${accountRowId}:${step}`)) logEvent('info', 'search', `${step}_recovered`, {});
}

/**
 * Embed queued mail, a batch per account in turn, until there's none left.
 * The accounts are looked up again every round, so one switched on while
 * another's backlog is being embedded joins in; one whose turn fails (its
 * mail server, say) sits out RETRY_MS while the others go on.
 */
async function pump(): Promise<void> {
	if (pumping) return;
	pumping = true;
	const stoppedAt = new Map<string, number>();
	try {
		for (;;) {
			const now = Date.now();
			const busy = listSchedulableAuths().filter(({ account }) => {
				if ((stoppedAt.get(account.id) ?? -Infinity) > now - RETRY_MS) return false;
				return getIndexState(account.id)?.enabled && pendingEmailIds(account.id, 1).length > 0;
			});
			if (busy.length === 0) return;
			for (const { account, auth } of busy) {
				const begun = Date.now();
				let ok: boolean;
				try {
					ok = await embedBatch(account.id, auth);
					recovered(account.id, 'index');
				} catch (err) {
					if (err instanceof JMAPAuthError) markNeedsReauth(account.id);
					else failed(account.id, 'index', err);
					ok = false;
				}
				if (!ok) stoppedAt.set(account.id, Date.now());
				await sleep(((Date.now() - begun) * (1 - DUTY)) / DUTY);
			}
		}
	} finally {
		pumping = false;
	}
}

/**
 * Bring a ready index into memory before anyone searches it, a step at a
 * time. Read on the request instead, a large one would hold up every request
 * for as long as the read takes.
 */
async function warmVectors(accountRowId: string): Promise<void> {
	const state = getIndexState(accountRowId);
	if (!state?.ready || !state.dimensions || state.model !== embedSettings()?.model) return;
	await loadVectors(accountRowId, state.dimensions);
}

/** One pass over every enabled account, then embedding in the background. */
export async function runIndexer(): Promise<void> {
	if (ticking || !embedSettings()) return;
	ticking = true;
	try {
		const enabled = new Set(enabledIndexes().map((s) => s.accountId));
		if (enabled.size === 0) return;
		for (const { account, auth } of listSchedulableAuths()) {
			if (!enabled.has(account.id)) continue;
			try {
				await syncAccount(account.id, auth);
				recovered(account.id, 'sync');
				await warmVectors(account.id);
			} catch (err) {
				if (err instanceof JMAPAuthError) markNeedsReauth(account.id);
				else failed(account.id, 'sync', err);
			}
		}
		void pump().catch((err) => logEvent('warn', 'search', 'index_failed', errorFields(err)));
	} finally {
		ticking = false;
	}
}

/** Run a pass now rather than at the next minute, as when indexing is switched on. */
export function kickIndexer(): void {
	runIndexer().catch((err) => logEvent('warn', 'search', 'sync_failed', errorFields(err)));
}

export function startSearchIndexer(): void {
	if (started) return;
	started = true;
	cron.schedule('* * * * *', kickIndexer);
}
