import type { JMAPClient } from '$lib/jmap/client';
import type { Email, EmailQueryResult } from '$lib/jmap/types';
import { getListEmails, queryEmailIds, searchEmails } from '$lib/jmap/email';
import { errorFields, logEvent } from '$lib/server/log';
import { embed, embedSettings, promptStyle } from './embed';
import { indexPrefilter, matchesFilter, splitSemantic, type JmapFilter } from './filter';
import { getIndexState } from './store';
import { accountVectors } from './vectors';

/**
 * Mail search: Stalwart's keyword search, and — when the account's index is
 * complete — the nearest messages by meaning, merged by reciprocal rank
 * fusion. Exact names and invoice numbers come from the keywords; "the
 * plumber's quote from spring" comes from the vectors; a message both find
 * rises to the top.
 *
 * Anything wrong on the vector side (no index yet, Ollama down) leaves the
 * keyword results exactly as they were, newest first.
 */

/** The usual RRF constant: how quickly lower ranks stop counting. */
export const RRF_K = 60;
/**
 * Keyword match ids fetched to rank alongside the vectors. Ids only, so this
 * is cheap, and having all of them is what keeps the total exact: a vector
 * match is counted once whether or not the keywords found it too. A server
 * caps it at its own query maximum; past that, later matches follow newest
 * first and the total can count a few twice.
 */
const KEYWORD_POOL = 5_000;
/** Nearest messages scored before the rest of the filter is checked. */
const VECTOR_POOL = 100;
/** Vector matches that join the results. */
const VECTOR_KEEP = 30;
/** How far above the bulk of the mailbox a vector match must score; see `outlierFloor`. */
const MIN_Z = 3.5;
/** A cold model takes a few seconds to load; longer than this, search goes on without it. */
const QUERY_TIMEOUT_MS = 8_000;
/** After a failed query embedding, how long searches skip the vector side. */
const PAUSE_MS = 60_000;

export interface MailSearchInput {
	client: JMAPClient;
	/** JMAP account id. */
	accountId: string;
	/** The linked account row the index belongs to; null searches by keyword only. */
	accountRowId: string | null;
	filter: JmapFilter;
	position?: number;
	limit?: number;
}

export interface MailSearchResult extends EmailQueryResult {
	/** True when results are in relevance order rather than newest first. */
	ranked: boolean;
}

