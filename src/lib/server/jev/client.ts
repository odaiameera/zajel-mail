import { env } from '$env/dynamic/private';
import { mockJev } from './mock';
import type { JevAnswer, JevQuestion, JevResponse } from './types';

/**
 * TypeSafe's decision endpoint, called with plain `fetch` the way the app
 * already talks to Ollama and the task apps. The API key is read here and
 * nowhere else, and never reaches the browser.
 */

const DEFAULT_BASE_URL = 'https://api.typesafe.ai';

/**
 * A pinned version, not `jev-latest`: TypeSafe moves the alias on each
 * release, and confidence thresholds are tuned against one version's
 * answers. Setting JEV_MODEL changes it without a code change.
 */
const DEFAULT_MODEL = 'jev-1.13.0';

/** US dollars per million input tokens; output is free. */
export const PRICE_PER_MILLION_INPUT_TOKENS = 0.042;

const TIMEOUT_MS = 30_000;
const MAX_RETRIES = 2;
const MAX_RETRY_DELAY_MS = 10_000;

/**
 * `live` calls TypeSafe; `mock` answers locally from the facts we send and
 * labels every answer as such; `off` means neither is configured.
 */
export type JevMode = 'live' | 'mock' | 'off';

export function jevMode(): JevMode {
	if (env.JEV_MOCK === '1' || env.JEV_MOCK === 'true') return 'mock';
	return env.TYPESAFE_API_KEY ? 'live' : 'off';
}

export function jevModel(): string {
	return env.JEV_MODEL || DEFAULT_MODEL;
}

function baseUrl(): string {
	return (env.TYPESAFE_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, '');
}

export function costUsd(inputTokens: number): number {
	return (inputTokens / 1_000_000) * PRICE_PER_MILLION_INPUT_TOKENS;
}

export class JevError extends Error {
	constructor(
		message: string,
		public status: number,
		/** TypeSafe's own status when it answered with an error; null when it couldn't be reached or read. */
		public upstream: number | null = null
	) {
		super(message);
		this.name = 'JevError';
	}
}

/**
 * Browser-safe text for an upstream failure, built only from our own
 * configuration. TypeSafe's response body goes to the server log instead.
 */
function errorMessage(status: number): string {
	if (status === 401 || status === 403) return 'TypeSafe rejected the API key';
	if (status === 404) return `TypeSafe does not serve the model "${jevModel()}" — set JEV_MODEL to one it does`;
	if (status === 429) return 'TypeSafe is rate limiting this account — try again shortly';
	return `TypeSafe returned an error (${status})`;
}

function retryDelay(response: Response, attempt: number): number {
	const seconds = Number(response.headers.get('retry-after'));
	const ms = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 500 * 2 ** attempt;
	return Math.min(ms, MAX_RETRY_DELAY_MS);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function parseResponse(data: unknown): JevResponse {
	const body = data as {
		model?: unknown;
		answers?: unknown;
		usage?: { input_tokens?: unknown; output_tokens?: unknown };
	} | null;
	if (!body || typeof body.answers !== 'object' || body.answers === null) {
		throw new JevError('TypeSafe returned an answer the app could not read', 502);
	}
	return {
		model: typeof body.model === 'string' ? body.model : jevModel(),
		answers: body.answers as Record<string, JevAnswer>,
		usage: {
			inputTokens: Number(body.usage?.input_tokens) || 0,
			outputTokens: Number(body.usage?.output_tokens) || 0
		},
		mock: false
	};
}

/**
 * Ask Jev a set of questions about one state. 429 and 529 (overloaded) are
 * retried with backoff, honouring `retry-after`; anything else fails at
 * once with a {@link JevError}.
 */
export async function askJev(
	state: unknown,
	questions: Record<string, JevQuestion>
): Promise<JevResponse> {
	const mode = jevMode();
	if (mode === 'off') throw new JevError('Jev is not configured', 501);
	if (mode === 'mock') return mockJev(state, questions);

	for (let attempt = 0; ; attempt++) {
		let response: Response;
		try {
			response = await fetch(`${baseUrl()}/v1/systemone`, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					Authorization: `Bearer ${env.TYPESAFE_API_KEY}`
				},
				body: JSON.stringify({ model: jevModel(), state, questions }),
				signal: AbortSignal.timeout(TIMEOUT_MS)
			});
		} catch (err) {
			const timeout = err instanceof Error && err.name === 'TimeoutError';
			throw new JevError(timeout ? 'Jev took too long to answer' : 'Could not reach TypeSafe', 502);
		}

		if ((response.status === 429 || response.status === 529) && attempt < MAX_RETRIES) {
			await sleep(retryDelay(response, attempt));
			continue;
		}

		if (!response.ok) {
			const detail = await response.text().catch(() => '');
			console.warn(
				`[jev] ${baseUrl()}/v1/systemone ${response.status} for model ${jevModel()}: ${detail.slice(0, 300)}`
			);
			throw new JevError(errorMessage(response.status), response.status === 429 ? 429 : 502, response.status);
		}

		return parseResponse(await response.json().catch(() => null));
	}
}
