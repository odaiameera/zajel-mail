import sanitizeHtml from 'sanitize-html';
import { MailAssistantError } from './mail-assistant';
import { assistantConfigured, runChat } from './chat';

/**
 * LLM-backed event extraction from unstructured email text, through the
 * shared chat transport: Claude's writer model when ANTHROPIC_API_KEY is
 * set, OpenAI when OPENAI_API_KEY is, otherwise the Ollama endpoint
 * (OLLAMA_URL / OLLAMA_API_KEY / OLLAMA_MODEL). The model must follow
 * JSON-schema output.
 *
 * Structured invitations (text/calendar parts) never go through here —
 * they're parsed deterministically by the iMIP module. This path only
 * handles prose like "let's grab dinner Thursday at 8".
 */

export interface ExtractedEvent {
	found: boolean;
	title: string;
	/** Local date YYYY-MM-DD (in the user's timezone). */
	date: string;
	/** HH:mm or null when the email names no time. */
	startTime: string | null;
	endTime: string | null;
	allDay: boolean;
	location: string | null;
	notes: string | null;
}

export function aiConfigured(): boolean {
	return assistantConfigured();
}

/** Strip an email's HTML down to readable text, capped for the prompt. */
export function htmlToPromptText(html: string, maxChars = 6000): string {
	const text = sanitizeHtml(html, {
		allowedTags: [],
		allowedAttributes: {}
	})
		.replace(/&nbsp;/g, ' ')
		.replace(/[ \t]+/g, ' ')
		.replace(/\n{3,}/g, '\n\n')
		.trim();
	return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
}

// JSON schema the model's answer is held to (Ollama's `format`, OpenAI's
// `text.format`), so even smaller models return parseable output.
const RESPONSE_SCHEMA = {
	type: 'object',
	properties: {
		found: { type: 'boolean' },
		title: { type: 'string' },
		date: { type: 'string' },
		startTime: { type: ['string', 'null'] },
		endTime: { type: ['string', 'null'] },
		allDay: { type: 'boolean' },
		location: { type: ['string', 'null'] },
		notes: { type: ['string', 'null'] }
	},
	required: ['found', 'title', 'date', 'allDay']
};

const SYSTEM_PROMPT = `You extract calendar event details from emails. Reply with JSON only, matching the schema you are given.

Rules:
- "found" is true only when the email proposes, announces or confirms a concrete meeting/appointment/event the recipient could put on a calendar. Newsletters, receipts, notifications, and vague "let's catch up sometime" are found=false.
- Resolve relative dates ("tomorrow", "next Thursday") against the email's sent date, which is provided. Dates are in the recipient's timezone.
- "date" must be YYYY-MM-DD. "startTime"/"endTime" must be 24h HH:mm or null. If no time is mentioned, set allDay=true and times to null. If only a start time is mentioned, leave endTime null.
- "title" is a short calendar-style summary (e.g. "Dinner with Sara"), not the email subject verbatim unless it fits.
- "location" only if a physical place or meeting link is named.
- "notes" is one short sentence of context, or null.
- Never invent details that are not in the email.`;

export class AIExtractionError extends Error {
	constructor(
		message: string,
		public status: number
	) {
		super(message);
		this.name = 'AIExtractionError';
	}
}

export async function extractEventFromEmail(input: {
	subject: string;
	bodyText: string;
	from: string;
	receivedAt: string;
	timeZone: string;
}): Promise<ExtractedEvent> {
	if (!aiConfigured()) {
		throw new AIExtractionError('AI extraction is not configured', 501);
	}

	const received = new Date(input.receivedAt);
	const receivedLabel = isNaN(received.getTime())
		? input.receivedAt
		: received.toLocaleString('en-US', {
				weekday: 'long',
				year: 'numeric',
				month: 'long',
				day: 'numeric',
				hour: '2-digit',
				minute: '2-digit',
				timeZone: input.timeZone
			});

	const userPrompt = [
		`Recipient timezone: ${input.timeZone}`,
		`Email sent: ${receivedLabel}`,
		`From: ${input.from}`,
		`Subject: ${input.subject || '(no subject)'}`,
		'',
		'Email body:',
		input.bodyText || '(empty)'
	].join('\n');

	let content: string;
	try {
		content = await runChat({
			system: SYSTEM_PROMPT,
			messages: [{ role: 'user', content: userPrompt }],
			temperature: 0,
			format: RESPONSE_SCHEMA
		});
	} catch (err) {
		if (err instanceof MailAssistantError) throw new AIExtractionError(err.message, err.status);
		throw err;
	}
	const parsed = parseModelJson(content);
	if (!parsed) {
		throw new AIExtractionError('The model returned an unreadable answer — try again', 502);
	}
	return normalize(parsed);
}

/** Tolerant JSON recovery: strip code fences, grab the outermost object. */
function parseModelJson(content: string): Record<string, unknown> | null {
	const stripped = content.replace(/```(?:json)?/g, '').trim();
	const start = stripped.indexOf('{');
	const end = stripped.lastIndexOf('}');
	if (start === -1 || end <= start) return null;
	try {
		const obj = JSON.parse(stripped.slice(start, end + 1));
		return obj && typeof obj === 'object' ? (obj as Record<string, unknown>) : null;
	} catch {
		return null;
	}
}

function normalize(raw: Record<string, unknown>): ExtractedEvent {
	const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
	const date = str(raw.date) ?? '';
	const validDate = /^\d{4}-\d{2}-\d{2}$/.test(date);
	const time = (v: unknown): string | null => {
		const s = str(v);
		if (!s) return null;
		const m = s.match(/^(\d{1,2}):(\d{2})/);
		if (!m) return null;
		const h = Math.min(23, +m[1]);
		return `${String(h).padStart(2, '0')}:${m[2]}`;
	};

	const startTime = time(raw.startTime);
	const endTime = time(raw.endTime);
	const found = raw.found === true && !!str(raw.title) && validDate;
	return {
		found,
		title: str(raw.title)?.slice(0, 200) ?? '',
		date,
		startTime,
		endTime,
		allDay: raw.allDay === true || startTime === null,
		location: str(raw.location)?.slice(0, 300) ?? null,
		notes: str(raw.notes)?.slice(0, 500) ?? null
	};
}
