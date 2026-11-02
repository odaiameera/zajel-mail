import { describe, expect, it } from 'vitest';
import {
	buildMailFilter,
	describeMailSearch,
	mailFilterConditions,
	MAX_SEARCH_RESULTS,
	parseMailSearchSpec,
	parseMailToolCall
} from './mail-search';

describe('parseMailSearchSpec', () => {
	it('keeps a well-formed plan', () => {
		expect(
			parseMailSearchSpec({
				needed: true,
				text: 'invoice',
				from: 'accounts@vendor.example',
				after: '2025-03-01',
				before: '2025-06-01',
				limit: 20
			})
		).toEqual({
			needed: true,
			text: 'invoice',
			from: 'accounts@vendor.example',
			after: '2025-03-01T00:00:00.000Z',
			before: '2025-06-01T00:00:00.000Z',
			hasAttachment: null,
			limit: 20
		});
	});

	it('normalises a bare date to an instant JMAP accepts', () => {
		expect(parseMailSearchSpec({ after: '2024-01-15' }).after).toBe('2024-01-15T00:00:00.000Z');
	});

	it('drops unparseable dates instead of failing the question', () => {
		const spec = parseMailSearchSpec({ after: 'last spring', before: '??' });
		expect(spec.after).toBeNull();
		expect(spec.before).toBeNull();
	});

	it('unbounds a backwards window rather than matching nothing', () => {
		const spec = parseMailSearchSpec({ after: '2025-06-01', before: '2025-03-01' });
		expect(spec.after).toBeNull();
		expect(spec.before).toBeNull();
	});

	it('caps the result count however many the model asks for', () => {
		expect(parseMailSearchSpec({ limit: 5000 }).limit).toBe(MAX_SEARCH_RESULTS);
		expect(parseMailSearchSpec({ limit: 0 }).limit).toBe(1);
		expect(parseMailSearchSpec({ limit: 'lots' }).limit).toBe(15);
	});

	it('treats a missing needed flag as "search anyway"', () => {
		expect(parseMailSearchSpec({}).needed).toBe(true);
		expect(parseMailSearchSpec({ needed: false }).needed).toBe(false);
	});

	it('survives junk from the model', () => {
		for (const junk of [null, undefined, 'nope', 42, []]) {
			expect(() => parseMailSearchSpec(junk)).not.toThrow();
		}
		expect(parseMailSearchSpec({ text: 123, from: {} }).text).toBeNull();
	});

	it('truncates overlong terms', () => {
		expect(parseMailSearchSpec({ text: 'x'.repeat(500) }).text).toHaveLength(200);
	});
});

describe('buildMailFilter', () => {
	const base = parseMailSearchSpec({ needed: true, limit: 10 });

	it('returns a bare condition when only one constraint is set', () => {
		expect(buildMailFilter({ ...base, text: 'renewal' })).toEqual({ text: 'renewal' });
	});

	it('ANDs several constraints', () => {
		const filter = buildMailFilter(
			parseMailSearchSpec({ text: 'invoice', from: 'vendor', after: '2025-01-01', limit: 10 })
		);
		expect(filter).toEqual({
			operator: 'AND',
			conditions: [
				{ text: 'invoice' },
				{ from: 'vendor' },
				{ after: '2025-01-01T00:00:00.000Z' }
			]
		});
	});

	it('never constrains by mailbox, so archived mail is searchable', () => {
		const filter = buildMailFilter(parseMailSearchSpec({ text: 'anything', limit: 5 }));
		expect(JSON.stringify(filter)).not.toContain('inMailbox');
	});

	it('is null when nothing was constrained', () => {
		expect(buildMailFilter(base)).toBeNull();
	});

	it('hands out the conditions one by one, for a caller that adds its own', () => {
		expect(mailFilterConditions(parseMailSearchSpec({ text: 'invoice', after: '2025-01-01', unread_only: true }))).toEqual([
			{ text: 'invoice' },
			{ after: '2025-01-01T00:00:00.000Z' }
		]);
		expect(mailFilterConditions(base)).toEqual([]);
	});
});

describe('describeMailSearch', () => {
	it('describes what was actually searched', () => {
		const spec = parseMailSearchSpec({ text: 'lease', from: 'landlord', after: '2024-02-01' });
		const description = describeMailSearch(spec);
		expect(description).toContain('"lease"');
		expect(description).toContain('"landlord"');
		expect(description).toContain('2024-02-01');
	});

	it('falls back to a plain label with no constraints', () => {
		expect(describeMailSearch(parseMailSearchSpec({}))).toBe('Recent mail');
	});
});

describe('hasAttachment', () => {
	it('narrows only on a literal true', () => {
		expect(parseMailSearchSpec({ hasAttachment: true }).hasAttachment).toBe(true);
		// "false" would mean "only messages WITHOUT attachments" — not a thing
		// any phrasing asks for, so it must not become a filter condition.
		for (const value of [false, 'true', 1, null, undefined]) {
			expect(parseMailSearchSpec({ hasAttachment: value }).hasAttachment).toBeNull();
		}
	});

	it('reaches the JMAP filter', () => {
		const filter = buildMailFilter(parseMailSearchSpec({ text: 'report', hasAttachment: true }));
		expect(filter).toEqual({
			operator: 'AND',
			conditions: [{ text: 'report' }, { hasAttachment: true }]
		});
	});
});

describe('parseMailToolCall', () => {
	it('reads a search call with its arguments', () => {
		const call = parseMailToolCall({
			tool: 'search_mail',
			text: 'Q3 figures',
			from: 'accountant',
			after: '2025-07-01',
			limit: 25
		});
		expect(call.tool).toBe('search_mail');
		expect(call.search.text).toBe('Q3 figures');
		expect(call.search.after).toBe('2025-07-01T00:00:00.000Z');
		expect(call.search.limit).toBe(25);
	});

	it('reads an open call', () => {
		const call = parseMailToolCall({ tool: 'open_email', emailId: 'M9f2' });
		expect(call.tool).toBe('open_email');
		expect(call.emailId).toBe('M9f2');
	});

	it('ends the loop rather than acting on a confused call', () => {
		// An unknown tool, or an open with nothing to open, must not throw and
		// must not be executed — the agent answers from what it already has.
		expect(parseMailToolCall({ tool: 'delete_everything' }).tool).toBe('done');
		expect(parseMailToolCall({ tool: 'open_email', emailId: null }).tool).toBe('done');
		expect(parseMailToolCall({ tool: 'open_email', emailId: '  ' }).tool).toBe('done');
		expect(parseMailToolCall({}).tool).toBe('done');
		expect(parseMailToolCall(null).tool).toBe('done');
	});

	it('does not carry an id on a done call', () => {
		expect(parseMailToolCall({ tool: 'done', emailId: 'M1' }).emailId).toBeNull();
	});

	it('caps a search call the same way a plan is capped', () => {
		expect(parseMailToolCall({ tool: 'search_mail', limit: 9999 }).search.limit).toBe(
			MAX_SEARCH_RESULTS
		);
	});
});
