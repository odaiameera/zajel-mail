import { env } from '$env/dynamic/private';
import { aiSettings } from '$lib/server/ai/settings';

/**
 * Text embeddings from an Ollama endpoint on the operator's own server.
 *
 * Deliberately separate from the chat assistant's OLLAMA_URL, which defaults
 * to Ollama Cloud: indexing sends every message's text to this endpoint, so it
 * is only ever the one Settings → Assistant or EMBED_URL names, and nothing is
 * indexed until one does.
 */

/** Small, multilingual (Arabic included), 768 dimensions. Settings or EMBED_MODEL pick another. */
export const DEFAULT_EMBED_MODEL = 'embeddinggemma-2:270m';

export interface EmbedSettings {
	url: string;
	model: string;
}

/** Settings → Assistant first, then the environment, then the built-in model. */
export function embedSettings(): EmbedSettings | null {
	const chosen = aiSettings();
	const url = (chosen.embedUrl || env.EMBED_URL)?.trim().replace(/\/+$/, '');
	if (!url) return null;
	return { url, model: chosen.embedModel || env.EMBED_MODEL?.trim() || DEFAULT_EMBED_MODEL };
}

/**
 * An endpoint as Settings stores it: http or https, no credentials, query or
 * fragment, trailing slashes trimmed. Null when it isn't one.
 */
export function cleanEmbedUrl(value: string): string | null {
	if (value.length > 200) return null;
	let url: URL;
	try {
		url = new URL(value.trim());
	} catch {
		return null;
	}
	if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
	if (url.username || url.password || url.search || url.hash) return null;
	return `${url.origin}${url.pathname}`.replace(/\/+$/, '');
}

/**
 * Retrieval models are trained with a different prefix on the question than
 * on the documents. Known families get theirs; EMBED_QUERY_PREFIX and
 * EMBED_DOCUMENT_PREFIX set them for any other model.
 */
interface PromptStyle {
	query(text: string): string;
	document(title: string, text: string): string;
}

const PLAIN: PromptStyle = {
	query: (text) => text,
	document: (title, text) => (title ? `${title}\n${text}` : text)
};

const STYLES: [RegExp, PromptStyle][] = [
	[
		/^embeddinggemma/,
		{
			query: (text) => `task: search result | query: ${text}`,
			document: (title, text) => `title: ${title || 'none'} | text: ${text}`
		}
	],
	[
		/^nomic-embed-text/,
		{
			query: (text) => `search_query: ${text}`,
			document: (title, text) => `search_document: ${title ? `${title}\n` : ''}${text}`
		}
	],
	[
		/^qwen3-embedding/,
		{
			query: (text) => `Instruct: Given a search query, retrieve emails that answer it\nQuery: ${text}`,
			document: PLAIN.document
		}
	],
	[
		/^mxbai-embed-large/,
		{
			query: (text) => `Represent this sentence for searching relevant passages: ${text}`,
			document: PLAIN.document
		}
	]
];

export function promptStyle(model: string): PromptStyle {
	const queryPrefix = env.EMBED_QUERY_PREFIX;
	const documentPrefix = env.EMBED_DOCUMENT_PREFIX;
	if (queryPrefix !== undefined || documentPrefix !== undefined) {
		return {
			query: (text) => `${queryPrefix ?? ''}${text}`,
			document: (title, text) => `${documentPrefix ?? ''}${PLAIN.document(title, text)}`
		};
	}
	const name = model.toLowerCase().replace(/^.*\//, '');
	return STYLES.find(([pattern]) => pattern.test(name))?.[1] ?? PLAIN;
}

export class EmbedError extends Error {
	constructor(
		message: string,
		readonly status?: number
	) {
		super(message);
		this.name = 'EmbedError';
	}
}

/** Scale to unit length, so a dot product is the cosine. */
export function normalize(values: ArrayLike<number>): Float32Array {
	const out = Float32Array.from(values);
	let sum = 0;
	for (let i = 0; i < out.length; i++) sum += out[i] * out[i];
	const norm = Math.sqrt(sum);
	if (norm > 0) for (let i = 0; i < out.length; i++) out[i] /= norm;
	return out;
}

/** Redirects followed before giving up. */
const MAX_REDIRECTS = 3;

/**
 * POST `body` to `url`, following redirects only within the same host. A
 * redirect elsewhere would send the mail's text somewhere the operator never
 * named, so it is refused and reported instead.
 */
async function post(url: string, body: string, timeoutMs: number): Promise<Response> {
	const signal = AbortSignal.timeout(timeoutMs);
	for (let hop = 0; ; hop++) {
		const response = await fetch(url, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body,
			signal,
			redirect: 'manual'
		});
		if (response.status < 300 || response.status > 399) return response;
		let next: URL | null = null;
		try {
			const location = response.headers.get('location');
			if (location) next = new URL(location, url);
		} catch {
			// A destination that isn't an address is no destination.
		}
		if (!next) throw new EmbedError(`${response.status} from /api/embed with nowhere to go`);
		if (next.host !== new URL(url).host) {
			throw new EmbedError(`Redirects to ${next.host}: set the endpoint to the address it should use`);
		}
		if (hop >= MAX_REDIRECTS) throw new EmbedError('Too many redirects');
		url = next.href;
	}
}

/**
 * Embed `inputs` (already prompted) in one `/api/embed` call. Throws
 * EmbedError when the endpoint is unset, unreachable or answers badly.
 */
export async function embed(inputs: string[], timeoutMs: number): Promise<Float32Array[]> {
	const settings = embedSettings();
	if (!settings) throw new EmbedError('EMBED_URL is not set');
	if (inputs.length === 0) return [];

	let response: Response;
	try {
		response = await post(`${settings.url}/api/embed`, JSON.stringify({ model: settings.model, input: inputs, truncate: true }), timeoutMs);
	} catch (err) {
		if (err instanceof EmbedError) throw err;
		const timedOut = err instanceof Error && err.name === 'TimeoutError';
		throw new EmbedError(timedOut ? `No answer within ${timeoutMs} ms` : `Unreachable: ${err instanceof Error ? err.message : err}`);
	}
	if (!response.ok) {
		const detail = await response.text().catch(() => '');
		throw new EmbedError(`${response.status} from /api/embed${detail ? `: ${detail.slice(0, 200)}` : ''}`, response.status);
	}

	const data = (await response.json().catch(() => null)) as { embeddings?: unknown } | null;
	const rows = data?.embeddings;
	if (!Array.isArray(rows) || rows.length !== inputs.length) {
		throw new EmbedError('The endpoint returned no embeddings for this input');
	}
	const vectors = rows.map((row) => {
		if (!Array.isArray(row) || row.length === 0 || !row.every((x) => typeof x === 'number')) {
			throw new EmbedError('The endpoint returned a malformed embedding');
		}
		return normalize(row as number[]);
	});
	if (vectors.some((v) => v.length !== vectors[0].length)) {
		throw new EmbedError('The endpoint returned embeddings of different sizes');
	}
	return vectors;
}
