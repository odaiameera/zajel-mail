// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { tick } from 'svelte';
import type { Email } from '$lib/jmap/types';
import { LABELS_CONTEXT, type Label } from '$lib/types/labels';

const mocks = vi.hoisted(() => ({
	page: {
		data: {
			autoLoadImages: 'contacts_only' as string,
			mailboxes: [],
			userEmail: 'me@example.test',
			markReadDelay: 1000 as number
		},
		url: new URL('http://localhost:3000/inbox')
	}
}));

vi.mock('$app/state', () => ({ page: mocks.page }));
vi.mock('$app/navigation', () => ({ goto: vi.fn(), invalidateAll: vi.fn() }));
vi.mock('$app/environment', () => ({ browser: true, dev: false, building: false }));

import EmailDetail from './EmailDetail.svelte';

/** Selects the subject's text, or its first `chars` letters. */
function selectSubject(el: HTMLElement, chars?: number) {
	const range = document.createRange();
	if (chars === undefined) range.selectNodeContents(el);
	else {
		range.setStart(el.firstChild!, 0);
		range.setEnd(el.firstChild!, chars);
	}
	window.getSelection()!.removeAllRanges();
	window.getSelection()!.addRange(range);
}

const PIXEL = 'https://tracker.example/open.gif?u=42';

function email(): Email {
	return {
		id: 'M1',
		threadId: 'T1',
		mailboxIds: { inbox: true },
		keywords: { $seen: true },
		from: [{ name: 'Newsletter', email: 'news@shop.example' }],
		to: [{ name: null, email: 'me@example.test' }],
		cc: null,
		subject: 'Hello',
		receivedAt: '2026-10-20T10:00:00Z',
		preview: '',
		attachments: [],
		htmlBody: [{ partId: '1', type: 'text/html' }],
		bodyValues: { '1': { value: `<p>Hi</p><img src="${PIXEL}">` } }
	} as unknown as Email;
}

let known: boolean | null = null;
const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
	const url = String(input);
	if (url.startsWith('/api/contacts/known')) return new Response(JSON.stringify({ known }), { status: 200 });
	return new Response('{}', { status: 200 });
});

function srcdoc(): string {
	return screen.getByTitle('Email content').getAttribute('srcdoc') ?? '';
}
const contactLookups = () => fetchMock.mock.calls.filter(([u]) => String(u).startsWith('/api/contacts/known'));

beforeEach(() => {
	vi.stubGlobal('fetch', fetchMock);
	known = null;
});

afterEach(() => {
	cleanup();
	fetchMock.mockClear();
	vi.unstubAllGlobals();
});

