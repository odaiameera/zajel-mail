import { claudeConfigured, runClaudeWriting } from './claude';
import { mailAssistantConfigured, runAIChat, type AIChatMessage } from './mail-assistant';

/**
 * One way in for every AI call that isn't the tool-using agent: Claude's
 * writer model when an Anthropic key is set, otherwise OpenAI or Ollama as
 * before.
 */

export function assistantConfigured(): boolean {
	return claudeConfigured() || mailAssistantConfigured();
}

export function runChat(input: {
	system: string;
	messages: AIChatMessage[];
	temperature?: number;
	format?: Record<string, unknown>;
}): Promise<string> {
	return claudeConfigured() ? runClaudeWriting(input) : runAIChat(input);
}
