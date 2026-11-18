// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { applyTheme } from './theme';

beforeEach(() => {
	document.documentElement.className = '';
	document.head.innerHTML = '<meta name="theme-color" content="#010409" />';
});

const barColour = () => document.querySelector('meta[name=theme-color]')?.getAttribute('content');

describe('applyTheme', () => {
	it('puts the light theme on the page, with the browser bar to match', () => {
		applyTheme('light');
		expect(document.documentElement.classList.contains('light')).toBe(true);
		expect(barColour()).toBe('#f6f8fa');
	});

	it('takes it off again for dark', () => {
		applyTheme('light');
		applyTheme('dark');
		expect(document.documentElement.classList.contains('light')).toBe(false);
		expect(barColour()).toBe('#010409');
	});
});
