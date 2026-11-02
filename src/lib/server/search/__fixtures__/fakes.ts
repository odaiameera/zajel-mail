import { JMAPMethodError } from '$lib/jmap/client';
import type { Email, JMAPResponse, MethodCall } from '$lib/jmap/types';
import { matchesFilter, type JmapFilter } from '../filter';

/**
 * Test doubles for semantic search: a mailbox that answers the JMAP calls
 * the indexer and search make, and an embedding model that understands a few
 * topics, so tests can tell matching by meaning from matching by keyword.
 */

export interface FakeEmailInput {
	id: string;
	receivedAt: string;
	subject?: string;
	body?: string;
	from?: string;
	mailboxIds?: string[];
	keywords?: Record<string, boolean>;
}

export function fakeEmail(input: FakeEmailInput): Email {
	const body = input.body ?? '';
	return {
		id: input.id,
		blobId: `b-${input.id}`,
		threadId: `t-${input.id}`,
		mailboxIds: Object.fromEntries((input.mailboxIds ?? ['inbox']).map((id) => [id, true])),
		from: [{ name: null, email: input.from ?? 'someone@example.com' }],
		to: [{ name: null, email: 'me@example.test' }],
		cc: null,
		subject: input.subject ?? '',
		receivedAt: input.receivedAt,
		size: body.length,
		preview: body.slice(0, 100),
		keywords: input.keywords ?? {},
		hasAttachment: false,
		textBody: [{ partId: '1', blobId: `p-${input.id}`, type: 'text/plain', name: null }],
		htmlBody: [],
		bodyValues: { '1': { value: body, isEncodingProblem: false, isTruncated: false } }
	};
}

function textHolds(email: Email, text: string): boolean {
	const haystack = `${email.subject} ${email.bodyValues?.['1']?.value ?? ''}`.toLowerCase();
	return text.toLowerCase().split(/\s+/).every((word) => haystack.includes(word));
}

/** Stalwart's search, near enough: `text` is every word somewhere in subject or body. */
function holds(email: Email, filter: JmapFilter | null): boolean {
	if (!filter) return true;
	if (Array.isArray(filter.conditions)) {
		const results = (filter.conditions as JmapFilter[]).map((c) => holds(email, c));
		if (filter.operator === 'AND') return results.every(Boolean);
		if (filter.operator === 'OR') return results.some(Boolean);
		return !results.some(Boolean);
	}
	const { text, ...rest } = filter;
	if (typeof text === 'string' && !textHolds(email, text)) return false;
	return matchesFilter(email, Object.keys(rest).length ? rest : null);
}

type Change = { state: number; kind: 'created' | 'updated' | 'destroyed'; id: string };

export class FakeMailbox {
	emails = new Map<string, Email>();
	state = 1;
	/** Changes before this state are forgotten: Email/changes can't answer from earlier. */
	oldestState = 1;
	/** The most ids one Email/query returns, however many are asked for. */
	maxResults = 5000;
	private log: Change[] = [];
	calls: MethodCall[] = [];

	add(...inputs: FakeEmailInput[]): void {
		for (const input of inputs) {
			this.emails.set(input.id, fakeEmail(input));
			this.log.push({ state: ++this.state, kind: 'created', id: input.id });
		}
	}

	move(id: string, mailboxIds: string[]): void {
		this.emails.get(id)!.mailboxIds = Object.fromEntries(mailboxIds.map((m) => [m, true]));
		this.log.push({ state: ++this.state, kind: 'updated', id });
	}

	destroy(id: string): void {
		this.emails.delete(id);
		this.log.push({ state: ++this.state, kind: 'destroyed', id });
	}

	forgetHistory(): void {
		this.oldestState = this.state;
	}

	private query(args: Record<string, unknown>): { ids: string[]; total: number } {
		const matches = [...this.emails.values()]
			.filter((e) => holds(e, (args.filter as JmapFilter | null) ?? null))
			.sort((a, b) => b.receivedAt.localeCompare(a.receivedAt) || b.id.localeCompare(a.id));
		const position = Number(args.position ?? 0);
		const limit = Math.min(Number(args.limit ?? 50), this.maxResults);
		return { ids: matches.slice(position, position + limit).map((e) => e.id), total: matches.length };
	}

	private changes(since: number, max: number) {
		if (since < this.oldestState) throw new JMAPMethodError('cannotCalculateChanges', '');
		const pending = this.log.filter((c) => c.state > since);
		const taken = pending.slice(0, max);
		const newState = taken.length ? taken[taken.length - 1].state : this.state;
		const ids = (kind: Change['kind']) => [...new Set(taken.filter((c) => c.kind === kind).map((c) => c.id))];
		const destroyed = ids('destroyed');
		const created = ids('created').filter((id) => !destroyed.includes(id));
		const updated = ids('updated').filter((id) => !destroyed.includes(id) && !created.includes(id));
		return { created, updated, destroyed, oldState: String(since), newState: String(newState), hasMoreChanges: pending.length > max };
	}