describe('EmailDetail remote images', () => {
	it('"Never" blocks the tracker, says so, and loads it only when asked', async () => {
		mocks.page.data.autoLoadImages = 'never';
		render(EmailDetail, { email: email() });

		expect(srcdoc()).not.toContain('tracker.example');
		expect(srcdoc()).toContain('Content-Security-Policy');
		expect(srcdoc()).not.toContain('/api/image-proxy');
		expect(contactLookups()).toHaveLength(0);

		await fireEvent.click(screen.getByRole('button', { name: 'Load images' }));
		await waitFor(() => expect(srcdoc()).toContain(`/api/image-proxy?url=${encodeURIComponent(PIXEL)}`));
		// The frame policy now lets the proxy through, and the banner is gone.
		expect(srcdoc()).toMatch(/img-src [^;]*\/api\/image-proxy/);
		expect(screen.queryByRole('button', { name: 'Load images' })).toBeNull();
	});

	it('"Contacts only" loads images for a known sender', async () => {
		mocks.page.data.autoLoadImages = 'contacts_only';
		known = true;
		render(EmailDetail, { email: email() });

		await waitFor(() => expect(srcdoc()).toContain('/api/image-proxy?url='));
		expect(contactLookups()[0][0]).toBe('/api/contacts/known?email=news%40shop.example');
	});

	it('"Contacts only" keeps them blocked for a stranger, or when the lookup fails', async () => {
		mocks.page.data.autoLoadImages = 'contacts_only';
		known = false;
		render(EmailDetail, { email: email() });
		await waitFor(() => expect(contactLookups()).toHaveLength(1));
		expect(srcdoc()).not.toContain('tracker.example');
		expect(screen.getByRole('button', { name: 'Load images' })).toBeTruthy();
		cleanup();

		known = null; // no contacts on the server
		render(EmailDetail, { email: email() });
		await waitFor(() => expect(contactLookups()).toHaveLength(2));
		expect(srcdoc()).not.toContain('tracker.example');
	});

	it('"Always" proxies without asking about contacts', () => {
		mocks.page.data.autoLoadImages = 'always';
		render(EmailDetail, { email: email() });
		expect(srcdoc()).toContain('/api/image-proxy?url=');
		expect(srcdoc()).not.toMatch(/src="https:\/\/tracker/);
		expect(contactLookups()).toHaveLength(0);
	});
});

describe('EmailDetail attachments', () => {
	it('lists real attachments whatever their Content-ID or disposition, and not the images the body draws', () => {
		mocks.page.data.autoLoadImages = 'never';
		const e = email();
		e.bodyValues = { '1': { value: '<p>Hi</p><img src="cid:logo@shop.example">', isEncodingProblem: false, isTruncated: false } };
		e.attachments = [
			{ partId: '2', blobId: 'B-logo', type: 'image/png', name: 'logo.png', size: 1200, cid: 'logo@shop.example', disposition: 'inline' },
			// Outlook puts a Content-ID on ordinary attachments.
			{ partId: '3', blobId: 'B-report', type: 'application/pdf', name: 'report.pdf', size: 52_000, cid: 'f_abc@namprd.outlook.com', disposition: 'attachment' },
			// Apple Mail sends a file placed in the text as inline.
			{ partId: '4', blobId: 'B-notes', type: 'application/pdf', name: 'notes.pdf', size: 8_000, cid: null, disposition: 'inline' }
		];
		render(EmailDetail, { email: e });

		expect(screen.getByText('report.pdf')).toBeTruthy();
		expect(screen.getByText('notes.pdf')).toBeTruthy();
		expect(screen.queryByText('logo.png')).toBeNull();
		expect(screen.getByText(/2 attachments/)).toBeTruthy();
		// The logo is in the body, where it belongs.
		expect(srcdoc()).toContain('/api/email/M1/attachment/B-logo');
	});
});

describe('EmailDetail header', () => {
	const details = () => document.getElementById('message-head-details')!;
	const subject = () => screen.getByRole('button', { name: 'Hello' });
	/** Who and when, the line just before the details. */
	const quietLine = () => details().previousElementSibling as HTMLElement;
	const labels: Label[] = [{ id: 'L1', name: 'Work', color: '#4493f8' }];
	function withLabel(): Email {
		const e = email();
		e.mailboxIds = { inbox: true, L1: true };
		return e;
	}
	const renderWithLabels = (e: Email) =>
		render(EmailDetail, {
			props: { email: e, compact: true },
			context: new Map([[LABELS_CONTEXT, { current: labels }]])
		});

	it('keeps the subject and labels in place and switches the line below it between who-and-when and the details', async () => {
		mocks.page.data.autoLoadImages = 'never';
		render(EmailDetail, { email: email(), compact: true });

		// Folded in the reading pane: the quiet line shows, the details don't.
		expect(details().className).toContain('hidden');
		// The subject is the toggle, and still the page's heading.
		const toggle = subject();
		expect(toggle.closest('h1')).toBe(screen.getByRole('heading', { level: 1, name: 'Hello' }));
		expect(toggle.getAttribute('aria-expanded')).toBe('false');
		expect(toggle.getAttribute('aria-controls')).toBe('message-head-details');
		expect(toggle.getAttribute('tabindex')).toBe('0');
		// No arrow beside it any more.
		expect(screen.queryByRole('button', { name: /details/i })).toBeNull();

		await fireEvent.click(toggle);
		await waitFor(() => expect(toggle.getAttribute('aria-expanded')).toBe('true'));
		expect(details().className).not.toContain('hidden');
		// The quiet line stays in the DOM, out of the flow and hidden from
		// screen readers, so the fold can fade one into the other.
		const quiet = quietLine();
		expect(quiet.className).toContain('absolute');
		expect(quiet.getAttribute('aria-hidden')).toBe('true');

		await fireEvent.click(toggle);
		await waitFor(() => expect(details().className).toContain('hidden'));
		expect(toggle.getAttribute('aria-expanded')).toBe('false');
		expect(quiet.className).not.toContain('absolute');
		expect(quiet.getAttribute('aria-hidden')).toBe('false');
	});

	it('opens from a click on the quiet line, too', async () => {
		mocks.page.data.autoLoadImages = 'never';
		const e = email();
		e.cc = [{ name: 'Sam', email: 'sam@example.test' }];
		render(EmailDetail, { email: e, compact: true });
		expect(quietLine().textContent).toContain('Newsletter');
		expect(quietLine().textContent).toContain('· to 2 people');
		await fireEvent.click(quietLine());
		await waitFor(() => expect(subject().getAttribute('aria-expanded')).toBe('true'));
	});

	it('toggles from the keyboard: Enter on the press, Space on the release', async () => {
		mocks.page.data.autoLoadImages = 'never';
		render(EmailDetail, { email: email(), compact: true });
		const toggle = subject();

		const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
		toggle.dispatchEvent(enter);
		expect(enter.defaultPrevented).toBe(true);
		await waitFor(() => expect(toggle.getAttribute('aria-expanded')).toBe('true'));
		// Held down, Enter repeats; that mustn't flick the header back and forth.
		await fireEvent.keyDown(toggle, { key: 'Enter', repeat: true });
		expect(toggle.getAttribute('aria-expanded')).toBe('true');

		// Space doesn't scroll the page, and acts when it's let go.
		const space = new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true });
		toggle.dispatchEvent(space);
		expect(space.defaultPrevented).toBe(true);
		await tick();
		expect(toggle.getAttribute('aria-expanded')).toBe('true');
		await fireEvent.keyUp(toggle, { key: ' ' });
		await waitFor(() => expect(toggle.getAttribute('aria-expanded')).toBe('false'));

		// A release without a press here (Space pressed elsewhere) does nothing.
		await fireEvent.keyUp(toggle, { key: ' ' });
		expect(toggle.getAttribute('aria-expanded')).toBe('false');
	});

	it('leaves the header alone when a label chip, its ×, or the + is clicked', async () => {
		mocks.page.data.autoLoadImages = 'never';
		renderWithLabels(withLabel());
		const toggle = subject();

		const labelCalls = () => fetchMock.mock.calls.filter(([u]) => String(u) === '/api/email/M1/label');
		await fireEvent.click(screen.getByTitle('Work'));
		await fireEvent.click(screen.getByRole('button', { name: 'Remove label Work' }));
		await waitFor(() => expect(labelCalls()).toHaveLength(1));
		await fireEvent.click(screen.getByRole('button', { name: 'Add label' }));
		expect(screen.getByRole('button', { name: 'Add label' }).getAttribute('aria-expanded')).toBe('true');
		// Picking a label from the menu doesn't toggle it either.
		await fireEvent.click(screen.getByRole('button', { name: 'Work' }));
		await waitFor(() => expect(labelCalls()).toHaveLength(2));

		expect(toggle.getAttribute('aria-expanded')).toBe('false');
		expect(details().className).toContain('hidden');
	});

	it('does not toggle when the click ends a selection of the subject’s text', async () => {
		mocks.page.data.autoLoadImages = 'never';
		render(EmailDetail, { email: email(), compact: true });
		const toggle = subject();

		// A drag: the mouse moved between press and release.
		await fireEvent.pointerDown(toggle, { pointerType: 'mouse', clientX: 10, clientY: 10 });
		await fireEvent.click(toggle, { clientX: 60, clientY: 11, detail: 1 });
		expect(toggle.getAttribute('aria-expanded')).toBe('false');

		// A Shift-click extends a selection.
		await fireEvent.pointerDown(toggle, { pointerType: 'mouse', clientX: 10, clientY: 10, shiftKey: true });
		await fireEvent.click(toggle, { clientX: 10, clientY: 10, detail: 1, shiftKey: true });
		expect(toggle.getAttribute('aria-expanded')).toBe('false');

		// A touch that leaves text selected in the subject (a long press).
		selectSubject(toggle);
		await fireEvent.pointerDown(toggle, { pointerType: 'touch', clientX: 10, clientY: 10 });
		await fireEvent.click(toggle, { clientX: 10, clientY: 10, detail: 1 });
		expect(toggle.getAttribute('aria-expanded')).toBe('false');
		window.getSelection()!.removeAllRanges();
	});

	it('still toggles when a pixel or two of hand movement selects a letter, and clears it', async () => {
		mocks.page.data.autoLoadImages = 'never';
		render(EmailDetail, { email: email(), compact: true });
		const toggle = subject();

		await fireEvent.pointerDown(toggle, { pointerType: 'mouse', clientX: 10, clientY: 10 });
		// Crossing the middle of a letter selects it, as Chromium does.
		selectSubject(toggle, 1);
		await fireEvent.click(toggle, { clientX: 12, clientY: 11, detail: 1 });
		await waitFor(() => expect(toggle.getAttribute('aria-expanded')).toBe('true'));
		expect(window.getSelection()!.isCollapsed).toBe(true);

		// So does the next click on a word a double-click selected.
		selectSubject(toggle);
		await fireEvent.pointerDown(toggle, { pointerType: 'mouse', clientX: 10, clientY: 10 });
		await fireEvent.click(toggle, { clientX: 10, clientY: 10, detail: 1 });
		await waitFor(() => expect(toggle.getAttribute('aria-expanded')).toBe('false'));
	});

	it('ignores a press that was let go elsewhere when a click without one comes later', async () => {
		mocks.page.data.autoLoadImages = 'never';
		render(EmailDetail, { email: email(), compact: true });
		const toggle = subject();
		// Pressed here, released outside: no click on the subject.
		await fireEvent.pointerDown(toggle, { pointerType: 'mouse', clientX: 10, clientY: 10 });
		// Then a click from script or assistive tech, far from that press.
		await fireEvent.click(toggle, { clientX: 300, clientY: 300, detail: 0 });
		await waitFor(() => expect(toggle.getAttribute('aria-expanded')).toBe('true'));
	});

	it('leaves the header as it was after a double- or triple-click, which select words', async () => {
		mocks.page.data.autoLoadImages = 'never';
		render(EmailDetail, { email: email(), compact: true });
		const toggle = subject();

		for (const clicks of [2, 3]) {
			for (let detail = 1; detail <= clicks; detail++) {
				await fireEvent.click(toggle, { detail });
			}
			await waitFor(() => expect(toggle.getAttribute('aria-expanded')).toBe('false'));
			expect(details().className).toContain('hidden');
		}
	});

	it('keeps your choice when the same message comes back as a new object', async () => {
		mocks.page.data.autoLoadImages = 'never';
		const { rerender } = render(EmailDetail, { email: email(), compact: true });
		await fireEvent.click(subject());
		await waitFor(() => expect(subject().getAttribute('aria-expanded')).toBe('true'));

		// What a refresh of the page's data does, e.g. after marking it read.
		await rerender({ email: { ...email(), keywords: { $seen: true, $flagged: true } } as Email });
		expect(subject().getAttribute('aria-expanded')).toBe('true');
		expect(details().className).toBe('');
	});

	it('starts the next message from the default, open on a wide page', async () => {
		mocks.page.data.autoLoadImages = 'never';
		const { rerender } = render(EmailDetail, { email: email() });
		const toggle = subject();
		// Not the reading pane: open, by CSS, from md up.
		expect(toggle.getAttribute('aria-expanded')).toBe('true');
		expect(details().className).toBe('max-md:hidden');

		await fireEvent.click(toggle);
		await waitFor(() => expect(toggle.getAttribute('aria-expanded')).toBe('false'));
		expect(details().className).toBe('hidden');

		await rerender({ email: { ...email(), id: 'M2', subject: 'Next one' } as Email });
		const next = screen.getByRole('button', { name: 'Next one' });
		expect(next.getAttribute('aria-expanded')).toBe('true');
		expect(details().className).toBe('max-md:hidden');
	});
});

