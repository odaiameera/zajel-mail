import { writable } from 'svelte/store';

export function createReadingPaneStore(initial: boolean) {
	const { subscribe, set, update } = writable(initial);
	let hasManualPreference = initial !== undefined;

	return {
		subscribe,
		async toggle() {
			let next = false;
			update((v) => {
				next = !v;
				return next;
			});
			hasManualPreference = true;
			await fetch('/api/preferences/reading-pane', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ value: next ? 'on' : 'off' })
			});
		},
		/**
		 * The saved setting, whenever the app's data brings it: switched in
		 * Settings → Appearance, in another tab, or by Import or Reset. Without
		 * this the lists kept the pane they opened with until a reload, and a
		 * saved change looked like one that hadn't been.
		 */
		follow(saved: boolean) {
			hasManualPreference = true;
			set(saved);
		},
		setFromViewport(width: number) {
			if (hasManualPreference) return;
			set(width >= 1280);
		}
	};
}