	async request(calls: MethodCall[]): Promise<JMAPResponse> {
		this.calls.push(...calls);
		const results: Record<string, unknown> = {};
		const methodResponses = calls.map(([name, args, tag]): [string, Record<string, unknown>, string] => {
			let result: Record<string, unknown>;
			if (name === 'Email/query') {
				result = this.query(args);
			} else if (name === 'Email/get') {
				const ref = args['#ids'] as { resultOf: string } | undefined;
				const ids = ref ? ((results[ref.resultOf] as { ids: string[] }).ids) : (args.ids as string[]);
				result = {
					state: String(this.state),
					list: ids.filter((id) => this.emails.has(id)).map((id) => structuredClone(this.emails.get(id)!)),
					notFound: ids.filter((id) => !this.emails.has(id))
				};
			} else if (name === 'Email/changes') {
				result = this.changes(Number(args.sinceState), Number(args.maxChanges ?? 500));
			} else {
				throw new Error(`FakeMailbox does not answer ${name}`);
			}
			results[tag] = result;
			return [name, result, tag];
		});
		return { methodResponses, sessionState: 's' } as JMAPResponse;
	}
}

/**
 * Words that mean the same thing share a dimension, so "plumber" finds
 * "leaking pipe". Everything else is hashed into the remaining dimensions,
 * and every text shares one more, as real embeddings do: unrelated mail
 * scores low, not zero.
 */
const TOPICS: Record<string, string[]> = {
	plumbing: ['plumber', 'plumbing', 'pipe', 'pipes', 'leak', 'leaking', 'سباك', 'تسريب'],
	money: ['quote', 'estimate', 'invoice', 'price', 'cost', 'عرض', 'سعر', 'فاتورة'],
	travel: ['flight', 'airline', 'boarding', 'trip', 'رحلة', 'طيران'],
	school: ['school', 'teacher', 'homework', 'class', 'مدرسة'],
	news: ['weekly', 'newsletter', 'digest', 'نشرة']
};
const TOPIC_OF = new Map(Object.entries(TOPICS).flatMap(([topic, words], i) => words.map((w) => [w, i] as const)));
export const FAKE_DIMS = 32;
/** Prompt words every input carries; they say nothing about the topic. */
const PROMPT_WORDS = new Set(['task', 'search', 'result', 'query', 'title', 'text', 'none', 'from']);

export function fakeEmbedding(input: string): number[] {
	const v = new Array(FAKE_DIMS).fill(0);
	for (const word of input.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
		if (word.length < 3 || PROMPT_WORDS.has(word)) continue;
		const topic = TOPIC_OF.get(word);
		if (topic !== undefined) v[topic] += 3;
		else {
			let h = 0;
			for (const ch of word) h = (h * 31 + ch.codePointAt(0)!) >>> 0;
			v[Object.keys(TOPICS).length + (h % (FAKE_DIMS - 1 - Object.keys(TOPICS).length))] += 1;
		}
	}
	v[FAKE_DIMS - 1] += 2;
	return v;
}

export interface FakeOllama {
	/** Inputs of every /api/embed call that reached the model, in order, refused ones included. */
	requests: string[][];
	/** Set to make calls fail: a status, or 'down' for a refused connection. */
	failure: number | 'down' | null;
	/** A request with an input matching this gets a 400, like text the model can't take. */
	refuses: RegExp | null;
	/** Every other address answers with a redirect here, as a proxy in front of Ollama might. */
	redirectTo: string | null;
	fetch: typeof fetch;
}

/** A stand-in for `fetch` that answers /api/embed like Ollama does. */
export function fakeOllama(): FakeOllama {
	const fake: FakeOllama = {
		requests: [],
		failure: null,
		refuses: null,
		redirectTo: null,
		fetch: (async (url: string | URL, init?: RequestInit) => {
			if (!String(url).endsWith('/api/embed')) throw new Error(`unexpected fetch ${url}`);
			if (fake.redirectTo && String(url) !== fake.redirectTo) {
				return new Response(null, { status: 302, headers: { location: fake.redirectTo } });
			}
			if (fake.failure === 'down') throw new TypeError('fetch failed');
			if (typeof fake.failure === 'number') return new Response('model not found', { status: fake.failure });
			const body = JSON.parse(String(init?.body)) as { input: string[] };
			fake.requests.push(body.input);
			if (fake.refuses && body.input.some((text) => fake.refuses!.test(text))) {
				return new Response('{"error":"invalid input"}', { status: 400 });
			}
			return Response.json({ model: 'fake', embeddings: body.input.map(fakeEmbedding) });
		}) as typeof fetch
	};
	return fake;
}