describe('EmailDetail header, animated', () => {
	// jsdom has neither matchMedia nor the Web Animations API, so the tests
	// above take the reduced-motion path. These stand both in.
	type Fake = { keyframes: Keyframe[]; cancel: ReturnType<typeof vi.fn>; finish: () => void; finished: Promise<void> };
	let made: Fake[] = [];
	const original = Element.prototype.animate;
	beforeEach(() => {
		made = [];
		vi.stubGlobal('matchMedia', (query: string) => ({
			matches: false,
			media: query,
			addEventListener() {},
			removeEventListener() {}
		}));
		Element.prototype.animate = function (keyframes: Keyframe[]) {
			let finish!: () => void;
			const fake: Fake = {
				keyframes,
				cancel: vi.fn(),
				finish: () => finish(),
				finished: new Promise<void>((resolve) => (finish = resolve))
			};
			made.push(fake);
			return fake as unknown as Animation;
		} as typeof Element.prototype.animate;
	});
	afterEach(() => {
		Element.prototype.animate = original;
	});
	const subject = () => screen.getByRole('button', { name: 'Hello' });
	const fold = () => document.getElementById('message-head-details')!.parentElement!;
	const below = () => screen.getByTitle('Email content').parentElement!.parentElement!;

	it('moves the fold, holds the message, and tidies up when it lands', async () => {
		mocks.page.data.autoLoadImages = 'never';
		render(EmailDetail, { email: email(), compact: true });
		await fireEvent.click(subject());
		await waitFor(() => expect(made).toHaveLength(4));
		expect(subject().getAttribute('aria-expanded')).toBe('true');
		expect(made[0].keyframes.map((k) => 'height' in k)).toEqual([true, true]);
		expect(fold().style.overflow).toBe('hidden');
		expect(below().style.flex).not.toBe('');

		for (const a of made) a.finish();
		await waitFor(() => expect(below().style.flex).toBe(''));
		expect(fold().style.overflow).toBe('');
		expect(made.every((a) => a.cancel.mock.calls.length > 0)).toBe(true);
	});

	it('stops at once when another message comes in mid-way', async () => {
		mocks.page.data.autoLoadImages = 'never';
		const { rerender } = render(EmailDetail, { email: email(), compact: true });
		await fireEvent.click(subject());
		await waitFor(() => expect(made).toHaveLength(4));

		await rerender({ email: { ...email(), id: 'M2', subject: 'Next one' } as Email });
		expect(made.every((a) => a.cancel.mock.calls.length > 0)).toBe(true);
		expect(below().style.flex).toBe('');
		expect(fold().style.overflow).toBe('');
		const next = screen.getByRole('button', { name: 'Next one' });
		expect(next.getAttribute('aria-expanded')).toBe('false');

		// The old switch finishing later changes nothing.
		for (const a of made) a.finish();
		await new Promise((r) => setTimeout(r, 0));
		expect(next.getAttribute('aria-expanded')).toBe('false');
		expect(details().className).toContain('hidden');
	});

	it('drops a click whose message is replaced in the same moment', async () => {
		mocks.page.data.autoLoadImages = 'never';
		const { rerender } = render(EmailDetail, { email: email(), compact: true });
		subject().dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
		await rerender({ email: { ...email(), id: 'M2', subject: 'Next one' } as Email });
		await new Promise((r) => setTimeout(r, 0));

		expect(made).toHaveLength(0);
		expect(below().style.flex).toBe('');
		expect(screen.getByRole('button', { name: 'Next one' }).getAttribute('aria-expanded')).toBe('false');
		expect(details().className).toContain('hidden');
	});
	const details = () => document.getElementById('message-head-details')!;
});

