import { getContext, onDestroy, setContext, untrack } from 'svelte';

/**
 * Settings wait for Save.
 *
 * A settings page keeps what is on screen in a `Draft`: its controls are
 * bound to `value`, and nothing is sent until Save is pressed. The draft
 * remembers the values as they were last saved (the baseline), so it knows
 * whether anything changed, which keys to send, and what Discard goes back
 * to.
 *
 * The baseline is taken once, when the page opens, and afterwards only moves
 * on a save, a discard, or when the page says so (`seed`, `forget`). The
 * page's `data` is reloaded in the background all the time (new mail
 * arriving reruns every load), and a reload must never put a half-typed
 * field back to what the server has.
 *
 * The settings layout owns one Save bar for whichever page is open. A page
 * hands it its draft with `useDraft`; the layout makes the host with
 * `provideSaveHost`.
 */

/** A page's settings by name. Plain JSON values only: they are compared and copied as JSON. */
type Values = Record<string, unknown>;

/**
 * Stores the changes. `changed` holds only the keys that differ from what
 * was last saved, `all` every value as it is on screen.
 *
 * A page that stores its settings in more than one request calls `stored`
 * after each one that went through, with the keys it covered (and their
 * values as the server keeps them): if a later request fails, those are
 * no longer unsaved.
 *
 * Throws an `Error` whose message can be shown as it is when (the rest of)
 * the save didn't happen. May return the values as the server stored them
 * (trimmed, rounded), which then replace what was typed.
 */
export type Persist<T> = (
	changed: Partial<T>,
	all: T,
	stored: (values: Partial<T>) => void
) => Promise<Partial<T> | void>;

export interface DraftOptions<T> {
	/** The saved values the page opened with. */
	initial: T;
	persist: Persist<T>;
	/** Shows values on the page before they are saved (the theme). Called on Discard with the saved ones. */
	preview?: (values: T) => void;
	/**
	 * Why the values on screen can't be saved as they are (an end date
	 * before the start date), or '' when they can. While there is a reason,
	 * Save is disabled and the bar says it. `changed` tells whether a key
	 * differs from what is saved: a value stored long ago that today's
	 * rules wouldn't take (one brought in by Import) is not the person's
	 * doing, and shouldn't keep them from saving something else.
	 */
	check?: (values: T, changed: (key: keyof T) => boolean) => string;
}

/**
 * Thrown by `persist` when the person backed out, as when they close the
 * "Confirm it's you" dialog. Nothing was saved and nothing went wrong: the
 * changes stay in the form, without an error.
 */
export class SaveCancelled extends Error {
	constructor() {
		super('Save cancelled');
		this.name = 'SaveCancelled';
	}
}

/**
 * Thrown by `persist` when, once it looked, there was nothing left to send:
 * every change was to something no longer there. Nothing was stored, so the
 * bar mustn't say "Saved"; the changes are dropped without a word.
 */
export class NothingToSend extends Error {
	constructor() {
		super('Nothing to send');
		this.name = 'NothingToSend';
	}
}

const FALLBACK_ERROR = 'Couldn’t save. Try again.';
export const NETWORK_ERROR = 'Couldn’t reach the server. Try again.';

/**
 * What the Save bar says about a failed save. A request that never reached
 * the server fails with the browser's own words ("Failed to fetch", "Load
 * failed"), which mean nothing to the person; every page says the same
 * plain thing instead.
 */
export function saveFailureReason(err: unknown): string {
	if (err instanceof TypeError) return NETWORK_ERROR;
	return err instanceof Error && err.message ? err.message : FALLBACK_ERROR;
}

function same(a: unknown, b: unknown): boolean {
	return JSON.stringify(a) === JSON.stringify(b);
}

/** A copy that shares nothing with the original, so editing one can't change the other. */
function copy<V>(value: V): V {
	return value === undefined ? value : (JSON.parse(JSON.stringify(value)) as V);
}

function keysOf<T extends Values>(...objects: T[]): (keyof T)[] {
	return [...new Set(objects.flatMap((o) => Object.keys(o)))] as (keyof T)[];
}

