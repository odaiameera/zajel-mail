import { describe, expect, it } from 'vitest';
import { ICONS } from './icons';

describe('icons', () => {
	it('draws Move up and Move down as arrows, not as the chevrons that open and close a row', () => {
		const chevrons = [ICONS.expand, ICONS.dropdown, ICONS.next, ICONS.restore];
		expect(chevrons).not.toContain(ICONS['move-up']);
		expect(chevrons).not.toContain(ICONS['move-down']);
		expect(ICONS['move-up']).not.toBe(ICONS['move-down']);
	});
});