describe('EmailDetail mark as read', () => {
	const markReadCalls = () =>
		(fetchMock.mock.calls as unknown as [RequestInfo | URL, RequestInit | undefined][]).filter(
			([u, init]) => String(u) === '/api/email/M1' && init?.method === 'PATCH'
		);
	const unread = () => ({ ...email(), keywords: {} }) as Email;

	it('marks the message read after the delay from Settings → Messages', async () => {
		mocks.page.data.autoLoadImages = 'never';
		mocks.page.data.markReadDelay = 0;
		render(EmailDetail, { email: unread() });
		await waitFor(() => expect(markReadCalls()).toHaveLength(1));
		expect(JSON.parse(String(markReadCalls()[0][1]?.body))).toEqual({ action: 'markRead' });
	});

	it('leaves it unread while the delay is still running', async () => {
		mocks.page.data.autoLoadImages = 'never';
		mocks.page.data.markReadDelay = 5000;
		render(EmailDetail, { email: unread() });
		await new Promise((resolve) => setTimeout(resolve, 60));
		expect(markReadCalls()).toHaveLength(0);
	});
});

describe('EmailDetail Inbox tab', () => {
	const data = mocks.page.data as Record<string, unknown>;
	const reasonCalls = () => fetchMock.mock.calls.map(([u]) => String(u)).filter((u) => u.startsWith('/api/jev/decision/'));
	const inTab = (keywords: Record<string, boolean>, mailboxIds: Record<string, boolean> = { inbox: true }) =>
		({ ...email(), keywords: { $seen: true, ...keywords }, mailboxIds }) as Email;

	beforeEach(() => {
		mocks.page.data.autoLoadImages = 'never';
		data.mailboxes = [
			{ id: 'inbox', name: 'Inbox', role: 'inbox', parentId: null },
			{ id: 'archive', name: 'Archive', role: 'archive', parentId: null }
		];
		data.inboxTabsOn = true;
	});
	afterEach(() => {
		data.mailboxes = [];
		delete data.inboxTabsOn;
	});

	it('shows the tab a sorted message is in beside its labels', () => {
		render(EmailDetail, { email: inTab({ $cat_updates: true }) });
		const chip = screen.getByTitle('In the Updates tab');
		expect(chip.textContent?.trim()).toBe('Updates');
		// Named as a tab, not only in a tooltip, so it can't pass for a label.
		expect(screen.getByRole('button', { name: 'In the Updates tab' })).toBe(chip);
		// Nothing is asked until the chip is.
		expect(reasonCalls()).toEqual([]);
	});

	describe('why it is in that tab', () => {
		let reply: unknown;
		beforeEach(() => {
			reply = { why: { kind: 'none' }, rules: [] };
			fetchMock.mockImplementation(async (input: RequestInfo | URL) =>
				String(input).startsWith('/api/jev/decision/') ? new Response(JSON.stringify(reply), { status: 200 }) : new Response('{}', { status: 200 })
			);
		});
		afterEach(async () => {
			fetchMock.mockReset();
			const { toasts } = await import('$lib/stores/toast');
			toasts.set([]);
		});
		const chip = () => screen.getByRole('button', { name: /Updates/ });
		/** The chip's hover text and name, once hovered. */
		async function reasonShown(): Promise<string> {
			await fireEvent.pointerEnter(chip());
			await waitFor(() => expect(chip().getAttribute('title')).not.toBe('In the Updates tab'));
			expect(chip().getAttribute('aria-label')).toBe(chip().getAttribute('title'));
			return chip().getAttribute('title')!;
		}

		it('says what put it there, for each case', async () => {
			const cases: [unknown, string][] = [
				[{ why: { kind: 'chosen' }, rules: [] }, 'You moved this to Updates.'],
				[{ why: { kind: 'pin', sender: 'news@example.com' }, rules: [] }, 'Mail from news@example.com is pinned to Updates.'],
				[{ why: { kind: 'pin', sender: '@shop.example' }, rules: [] }, 'Mail from anyone at shop.example is pinned to Updates.'],
				[{ why: { kind: 'jev', confidence: 0.917 }, rules: [] }, 'Jev put this in Updates (92% sure).'],
				[{ why: { kind: 'none' }, rules: [] }, 'In the Updates tab.'],
				[{ why: { kind: 'jev', confidence: 0.92 }, rules: ['Receipts'] }, 'Jev put this in Updates (92% sure). Rule “Receipts” also matched.'],
				[{ why: { kind: 'none' }, rules: ['A', 'B'] }, 'In the Updates tab. Rules “A” and “B” also matched.'],
				[{ why: { kind: 'chosen' }, rules: ['A', 'B', 'C'] }, 'You moved this to Updates. Rules “A”, “B” and “C” also matched.'],
				// A rule split in two keeps one name; a rule with no name isn't named.
				[{ why: { kind: 'none' }, rules: ['Receipts', 'Receipts', ''] }, 'In the Updates tab. Rule “Receipts” also matched.']
			];
			for (const [answer, text] of cases) {
				reply = answer;
				render(EmailDetail, { email: inTab({ $cat_updates: true }) });
				expect(await reasonShown()).toBe(text);
				cleanup();
			}
		});

		it('asks once, however often the chip is hovered or focused, and for the tab it is in', async () => {
			reply = { why: { kind: 'jev', confidence: 0.92 }, rules: [] };
			render(EmailDetail, { email: inTab({ $cat_updates: true }) });
			await reasonShown();
			for (let i = 0; i < 3; i++) {
				await fireEvent.pointerEnter(chip());
				await fireEvent.focus(chip());
			}
			await tick();
			expect(reasonCalls()).toEqual(['/api/jev/decision/M1?tab=updates']);
		});

		it('shows the same words in a toast when tapped, with one request', async () => {
			reply = { why: { kind: 'pin', sender: 'news@example.com' }, rules: [] };
			render(EmailDetail, { email: inTab({ $cat_updates: true }) });
			await fireEvent.pointerEnter(chip());
			await fireEvent.click(chip());
			const { toasts } = await import('$lib/stores/toast');
			const { get } = await import('svelte/store');
			await waitFor(() => expect(get(toasts).map((t) => t.message)).toEqual(['Mail from news@example.com is pinned to Updates.']));
			expect(reasonCalls()).toHaveLength(1);
		});

		it('says only which tab when the reason can’t be had, and asks again later', async () => {
			fetchMock.mockImplementation(async () => new Response('{}', { status: 500 }));
			render(EmailDetail, { email: inTab({ $cat_updates: true }) });
			await fireEvent.click(chip());
			const { toasts } = await import('$lib/stores/toast');
			const { get } = await import('svelte/store');
			await waitFor(() => expect(get(toasts).map((t) => t.message)).toEqual(['In the Updates tab.']));
			expect(chip().getAttribute('title')).toBe('In the Updates tab');
			await fireEvent.pointerEnter(chip());
			await waitFor(() => expect(reasonCalls()).toHaveLength(2));
		});
	});

	it('shows none for Important, outside the Inbox, or while tabs are off', () => {
		render(EmailDetail, { email: inTab({}) });
		expect(screen.queryByTitle(/ tab$/)).toBeNull();
		cleanup();

		render(EmailDetail, { email: inTab({ $cat_newsletters: true }, { archive: true }) });
		expect(screen.queryByTitle(/ tab$/)).toBeNull();
		cleanup();

		data.inboxTabsOn = false;
		render(EmailDetail, { email: inTab({ $cat_promotions: true }) });
		expect(screen.queryByTitle(/ tab$/)).toBeNull();
	});
});