/** Merge ranked id lists: each list adds 1/(k + rank) to an id's score. */
export function reciprocalRankFusion(lists: string[][], k = RRF_K): string[] {
	const scores = new Map<string, number>();
	for (const list of lists) {
		list.forEach((id, rank) => scores.set(id, (scores.get(id) ?? 0) + 1 / (k + rank + 1)));
	}
	return [...scores.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
}

let pausedUntil = 0;
/** The vector side's current failure, logged once when it starts or changes. */
let failure: string | null = null;

/** For tests: forget a pause left by an earlier failure. */
export function resetSearchPauseForTests(): void {
	pausedUntil = 0;
	failure = null;
	queryCache.clear();
}

/** Query vectors for recent searches, so paging through results doesn't embed again. */
const queryCache = new Map<string, Float32Array>();
const QUERY_CACHE_SIZE = 50;

async function queryVector(text: string, model: string): Promise<Float32Array> {
	const key = `${model}\n${text}`;
	const cached = queryCache.get(key);
	if (cached) return cached;
	const [vector] = await embed([promptStyle(model).query(text)], QUERY_TIMEOUT_MS);
	queryCache.set(key, vector);
	if (queryCache.size > QUERY_CACHE_SIZE) queryCache.delete(queryCache.keys().next().value!);
	return vector;
}

/** The index's model and size, when it can answer searches for this account. */
export function semanticIndexFor(accountRowId: string | null): { model: string; dims: number } | null {
	if (!accountRowId || Date.now() < pausedUntil) return null;
	const settings = embedSettings();
	const state = getIndexState(accountRowId);
	if (!settings || !state?.enabled || !state.ready || !state.dimensions) return null;
	if (state.model !== settings.model) return null;
	return { model: settings.model, dims: state.dimensions };
}

interface VectorSide {
	/** Vector matches that meet the whole filter, best first. */
	ranked: string[];
	/** Those of them already fetched, for display. */
	fetched: Map<string, Email>;
}

async function vectorSide(
	input: MailSearchInput,
	index: { model: string; dims: number },
	text: string,
	rest: JmapFilter | null,
	keywordIds: Promise<Set<string>>
): Promise<VectorSide> {
	const vectors = accountVectors(input.accountRowId!, index.dims);
	// A large index still being read into memory, as after a restart: the
	// keyword results stand alone until it is.
	if (!vectors) return { ranked: [], fetched: new Map() };
	const query = await queryVector(text, index.model);
	const neighbours = vectors.search(query, VECTOR_POOL, indexPrefilter(rest), MIN_Z);
	const keyword = await keywordIds;
	// Keyword matches already meet the filter; the rest are checked as fetched.
	const toCheck = neighbours.map((n) => n.id).filter((id) => !keyword.has(id));
	const fetched = new Map(
		(await getListEmails(input.client, input.accountId, toCheck))
			.filter((email) => matchesFilter(email, rest))
			.map((email) => [email.id, email])
	);
	return {
		ranked: neighbours
			.map((n) => n.id)
			.filter((id) => keyword.has(id) || fetched.has(id))
			.slice(0, VECTOR_KEEP),
		fetched
	};
}

/** Search one account's mail; see the module comment. */
export async function searchMail(input: MailSearchInput): Promise<MailSearchResult> {
	const { client, accountId, filter, position = 0, limit = 50 } = input;
	const keywordOnly = async (): Promise<MailSearchResult> => ({
		...(await searchEmails(client, accountId, filter, { position, limit })),
		ranked: false
	});

	const semantic = splitSemantic(filter);
	const index = semantic ? semanticIndexFor(input.accountRowId) : null;
	if (!semantic || !index) return keywordOnly();

	const keywordQuery = queryEmailIds(client, accountId, filter, { limit: KEYWORD_POOL });
	// A keyword failure surfaces from Promise.all below, not as a vector one.
	const keywordSet = keywordQuery.then((r) => new Set(r.ids), () => new Set<string>());
	const started = Date.now();
	const [keyword, vectors] = await Promise.all([
		keywordQuery,
		vectorSide(input, index, semantic.text, semantic.rest, keywordSet).catch((err) => {
			pausedUntil = Date.now() + PAUSE_MS;
			const fields = errorFields(err);
			if (fields.error !== failure) logEvent('warn', 'search', 'vector_search_failed', { ...fields, ms: Date.now() - started });
			failure = String(fields.error);
			return null;
		})
	]);
	if (vectors && failure) {
		logEvent('info', 'search', 'vector_search_recovered', {});
		failure = null;
	}
	if (!vectors || vectors.ranked.length === 0) return keywordOnly();

	const keywordHits = new Set(keyword.ids);
	const vectorOnly = vectors.ranked.filter((id) => !keywordHits.has(id));

	const fused = reciprocalRankFusion([keyword.ids, vectors.ranked]);
	const total = keyword.total + vectorOnly.length;
	const end = Math.min(position + limit, total);

	// Inside the fused window: fetch what the vector side hasn't.
	const windowIds = fused.slice(position, end);
	const missing = windowIds.filter((id) => !vectors.fetched.has(id));
	const got = new Map((await getListEmails(client, accountId, missing)).map((e) => [e.id, e]));
	const emails = windowIds
		.map((id) => vectors.fetched.get(id) ?? got.get(id))
		.filter((email): email is Email => !!email);

	// Past it: the keyword matches beyond the pool, newest first, without
	// any the vector side already placed higher up.
	if (end > fused.length) {
		const from = Math.max(position, fused.length);
		const tail = await searchEmails(client, accountId, filter, {
			position: keyword.ids.length + (from - fused.length),
			limit: end - from
		});
		const placed = new Set(vectorOnly);
		emails.push(...tail.emails.filter((email) => !placed.has(email.id)));
	}

	return { emails, total, ranked: true };
}
