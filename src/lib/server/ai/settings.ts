import { env } from '$env/dynamic/private';
import { getDb } from '$lib/server/db/index';
import { errorFields, logEvent } from '$lib/server/log';

/**
 * Which AI the server uses, as chosen in Settings → Agent. Each value wins
 * over its environment variable, which wins over the built-in default; null
 * means "not chosen". API keys are not settings: they stay in the
 * environment, and a provider can only be chosen once its key is there.
 */

export const PROVIDERS = ['anthropic', 'openai', 'ollama'] as const;
export type ProviderName = (typeof PROVIDERS)[number];

export const EFFORTS = ['low', 'medium', 'high'] as const;
export type Effort = (typeof EFFORTS)[number];

export interface AiSettings {
	provider: ProviderName | null;
	agentModel: string | null;
	writerModel: string | null;
	agentEffort: Effort | null;
	openaiModel: string | null;
	ollamaModel: string | null;
	/** Semantic search's Ollama, over EMBED_URL. */
	embedUrl: string | null;
	/** Semantic search's model, over EMBED_MODEL. */
	embedModel: string | null;
}

const NONE: AiSettings = {
	provider: null,
	agentModel: null,
	writerModel: null,
	agentEffort: null,
	openaiModel: null,
	ollamaModel: null,
	embedUrl: null,
	embedModel: null
};

/**
 * Model ids as providers name them (claude-opus-5-5, gpt-5.6-luna,
 * library/qwen3:8b): letters, digits and . _ : - in /-separated parts, each
 * starting with a letter or digit, so an id can't be "." or ".." in a URL.
 */
export const MODEL_ID = /^(?=.{1,100}$)[A-Za-z0-9][A-Za-z0-9._:-]*(\/[A-Za-z0-9][A-Za-z0-9._:-]*)*$/;

// Read on every AI call, written only from Settings, and there is one
// process: so the row is cached here and the cache is replaced on save.
let cached: AiSettings | null = null;
/** The one repair attempt per process; see `repairAiSettingsColumns`. */
let repaired = false;

export function aiSettings(): AiSettings {
	if (cached) return cached;
	try {
		const row = getDb()
			.prepare(
				'SELECT provider, agent_model, writer_model, agent_effort, openai_model, ollama_model, embed_url, embed_model FROM ai_settings WHERE id = 1'
			)
			.get() as Record<string, string | null> | undefined;
		cached = {
			provider: PROVIDERS.includes(row?.provider as ProviderName) ? (row!.provider as ProviderName) : null,
			agentModel: row?.agent_model ?? null,
			writerModel: row?.writer_model ?? null,
			agentEffort: EFFORTS.includes(row?.agent_effort as Effort) ? (row!.agent_effort as Effort) : null,
			openaiModel: row?.openai_model ?? null,
			ollamaModel: row?.ollama_model ?? null,
			embedUrl: row?.embed_url ?? null,
			embedModel: row?.embed_model ?? null
		};
		return cached;
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		// Before migrations have run (the table doesn't exist yet): nothing
		// is chosen, and the next call reads again.
		if (message.includes('no such table')) return NONE;
		if (message.includes('no such column') && !repaired) {
			repaired = true;
			const added = repairAiSettingsColumns();
			if (added.length) {
				logEvent('warn', 'ai', 'settings_repaired', { added: added.join(',') });
				return aiSettings();
			}
		}
		// Every setting reads as "not chosen" until this is fixed, so say so.
		logEvent('error', 'ai', 'settings_unreadable', errorFields(err));
		return NONE;
	}
}

/** Columns migration 026 gained after it first shipped. */
const LATE_COLUMNS = ['embed_url', 'embed_model'];

/**
 * Add the columns a database is missing because its migration 026 ran before
 * they were in it: migrations run once, by name, so editing one afterwards
 * leaves every database that already ran it behind. Returns what was added.
 */
export function repairAiSettingsColumns(): string[] {
	const db = getDb();
	const present = new Set((db.pragma('table_info(ai_settings)') as { name: string }[]).map((c) => c.name));
	const added = LATE_COLUMNS.filter((column) => !present.has(column));
	for (const column of added) db.exec(`ALTER TABLE ai_settings ADD COLUMN ${column} TEXT`);
	return added;
}

export function saveAiSettings(next: AiSettings): void {
	getDb()
		.prepare(
			`INSERT INTO ai_settings (id, provider, agent_model, writer_model, agent_effort, openai_model, ollama_model, embed_url, embed_model, updated_at)
			 VALUES (1, @provider, @agentModel, @writerModel, @agentEffort, @openaiModel, @ollamaModel, @embedUrl, @embedModel, datetime('now'))
			 ON CONFLICT(id) DO UPDATE SET
			   provider = excluded.provider, agent_model = excluded.agent_model, writer_model = excluded.writer_model,
			   agent_effort = excluded.agent_effort, openai_model = excluded.openai_model, ollama_model = excluded.ollama_model,
			   embed_url = excluded.embed_url, embed_model = excluded.embed_model,
			   updated_at = excluded.updated_at`
		)
		.run(next);
	cached = { ...next };
}

/** Providers whose key (or, for Ollama, endpoint) is in the environment. */
export function availableProviders(): ProviderName[] {
	return PROVIDERS.filter((p) =>
		p === 'anthropic' ? !!env.ANTHROPIC_API_KEY : p === 'openai' ? !!env.OPENAI_API_KEY : !!(env.OLLAMA_URL || env.OLLAMA_API_KEY)
	);
}

/** The chosen provider, if one is chosen and still has its key. */
export function chosenProvider(): ProviderName | null {
	const chosen = aiSettings().provider;
	return chosen && availableProviders().includes(chosen) ? chosen : null;
}

/** For tests: drop the cached row, and allow another repair. */
export function forgetAiSettingsForTests(): void {
	cached = null;
	repaired = false;
}
