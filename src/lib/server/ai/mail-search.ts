/**
 * Translating a natural-language question into a mailbox search.
 *
 * The agent used to see only today's inbox, so "what did the accountant send
 * me last spring" was unanswerable. Rather than guess at dates with regexes,
 * the model is asked for a search plan first — it already understands "last
 * spring" — and this module turns that plan into a JMAP filter and nothing
 * else. Keeping the translation pure keeps it testable without a mail server,
 * and keeps the model's output from reaching JMAP unchecked.
 */

export interface MailSearchSpec {
	/** False when the question needs no mailbox lookup at all. */
	needed: boolean;
	/** Free-text terms matched across subject and body. */
	text: string | null;
	/** Sender name or address fragment. */
	from: string | null;
	/** Inclusive ISO date bound, oldest edge of the window. */
	after: string | null;
	/** Exclusive ISO date bound, newest edge of the window. */
	before: string | null;
	/** Restrict to messages that carry an attachment. */
	hasAttachment: boolean | null;
	/** How many messages the answer needs. */
	limit: number;
}

/** Ceiling on messages pulled into one answer, whatever the model asks for. */
export const MAX_SEARCH_RESULTS = 40;

/**
 * JSON schema handed to the model. Every field is required so the model
 * always states a value rather than omitting the ones it is unsure about —
 * an absent field and a deliberate null are not the same signal.
 */
export const MAIL_SEARCH_SCHEMA = {
	type: 'object',
	properties: {
		needed: { type: 'boolean' },
		text: { type: ['string', 'null'] },
		from: { type: ['string', 'null'] },
		after: { type: ['string', 'null'] },
		before: { type: ['string', 'null'] },
		hasAttachment: { type: ['boolean', 'null'] },
		limit: { type: 'integer' }
	},
	required: ['needed', 'text', 'from', 'after', 'before', 'hasAttachment', 'limit']
};

/** Accepts a bare date or a full timestamp; anything else is discarded. */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;

function cleanText(value: unknown, maxLength: number): string | null {
	if (typeof value !== 'string') return null;
	const trimmed = value.trim();
	return trimmed ? trimmed.slice(0, maxLength) : null;
}

