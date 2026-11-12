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
	 * Save is disabled and the bar says it.
	 */
	check?: (values: T) => string;
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

const FALLBACK_ERROR = 'Couldn’t save. Try again.';

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
	/** Why the last save failed; empty once a save is tried again or the changes are discarded. */
	error = $state('');
	readonly dirty: boolean = $derived.by(() =>
		keysOf(this.value, this.#baseline).some((key) => !same(this.value[key], this.#baseline[key]))
	);
	/** Why the values on screen can't be saved; '' when they can, or when nothing is changed. */
	readonly problem: string = $derived.by(() => (this.dirty ? (this.#options.check?.(this.value) ?? '') : ''));

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

	/** Sends what changed. True once it is all stored. */
	async save(): Promise<boolean> {
		if (this.saving || this.problem) return false;
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
			return true;
		} catch (err) {
			if (!(err instanceof SaveCancelled)) {
				this.error = err instanceof Error && err.message ? err.message : FALLBACK_ERROR;
			}
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

	/** Saves every draft with changes. True when all of them were stored. */
	async saveAll(): Promise<boolean> {
		if (!this.dirty || this.saving || this.problem) return false;
		this.#clearSaved();
		const results = await Promise.all(this.#drafts.filter((d) => d.dirty).map((d) => d.save()));
		const ok = results.every(Boolean) && !this.dirty;
		if (ok) {
			this.justSaved = true;
			this.#savedTimer = setTimeout(() => (this.justSaved = false), SAVED_FLASH_MS);
		}
		return ok;
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

/** Called by the settings layout: the host its Save bar reads and its pages register with. */
export function provideSaveHost(): SaveHost {
	const host = new SaveHost();
	setContext(SAVE_HOST, host);
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
