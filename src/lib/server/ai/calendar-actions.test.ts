import { describe, expect, it } from 'vitest';
import {
	buildDeleteProposal,
	parseConfirmedProposal,
	parseCreateProposal,
	validTimeZone
} from './calendar-actions';

const TZ = 'Asia/Amman';

describe('parseCreateProposal', () => {
	it('accepts a well-formed timed event', () => {
		const proposal = parseCreateProposal(
			{
				action: 'create',
				title: 'Dentist',
				start: '2026-09-03T14:00',
				end: '2026-09-03T15:00',
				allDay: false,
				location: 'Clinic',
				description: 'Bring the referral'
			},
			TZ
		);

		expect(proposal?.action).toBe('create');
		expect(proposal?.event).toMatchObject({
			title: 'Dentist',
			start: '2026-09-03T14:00',
			end: '2026-09-03T15:00',
			allDay: false,
			timeZone: TZ,
			location: 'Clinic'
		});
	});

	it('defaults a missing end to an hour later', () => {
		const proposal = parseCreateProposal(
			{ title: 'Call', start: '2026-09-03T09:30', end: null, allDay: false },
			TZ
		);
		expect(proposal?.event?.end).toBe('2026-09-03T10:30');
	});

	it('rolls a defaulted end over midnight', () => {
		const proposal = parseCreateProposal(
			{ title: 'Late call', start: '2026-09-03T23:30', end: null, allDay: false },
			TZ
		);
		expect(proposal?.event?.end).toBe('2026-09-04T00:30');
	});

	it('defaults a missing all-day end to the following day, exclusive', () => {
		const proposal = parseCreateProposal(
			{ title: 'Leave', start: '2026-09-03', end: null, allDay: true },
			TZ
		);
		expect(proposal?.event?.end).toBe('2026-09-04');
	});

	describe('refuses rather than guesses', () => {
		it('rejects an event with no title', () => {
			expect(
				parseCreateProposal({ title: '  ', start: '2026-09-03T14:00', end: '2026-09-03T15:00' }, TZ)
			).toBeNull();
		});

		it('rejects a malformed start', () => {
			for (const start of ['next Tuesday', '2026-13-40T14:00', '2026-09-03', '']) {
				expect(
					parseCreateProposal({ title: 'X', start, end: '2026-09-03T15:00', allDay: false }, TZ)
				).toBeNull();
			}
		});

		it('rejects an end at or before the start', () => {
			for (const end of ['2026-09-03T14:00', '2026-09-03T13:00']) {
				expect(
					parseCreateProposal(
						{ title: 'X', start: '2026-09-03T14:00', end, allDay: false },
						TZ
					)
				).toBeNull();
			}
		});

		it('rejects a date where a timestamp is required, and vice versa', () => {
			expect(
				parseCreateProposal({ title: 'X', start: '2026-09-03', end: '2026-09-04', allDay: false }, TZ)
			).toBeNull();
			expect(
				parseCreateProposal(
					{ title: 'X', start: '2026-09-03T10:00', end: '2026-09-03T11:00', allDay: true },
					TZ
				)
			).toBeNull();
		});

		it('survives junk', () => {
			for (const junk of [null, undefined, 'nope', 42, []]) {
				expect(() => parseCreateProposal(junk, TZ)).not.toThrow();
				expect(parseCreateProposal(junk, TZ)).toBeNull();
			}
		});
	});

	it('falls back to UTC when the timezone is not real', () => {
		const proposal = parseCreateProposal(
			{ title: 'X', start: '2026-09-03T14:00', end: '2026-09-03T15:00', allDay: false },
			'Mars/Olympus'
		);
		expect(proposal?.event?.timeZone).toBe('UTC');
	});

	it('describes what will happen, with the all-day end shown inclusively', () => {
		expect(
			parseCreateProposal({ title: 'Leave', start: '2026-09-03', end: '2026-09-04', allDay: true }, TZ)
				?.summary
		).toBe('Create all-day event “Leave” on 2026-09-03');

		expect(
			parseCreateProposal(
				{ title: 'Standup', start: '2026-09-03T09:00', end: '2026-09-03T09:15', allDay: false },
				TZ
			)?.summary
		).toBe('Create “Standup” on 2026-09-03 at 09:00–09:15');
	});
});