/** Normalise to an instant JMAP accepts, or drop the bound entirely. */
function cleanDate(value: unknown): string | null {
	const raw = cleanText(value, 40);
	if (!raw || !ISO_DATE.test(raw)) return null;
	const parsed = new Date(raw.length === 10 ? `${raw}T00:00:00Z` : raw);
	return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

/**
 * Coerce the model's reply into a spec that is safe to act on.
 *
 * Anything unparseable degrades to "no constraint" rather than throwing: a
 * malformed date should widen the search, never fail the user's question.
 */
export function parseMailSearchSpec(raw: unknown): MailSearchSpec {
	const source = (raw ?? {}) as Record<string, unknown>;

	const limit = Number(source.limit);
	const after = cleanDate(source.after);
	const before = cleanDate(source.before);

	return {
		needed: source.needed !== false,
		text: cleanText(source.text, 200),
		from: cleanText(source.from, 200),
		// A backwards window matches nothing; treat it as unbounded instead of
		// silently returning zero results for a well-formed question.
		...(after && before && after >= before
			? { after: null, before: null }
			: { after, before }),
		// Only a literal true narrows the search. "false" would mean "only
		// messages without attachments", which no phrasing here asks for.
		hasAttachment: source.hasAttachment === true ? true : null,
		limit: Number.isFinite(limit) ? Math.min(Math.max(Math.trunc(limit), 1), MAX_SEARCH_RESULTS) : 15
	};
}

/**
 * Build the JMAP `Email/query` filter for a spec.
 *
 * Returns null when the spec carries no constraint at all — that would ask
 * the server for the entire mailbox newest-first, which is a slow way to
 * answer nothing in particular.
 *
 * No `inMailbox` condition is set, so the search spans every folder including
 * archive. That is the point: "all mail" means all mail.
 */
export function buildMailFilter(spec: MailSearchSpec): Record<string, unknown> | null {
	const conditions = mailFilterConditions(spec);
	if (!conditions.length) return null;
	if (conditions.length === 1) return conditions[0];
	return { operator: 'AND', conditions };
}

/** The spec's constraints as JMAP conditions, one each, for a caller that adds its own. */
export function mailFilterConditions(spec: MailSearchSpec): Record<string, unknown>[] {
	const conditions: Record<string, unknown>[] = [];
	if (spec.text) conditions.push({ text: spec.text });
	if (spec.from) conditions.push({ from: spec.from });
	if (spec.after) conditions.push({ after: spec.after });
	if (spec.before) conditions.push({ before: spec.before });
	if (spec.hasAttachment) conditions.push({ hasAttachment: true });
	return conditions;
}

/** One-line description of what was searched, for the reply's own context. */
export function describeMailSearch(spec: MailSearchSpec): string {
	const parts: string[] = [];
	if (spec.text) parts.push(`matching "${spec.text}"`);
	if (spec.from) parts.push(`from "${spec.from}"`);
	if (spec.after) parts.push(`on or after ${spec.after.slice(0, 10)}`);
	if (spec.before) parts.push(`before ${spec.before.slice(0, 10)}`);
	if (spec.hasAttachment) parts.push('with an attachment');
	return parts.length ? `Mail ${parts.join(', ')}` : 'Recent mail';
}


/**
 * The agent's tool loop.
 *
 * One search is often not enough: "did the accountant ever send the Q3
 * figures" may need a broad search, then a narrower one, then the body of a
 * specific message. Rather than a single fixed search, the model is given
 * tools and asked what to do next until it has enough.
 *
 * The protocol is plain JSON rather than the provider's native function
 * calling, because the model is operator-configured and native tool
 * support varies by model. Every model that can already honour the JSON
 * schemas used elsewhere here can drive this loop.
 */
export type MailToolName = 'search_mail' | 'open_email' | 'search_calendar' | 'done';

export interface MailToolCall {
	tool: MailToolName;
	/** Populated for search_mail. */
	search: MailSearchSpec;
	/** Populated for open_email — an id from an earlier search result. */
	emailId: string | null;
}

/**
 * Ceiling on tool calls per question. Each round is a model round-trip, so
 * this bounds both latency and the amount of mail one question can pull.
 */
export const MAX_TOOL_ROUNDS = 4;

export const MAIL_TOOL_SCHEMA = {
	type: 'object',
	properties: {
		tool: { type: 'string', enum: ['search_mail', 'open_email', 'search_calendar', 'done'] },
		text: { type: ['string', 'null'] },
		from: { type: ['string', 'null'] },
		after: { type: ['string', 'null'] },
		before: { type: ['string', 'null'] },
		hasAttachment: { type: ['boolean', 'null'] },
		limit: { type: 'integer' },
		emailId: { type: ['string', 'null'] }
	},
	required: ['tool', 'text', 'from', 'after', 'before', 'hasAttachment', 'limit', 'emailId']
};

/**
 * Coerce a tool call into something safe to execute.
 *
 * An unrecognised tool name, or an open_email with no id, resolves to `done`
 * rather than throwing — a confused model should end the loop and answer with
 * what it already has, not fail the user's question.
 */
export function parseMailToolCall(raw: unknown): MailToolCall {
	const source = (raw ?? {}) as Record<string, unknown>;
	const search = parseMailSearchSpec(source);
	const emailId = cleanText(source.emailId, 300);

	if (source.tool === 'search_mail') return { tool: 'search_mail', search, emailId };
	if (source.tool === 'open_email' && emailId) return { tool: 'open_email', search, emailId };
	// Calendar search reuses the after/before bounds from the same spec; an
	// unbounded one is handled by the caller, which supplies a default window.
	if (source.tool === 'search_calendar') return { tool: 'search_calendar', search, emailId: null };
	return { tool: 'done', search, emailId: null };
}