describe('EmailDetail filing', () => {
	const data = mocks.page.data as Record<string, unknown>;
	const labels: Label[] = [
		{ id: 'WORK', name: 'Work', color: '#4493f8' },
		{ id: 'HOME', name: 'Home', color: '#3fb950' }
	];
	const patches = () =>
		(fetchMock.mock.calls as unknown as [RequestInfo | URL, RequestInit | undefined][])
			.filter(([u, init]) => String(u) === '/api/email/M1' && init?.method === 'PATCH')
			.map(([, init]) => JSON.parse(String(init?.body)) as Record<string, unknown>);
	const labelCalls = () =>
		(fetchMock.mock.calls as unknown as [RequestInfo | URL, RequestInit | undefined][])
			.filter(([u]) => String(u) === '/api/email/M1/label')
			.map(([, init]) => JSON.parse(String(init?.body)) as Record<string, unknown>);
	const at = (mailboxIds: Record<string, boolean>, extra: Partial<Email> = {}) =>
		({ ...email(), mailboxIds, ...extra }) as Email;
	function show(e: Email, context: [unknown, unknown][] = []) {
		return render(EmailDetail, {
			props: { email: e },
			context: new Map<unknown, unknown>([[LABELS_CONTEXT, { current: labels }], ...context])
		});
	}

	beforeEach(() => {
		mocks.page.data.autoLoadImages = 'never';
		data.mailboxes = [
			{ id: 'inbox', name: 'Inbox', role: 'inbox', parentId: null, sortOrder: 0 },
			{ id: 'AR', name: 'Archive', role: 'archive', parentId: null, sortOrder: 0 },
			{ id: 'TR', name: 'Trash', role: 'trash', parentId: null, sortOrder: 0 },
			{ id: 'PRJ', name: 'Projects', role: null, parentId: null, sortOrder: 0 },
			{ id: 'LBLS', name: 'Labels', role: null, parentId: null, sortOrder: 0 },
			{ id: 'WORK', name: 'Work', role: null, parentId: 'LBLS', sortOrder: 0 },
			{ id: 'HOME', name: 'Home', role: null, parentId: 'LBLS', sortOrder: 0 }
		];
	});
	afterEach(() => {
		data.mailboxes = [];
		mocks.page.url = new URL('http://localhost:3000/inbox');
		fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url.startsWith('/api/contacts/known')) return new Response(JSON.stringify({ known }), { status: 200 });
			return new Response('{}', { status: 200 });
		});
	});

	it('never deletes for good when opened from a label, even a message in Trash', async () => {
		mocks.page.url = new URL('http://localhost:3000/folder/WORK');
		show(at({ TR: true, WORK: true }));
		await fireEvent.click(screen.getByTitle('Trash'));
		await waitFor(() => expect(patches()).toHaveLength(1));
		expect(patches()[0]).toEqual({ action: 'trash' });
	});

	it('never deletes for good in the reading pane of a list other than Trash', async () => {
		show(at({ TR: true }), [['listIsTrash', () => false]]);
		await fireEvent.click(screen.getByTitle('Trash'));
		await waitFor(() => expect(patches()).toHaveLength(1));
		expect(patches()[0]).toEqual({ action: 'trash' });
	});

	it('deletes for good when opened from the Trash list, on its own page or in its reading pane', async () => {
		mocks.page.url = new URL('http://localhost:3000/email/M1?from=trash');
		show(at({ TR: true }));
		await fireEvent.click(screen.getByTitle('Trash'));
		await waitFor(() => expect(patches()).toHaveLength(1));
		expect(patches()[0]).toEqual({ action: 'trash', permanent: true });
		cleanup();

		mocks.page.url = new URL('http://localhost:3000/folder/TR');
		show(at({ TR: true }), [['listIsTrash', () => true]]);
		await fireEvent.click(screen.getByTitle('Trash'));
		await waitFor(() => expect(patches()).toHaveLength(2));
		expect(patches()[1]).toEqual({ action: 'trash', permanent: true });
	});

	it('Undo after copying a code restores the message to where it was', async () => {
		const { toasts } = await import('$lib/stores/toast');
		const { get } = await import('svelte/store');
		Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true });
		Object.defineProperty(navigator, 'clipboard', { value: { writeText: vi.fn(async () => {}) }, configurable: true });
		show(at({ PRJ: true, WORK: true }, { subject: '504072 is your verification code' }));
		await fireEvent.click(screen.getByRole('button', { name: /Copy code/ }));
		await waitFor(() => expect(patches()).toEqual([{ action: 'trash' }]));
		const undo = get(toasts).find((t) => t.action?.label === 'Undo');
		expect(undo).toBeTruthy();
		undo!.action!.onClick();
		await waitFor(() => expect(patches()).toHaveLength(2));
		expect(patches()[1]).toEqual({ action: 'restore', mailboxId: 'PRJ' });
	});

	it('shows the message in Archive once its only label comes off', async () => {
		fetchMock.mockImplementation(async (input: RequestInfo | URL) =>
			String(input) === '/api/email/M1/label'
				? new Response(JSON.stringify({ success: true, mailboxIds: { AR: true } }), { status: 200 })
				: new Response('{}', { status: 200 })
		);
		show(at({ WORK: true }));
		// Its page's way back names where it lives; a label is not a folder.
		expect(screen.getByTitle('Back to Inbox')).toBeTruthy();
		await fireEvent.click(screen.getByRole('button', { name: 'Remove label Work' }));
		await waitFor(() => expect(screen.getByTitle('Back to Archive')).toBeTruthy());
		expect(labelCalls()).toEqual([{ labelId: 'WORK', action: 'remove' }]);
		expect(screen.queryByRole('button', { name: 'Remove label Work' })).toBeNull();
	});

	it('picking a label the message already has in “Move to…” leaves it on', async () => {
		show(at({ inbox: true, WORK: true }));
		await fireEvent.click(screen.getByTitle('Move to…'));
		await fireEvent.click(
			[...document.querySelectorAll<HTMLButtonElement>('button[data-section="label"]')].find((b) =>
				b.textContent?.includes('Work')
			)!
		);
		await tick();
		expect(labelCalls()).toEqual([]);
		expect(screen.getByRole('button', { name: 'Remove label Work' })).toBeTruthy();
	});

	it('“Move to…” files into a folder by a move, and a label through the label endpoint', async () => {
		show(at({ inbox: true }));
		await fireEvent.click(screen.getByTitle('Move to…'));
		const pick = (section: string, name: string) =>
			[...document.querySelectorAll<HTMLButtonElement>(`button[data-section="${section}"]`)].find((b) =>
				b.textContent?.includes(name)
			)!;
		await fireEvent.click(pick('label', 'Home'));
		await waitFor(() => expect(labelCalls()).toEqual([{ labelId: 'HOME', action: 'apply' }]));
		expect(patches()).toEqual([]);

		await fireEvent.click(screen.getByTitle('Move to…'));
		await fireEvent.click(pick('move', 'Projects'));
		await waitFor(() => expect(patches()).toEqual([{ action: 'moveTo', targetMailboxId: 'PRJ' }]));
		expect(labelCalls()).toHaveLength(1);
	});
});