describe('buildDeleteProposal', () => {
	it('names the event so the user confirms a thing, not an id', () => {
		const proposal = buildDeleteProposal({
			id: 'abc123',
			title: 'Dentist',
			start: '2026-09-03T14:00:00.000Z',
			allDay: false
		});
		expect(proposal.action).toBe('delete');
		expect(proposal.summary).toContain('Dentist');
		expect(proposal.target?.id).toBe('abc123');
	});

	it('still reads sensibly for an untitled event', () => {
		const proposal = buildDeleteProposal({
			id: 'x',
			title: '',
			start: '2026-09-03',
			allDay: true
		});
		expect(proposal.summary).toContain('(untitled event)');
	});

	it('names the occurrence of a repeating event, in its own zone, and carries it to the confirm step', () => {
		const proposal = buildDeleteProposal({
			id: 'series',
			title: 'Standup',
			start: '2026-11-03T22:30:00.000Z',
			allDay: false,
			recurrenceId: '2026-11-04T01:30:00',
			timeZone: 'Asia/Amman'
		});
		expect(proposal.target).toMatchObject({ id: 'series', recurrenceId: '2026-11-04T01:30:00' });
		expect(proposal.target?.start).toBe('04 Nov 2026, 01:30 (Asia/Amman) · this occurrence only');
		expect(proposal.summary).toContain('one occurrence of “Standup”');

		const confirmed = parseConfirmedProposal({ action: 'delete', target: proposal.target }, TZ);
		expect(confirmed?.target?.recurrenceId).toBe('2026-11-04T01:30:00');
		expect(parseConfirmedProposal({ action: 'delete', target: { id: 'series', recurrenceId: 'all of them' } }, TZ)?.target?.recurrenceId).toBeNull();
	});
});

describe('parseConfirmedProposal', () => {
	it('re-validates a create that round-tripped through the browser', () => {
		const proposal = parseConfirmedProposal(
			{
				action: 'create',
				event: {
					title: 'Dentist',
					start: '2026-09-03T14:00',
					end: '2026-09-03T15:00',
					allDay: false,
					timeZone: TZ
				}
			},
			'UTC'
		);
		expect(proposal?.event?.title).toBe('Dentist');
		expect(proposal?.event?.timeZone).toBe(TZ);
	});

	it('applies the same rules to a tampered payload as to the original', () => {
		// An end before the start was impossible to propose; it must also be
		// impossible to confirm.
		expect(
			parseConfirmedProposal(
				{
					action: 'create',
					event: { title: 'X', start: '2026-09-03T14:00', end: '2026-09-03T09:00', allDay: false }
				},
				TZ
			)
		).toBeNull();

		expect(
			parseConfirmedProposal(
				{ action: 'create', event: { title: '', start: '2026-09-03T14:00', end: '2026-09-03T15:00' } },
				TZ
			)
		).toBeNull();
	});

	it('requires an id to confirm a delete', () => {
		expect(parseConfirmedProposal({ action: 'delete', target: {} }, TZ)).toBeNull();
		expect(parseConfirmedProposal({ action: 'delete' }, TZ)).toBeNull();
		expect(parseConfirmedProposal({ action: 'delete', target: { id: 'e1' } }, TZ)?.target?.id).toBe(
			'e1'
		);
	});

	it('rejects an unknown action', () => {
		expect(parseConfirmedProposal({ action: 'update' }, TZ)).toBeNull();
		expect(parseConfirmedProposal({}, TZ)).toBeNull();
	});
});

describe('validTimeZone', () => {
	it('accepts real IANA zones and rejects the rest', () => {
		expect(validTimeZone('Asia/Amman')).toBe(true);
		expect(validTimeZone('UTC')).toBe(true);
		expect(validTimeZone('Mars/Olympus')).toBe(false);
		expect(validTimeZone('')).toBe(false);
	});
});
