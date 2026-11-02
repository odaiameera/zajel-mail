import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const env = vi.hoisted(() => ({}) as Record<string, string | undefined>);
vi.mock('$env/dynamic/private', () => ({ env }));
const logEvent = vi.hoisted(() => vi.fn());
vi.mock('$lib/server/log', () => ({
	logEvent,
	errorFields: (err: unknown) => ({ error: err instanceof Error ? err.message : String(err) }),
	resetLogForTests: () => {}
}));

import { getDb } from '../db/index';
import { runMigrations } from '../db/migrate';
import {
	aiSettings,
	availableProviders,
	chosenProvider,
	forgetAiSettingsForTests,
	repairAiSettingsColumns,
	saveAiSettings,
	type AiSettings
} from './settings';
import { agentEffort, agentModel, claudeConfigured, writerModel } from './claude';
import { aiModel, aiProvider } from './mail-assistant';

const NONE: AiSettings = { provider: null, agentModel: null, writerModel: null, agentEffort: null, openaiModel: null, ollamaModel: null, embedUrl: null, embedModel: null };

beforeAll(() => runMigrations());

beforeEach(() => {
	for (const key of Object.keys(env)) delete env[key];
	getDb().exec('DELETE FROM ai_settings');
	forgetAiSettingsForTests();
});

describe('AI settings', () => {
	it('starts with nothing chosen and saves what is', () => {
		expect(aiSettings()).toEqual(NONE);
		saveAiSettings({ ...NONE, provider: 'openai', openaiModel: 'gpt-5.6-luna' });
		forgetAiSettingsForTests();
		expect(aiSettings()).toMatchObject({ provider: 'openai', openaiModel: 'gpt-5.6-luna' });
	});

	it('offers only providers with a key, and ignores a choice whose key is gone', () => {
		env.ANTHROPIC_API_KEY = 'sk-ant';
		env.OLLAMA_URL = 'http://ollama:11434';
		expect(availableProviders()).toEqual(['anthropic', 'ollama']);
		saveAiSettings({ ...NONE, provider: 'openai' });
		expect(chosenProvider()).toBeNull();
		saveAiSettings({ ...NONE, provider: 'ollama' });
		expect(chosenProvider()).toBe('ollama');
	});

	it('puts a chosen provider ahead of AI_PROVIDER', () => {
		env.ANTHROPIC_API_KEY = 'sk-ant';
		env.OPENAI_API_KEY = 'sk-oai';
		expect(claudeConfigured()).toBe(true);
		saveAiSettings({ ...NONE, provider: 'openai' });
		expect(claudeConfigured()).toBe(false);
		expect(aiProvider()).toBe('openai');
		env.AI_PROVIDER = 'openai';
		saveAiSettings({ ...NONE, provider: 'anthropic' });
		expect(claudeConfigured()).toBe(true);
	});

	it('takes models and effort from settings, then the environment, then the defaults', () => {
		env.ANTHROPIC_API_KEY = 'sk-ant';
		expect([agentModel(), writerModel(), agentEffort()]).toEqual(['claude-opus-5-5', 'claude-haiku-5-5', 'medium']);
		env.ANTHROPIC_MODEL = 'claude-sonnet-5-5';
		expect(agentModel()).toBe('claude-sonnet-5-5');
		saveAiSettings({ ...NONE, agentModel: 'claude-fable-5-1', writerModel: 'claude-sonnet-5-5', agentEffort: 'high' });
		expect([agentModel(), writerModel(), agentEffort()]).toEqual(['claude-fable-5-1', 'claude-sonnet-5-5', 'high']);
	});

	it('lets AI_PROVIDER pick Ollama even with an OpenAI key, and settings pick its model', () => {
		env.OPENAI_API_KEY = 'sk-oai';
		env.OLLAMA_URL = 'http://ollama:11434';
		expect(aiProvider()).toBe('openai');
		env.AI_PROVIDER = 'ollama';
		expect(aiProvider()).toBe('ollama');
		saveAiSettings({ ...NONE, ollamaModel: 'qwen3:8b' });
		expect(aiModel()).toBe('qwen3:8b');
	});

	it('repairs a database whose migration 026 ran before the embed columns were in it, and says so', () => {
		const db = getDb();
		db.exec('ALTER TABLE ai_settings DROP COLUMN embed_url; ALTER TABLE ai_settings DROP COLUMN embed_model');
		db.prepare(`INSERT INTO ai_settings (id, provider) VALUES (1, 'openai')`).run();
		forgetAiSettingsForTests();
		logEvent.mockClear();
		// Used to read as nothing chosen at all, silently.
		expect(aiSettings()).toMatchObject({ provider: 'openai', embedUrl: null });
		expect(logEvent).toHaveBeenCalledWith('warn', 'ai', 'settings_repaired', { added: 'embed_url,embed_model' });
		expect(repairAiSettingsColumns()).toEqual([]);
		saveAiSettings({ ...NONE, provider: 'openai', embedUrl: 'http://ollama:11434' });
		forgetAiSettingsForTests();
		expect(aiSettings().embedUrl).toBe('http://ollama:11434');
	});
});