export class Draft<T extends Values> {
	/** What is on screen. The page binds its controls to this. */
	value: T;
	saving = $state(false);
	/** Whether the last save that went through sent anything to the server. */
	sent = $state(false);
	/** Why the last save failed; empty once a save is tried again or the changes are discarded. */
	error = $state('');
	readonly dirty: boolean = $derived.by(() =>
		keysOf(this.value, this.#baseline).some((key) => !same(this.value[key], this.#baseline[key]))
	);
	/** Why the values on screen can't be saved; '' when they can, or when nothing is changed. */
	readonly problem: string = $derived.by(() =>
		this.dirty ? (this.#options.check?.(this.value, (key) => !same(this.value[key], this.#baseline[key])) ?? '') : ''
	);

	#baseline: T;
	readonly #options: DraftOptions<T>;

	constructor(options: DraftOptions<T>) {
		this.#options = options;
		this.value = $state(copy(options.initial));
		this.#baseline = $state.raw(copy(options.initial));
	}

	/** The values as last saved. */
	get baseline(): Readonly<T> {
		return this.#baseline;
	}

	/**
	 * Saved values that arrive after the page opened: a page that fetches its
	 * own settings on mount has nothing to start from until then, and a row
	 * added by an action (a new pin) brings its own. A field the person has
	 * already changed keeps what they typed.
	 */
	seed(loaded: Partial<T>): void {
		const baseline = { ...this.#baseline };
		for (const key of Object.keys(loaded) as (keyof T)[]) {
			const next = loaded[key] as T[keyof T];
			if (!(key in this.value) || same(this.value[key], baseline[key])) this.value[key] = copy(next);
			baseline[key] = copy(next);
		}
		this.#baseline = baseline;
	}

	/** Settings that are gone (a pin removed by an action): no longer on screen, saved or unsaved. */
	forget(keys: (keyof T)[]): void {
		const baseline = { ...this.#baseline };
		for (const key of keys) {
			delete baseline[key];
			delete this.value[key];
		}
		this.#baseline = baseline;
	}

	#present: Set<string> | null = null;

	/**
	 * The settings the page's data has now, called whenever it reloads. A
	 * setting that was there the last time and isn't now (a pin removed in
	 * another tab) is forgotten, changed or not: there is nothing left to
	 * store it for. One added since (a pin just made here, before the reload
	 * that brings it) is left alone.
	 */
	present(keys: Iterable<keyof T & string>): void {
		const now = new Set<string>(keys);
		const before = this.#present;
		this.#present = now;
		if (!before) return;
		const gone = [...before].filter((key) => !now.has(key));
		if (gone.length > 0) this.forget(gone as (keyof T)[]);
	}

	/** Sends what changed. True once it is all stored. */
	async save(): Promise<boolean> {
		if (this.saving || this.problem) return false;
		this.sent = false;
		if (!this.dirty) return true;
		const sent = copy($state.snapshot(this.value) as T);
		const changed: Partial<T> = {};
		for (const key of keysOf(sent, this.#baseline)) {
			if (!same(sent[key], this.#baseline[key])) changed[key] = sent[key];
		}

		// What the server now has. Whatever was typed while the request was
		// out is still unsaved; every other field shows the value as stored.
		const done = new Set<keyof T>();
		const take = (values: Partial<T>) => {
			for (const key of Object.keys(values) as (keyof T)[]) {
				if (values[key] === undefined) continue;
				done.add(key);
				if (same(this.value[key], sent[key])) this.value[key] = copy(values[key] as T[keyof T]);
			}
			this.#baseline = { ...this.#baseline, ...copy(values) };
		};

		this.saving = true;
		this.error = '';
		try {
			const returned = (await this.#options.persist(changed, sent, take)) ?? {};
			// What the page returns wins; the rest of what was sent is stored
			// as it was, except what the page already reported as stored.
			const rest = Object.fromEntries(Object.entries(changed).filter(([key]) => !done.has(key)));
			take({ ...rest, ...returned } as Partial<T>);
			this.sent = true;
			return true;
		} catch (err) {
			if (err instanceof NothingToSend) {
				// Whatever was changed had nothing behind it: back to as saved.
				for (const key of Object.keys(changed) as (keyof T)[]) {
					if (same(this.value[key], sent[key])) this.value[key] = copy(this.#baseline[key]);
				}
				return true;
			}
			if (!(err instanceof SaveCancelled)) this.error = saveFailureReason(err);
			return false;
		} finally {
			this.saving = false;
		}
	}

	/** Back to the saved values, on screen and in any live preview. */
	discard(): void {
		this.value = copy(this.#baseline);
		this.error = '';
		this.#options.preview?.(copy(this.#baseline));
	}
}

/** What the host needs of a draft, whatever its values are. */
interface RegisteredDraft {
	readonly dirty: boolean;
	readonly saving: boolean;
	readonly sent: boolean;
	readonly error: string;
	readonly problem: string;
	save(): Promise<boolean>;
	discard(): void;
}

/** How long the bar says "Saved" after a save. */
export const SAVED_FLASH_MS = 2000;

/**
 * The drafts of the page that is open, for the one Save bar. A page with no
 * settings registers nothing, and the bar never shows.
 */
export class SaveHost {
	#drafts = $state.raw<RegisteredDraft[]>([]);
	#savedTimer: ReturnType<typeof setTimeout> | undefined;

	/** True for a moment after a save went through. */
	justSaved = $state(false);
	readonly dirty: boolean = $derived(this.#drafts.some((d) => d.dirty));
	readonly saving: boolean = $derived(this.#drafts.some((d) => d.saving));
	/** The reasons of a failed save, for as long as their changes are still unsaved. */
	readonly error: string = $derived(
		this.#drafts
			.filter((d) => d.dirty && d.error)
			.map((d) => d.error)
			.join(' ')
	);
	/** Why the changes can't be saved as they are; Save is disabled meanwhile. */
	readonly problem: string = $derived(this.#drafts.find((d) => d.problem)?.problem ?? '');
	/** The bar is there while something is unsaved or saving, and for a moment after a save. */
	readonly visible: boolean = $derived(this.dirty || this.saving || this.justSaved);

	register(draft: RegisteredDraft): void {
		this.#clearSaved();
		this.#drafts = [...this.#drafts, draft];
	}

	unregister(draft: RegisteredDraft): void {
		this.#clearSaved();
		this.#drafts = this.#drafts.filter((d) => d !== draft);
	}

	#pending: Promise<boolean> | null = null;

	/** Saves every draft with changes. True when all of them were stored. */
	saveAll(): Promise<boolean> {
		if (!this.dirty || this.saving || this.problem) return Promise.resolve(false);
		this.#clearSaved();
		const pending = this.#saveAll();
		this.#pending = pending;
		void pending.finally(() => {
			if (this.#pending === pending) this.#pending = null;
		});
		return pending;
	}

	async #saveAll(): Promise<boolean> {
		const dirty = this.#drafts.filter((d) => d.dirty);
		const results = await Promise.all(dirty.map((d) => d.save()));
		const ok = results.every(Boolean) && !this.dirty;
		// "Saved" only when something was: a save that found nothing to send
		// just lets the bar go.
		if (ok && dirty.some((d) => d.sent)) {
			this.justSaved = true;
			this.#savedTimer = setTimeout(() => (this.justSaved = false), SAVED_FLASH_MS);
		}
		return ok;
	}

	/**
	 * Resolves once the save under way (if any) is over: true when it
	 * stored everything, false when it failed. With none under way, true.
	 */
	settled(): Promise<boolean> {
		return this.#pending ?? Promise.resolve(true);
	}

	discardAll(): void {
		this.#clearSaved();
		for (const draft of this.#drafts) draft.discard();
	}

	#clearSaved(): void {
		clearTimeout(this.#savedTimer);
		this.justSaved = false;
	}
}

const SAVE_HOST = Symbol('settings-save-host');

/** The host of the settings page that is open, for the app around Settings (see leave.ts). */
let openHost: SaveHost | null = null;

export function openSaveHost(): SaveHost | null {
	return openHost;
}

/** Called by the settings layout: the host its Save bar reads and its pages register with. */
export function provideSaveHost(): SaveHost {
	const host = new SaveHost();
	setContext(SAVE_HOST, host);
	openHost = host;
	onDestroy(() => {
		if (openHost === host) openHost = null;
	});
	return host;
}

/**
 * A page's draft, shown in the layout's Save bar for as long as the page is
 * mounted. Call during init. A page may make more than one. Without a
 * settings layout around it (a page rendered on its own) the draft works
 * the same; there is just no bar to save it from.
 */
export function useDraft<T extends Values>(options: DraftOptions<T>): Draft<T> {
	const draft = new Draft(options);
	const host = getContext<SaveHost | undefined>(SAVE_HOST);
	if (host) {
		// The page is created while the layout is mid-render; untrack keeps the
		// registration from counting as a state write inside that render.
		untrack(() => host.register(draft));
		onDestroy(() => host.unregister(draft));
	}
	return draft;
}
