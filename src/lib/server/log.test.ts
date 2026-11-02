import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const env = vi.hoisted(() => ({}) as Record<string, string | undefined>);
vi.mock('$env/dynamic/private', () => ({ env }));

import { errorFields, logEvent, resetLogForTests } from './log';

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'zajel-log-'));
	delete env.LOG_FILE;
	resetLogForTests();
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

function lines(file: string): Record<string, unknown>[] {
	return readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
}

describe('event log', () => {
	it('writes nothing without LOG_FILE', () => {
		logEvent('info', 'app', 'started');
		expect(existsSync(join(dir, 'zajel.log'))).toBe(false);
	});

	it('appends one JSON object per line, creating the folder', () => {
		const file = join(dir, 'logs', 'zajel.log');
		env.LOG_FILE = file;
		logEvent('info', 'app', 'started', { node: 'v24' });
		logEvent('error', 'agent', 'turn_failed', { status: 529 });
		const [first, second] = lines(file);
		expect(first).toMatchObject({ level: 'info', area: 'app', event: 'started', node: 'v24' });
		expect(typeof first.ts).toBe('string');
		expect(second).toMatchObject({ level: 'error', area: 'agent', event: 'turn_failed', status: 529 });
	});

	it('moves a full file to .1 and starts a new one', () => {
		const file = join(dir, 'zajel.log');
		writeFileSync(file, 'x'.repeat(10 * 1024 * 1024 - 10));
		env.LOG_FILE = file;
		logEvent('warn', 'jobs', 'run', { ok: false });
		expect(readFileSync(`${file}.1`, 'utf8').startsWith('xxx')).toBe(true);
		expect(lines(file)).toHaveLength(1);
	});

	it('keeps the status and request id of an API error', () => {
		const err = Object.assign(new Error('Overloaded'), { status: 529, requestID: 'req_123' });
		expect(errorFields(err)).toEqual({ error: 'Overloaded', errorType: 'Error', status: 529, requestId: 'req_123' });
		expect(errorFields('plain')).toEqual({ error: 'plain' });
	});
});
