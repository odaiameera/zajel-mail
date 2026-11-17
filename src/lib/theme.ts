/**
 * Puts a theme on the page: the class every colour hangs off, and the
 * browser bar's colour to match (it stays on --color-surface for the theme,
 * as in an installed app and on a phone).
 *
 * The first paint takes the theme from a cookie (see app.html), before any
 * of the app has loaded. This is for every change after that: a theme
 * picked in Settings, one brought in by Import or put back by Reset, and a
 * browser whose cookie still held the theme from before it was changed
 * somewhere else.
 */
export function applyTheme(theme: string): void {
	if (typeof document === 'undefined') return;
	const light = theme === 'light';
	document.documentElement.classList.toggle('light', light);
	document.querySelector('meta[name=theme-color]')?.setAttribute('content', light ? '#f6f8fa' : '#010409');
}
