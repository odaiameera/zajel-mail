import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { env } from '$env/dynamic/private';

/**
 * An event log for something watching the server from outside (a monitoring
 * agent, `tail -f`), written to LOG_FILE as one JSON object per line:
 *
 *   {"ts":"…","level":"error","area":"agent","event":"turn_failed","status":529,…}
 *
 * Nothing is written unless LOG_FILE is set. Mail content never goes in:
 * no subjects, bodies, prompts or replies, only what happened, how long it
 * took and why it failed. The console keeps its own lines for `docker logs`.
 *
 * At 10 MB the file moves to `<LOG_FILE>.1`, replacing the previous one.
 */

export type LogLevel = 'info' | 'warn' | 'error';

const MAX_BYTES = 10 * 1024 * 1024;

// undefined = not opened yet, null = off (unset or unusable).
let path: string | null | undefined;
let size = 0;

function open(): string | null {
	if (path !== undefined) return path;
	const configured = env.LOG_FILE?.trim();
	if (!configured) return (path = null);
	try {
		mkdirSync(dirname(configured), { recursive: true });
		size = fileSize(configured);
		path = configured;
	} catch (err) {
		console.error(`[log] LOG_FILE ${configured} can't be written: ${err instanceof Error ? err.message : err}`);
		path = null;
	}
	return path;
}

function fileSize(file: string): number {
	try {
		return statSync(file).size;
	} catch {
		return 0;
	}
}

export function logEvent(level: LogLevel, area: string, event: string, fields: Record<string, unknown> = {}): void {
	const file = open();
	if (!file) return;
	const line = `${JSON.stringify({ ts: new Date().toISOString(), level, area, event, ...fields })}\n`;
	try {
		if (size > 0 && size + line.length > MAX_BYTES) {
			renameSync(file, `${file}.1`);
			size = 0;
		}
		appendFileSync(file, line);
		size += Buffer.byteLength(line);
	} catch {
		// A full disk or a deleted directory must not break the request that
		// was being logged.
	}
}

/** The parts of an error worth logging: its message, and the HTTP status and request id when an API returned them. */
export function errorFields(err: unknown): Record<string, unknown> {
	if (!(err instanceof Error)) return { error: String(err).slice(0, 300) };
	const fields: Record<string, unknown> = { error: err.message.slice(0, 300), errorType: err.name };
	const extra = err as { status?: unknown; requestID?: unknown };
	if (typeof extra.status === 'number') fields.status = extra.status;
	if (typeof extra.requestID === 'string') fields.requestId = extra.requestID;
	return fields;
}

/** For tests: forget the opened file so the next event reads LOG_FILE again. */
export function resetLogForTests(): void {
	path = undefined;
	size = 0;
}
