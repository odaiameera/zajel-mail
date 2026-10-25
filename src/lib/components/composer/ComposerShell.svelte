<script lang="ts">
	import Icon from '$lib/components/Icon.svelte';
	import { onDestroy, untrack } from 'svelte';
	import { expoOut } from 'svelte/easing';
	import { cornerWindow } from '$lib/transitions';
	import { Editor } from '@tiptap/core';
	import StarterKit from '@tiptap/starter-kit';
	import Underline from '@tiptap/extension-underline';
	import TextAlign from '@tiptap/extension-text-align';
	import Link from '@tiptap/extension-link';
	import { TextStyle, FontSize } from '@tiptap/extension-text-style';
	import FontFamily from '@tiptap/extension-font-family';
	import Color from '@tiptap/extension-color';
	import Highlight from '@tiptap/extension-highlight';
	import Subscript from '@tiptap/extension-subscript';
	import Superscript from '@tiptap/extension-superscript';
	import { Table } from '@tiptap/extension-table';
	import TableRow from '@tiptap/extension-table-row';
	import TableCell from '@tiptap/extension-table-cell';
	import TableHeader from '@tiptap/extension-table-header';
	import Image from '@tiptap/extension-image';
	import { SignatureNode } from '$lib/tiptap/signature-node';

	import {
		composer,
		setMode,
		setSignature,
		setFromIdentity,
		closeCompose,
		closeRequests
	} from '$lib/stores/compose';
	import { userState } from '$lib/stores/userState';
	import {
		resolveSignatureForIdentity,
		getSignatureById,
		applySignature
	} from '$lib/utils/signatures';
	import { compressImageForBody } from '$lib/utils/image-compress';
	import { showToast } from '$lib/stores/toast';
	import { afterScheduling, type ScheduledSend } from '$lib/stores/outbox';
	import {
		formatSendDate,
		fromInputValues,
		sendLaterPresets,
		toInputValues,
		type SendLaterPreset
	} from '$lib/utils/send-later';
	import { rememberRecipients } from '$lib/utils/recent-recipients';
	import type { ComposeAttachment } from '$lib/jmap/types';
	import SignaturePicker from './SignaturePicker.svelte';
	import FromPicker from './FromPicker.svelte';
	import RecipientInput from './RecipientInput.svelte';
	import { page } from '$app/state';
	import { shortcutLabel } from '$lib/utils/platform';

	let to = $state('');
	let cc = $state('');
	let bcc = $state('');
	let subject = $state('');
	let body = $state('');
	let inReplyTo = $state('');
	let references = $state('');
	let draftId = $state<string | undefined>(undefined);
	let isForward = $state(false);
	let showCc = $state(false);
	let showBcc = $state(false);
	let sending = $state(false);
	let savingDraft = $state(false);
	let discarding = $state(false);
	let error = $state('');
	let importance = $state<'high' | 'normal' | 'low'>('normal');
	let confirmingDiscard = $state(false);

	// --- Draft saving ---
	// What was last written to the server (or loaded from it), as a snapshot
	// string; the composer is "dirty" when the current snapshot differs.
	let lastSavedSnapshot = $state('');
	let saveStatus = $state<'idle' | 'saving' | 'saved' | 'error'>('idle');
	let savedAt = $state<Date | null>(null);
	let lastSession = 0;

	// --- Attachments ---
	let attachments = $state<ComposeAttachment[]>([]);
	let pendingUploads = $state<{ id: number; name: string; size: number }[]>([]);
	let nextUploadId = 0;
	let fileInputEl = $state<HTMLInputElement | undefined>();

	// --- Inline link popover (replaces window.prompt) ---
	// Toolbar menus and popovers: one open at a time, closed by any click
	// outside a [data-menu-root].
	type MenuName = 'size' | 'color' | 'align' | 'more' | 'emoji' | 'link' | 'importance' | 'schedule';
	let openMenu = $state<MenuName | null>(null);

	// --- Send later ---
	let presets = $state<SendLaterPreset[]>([]);
	let pickingTime = $state(false);
	let pickDate = $state('');
	let pickTime = $state('');
	let pickError = $state('');
	let linkUrl = $state('');

	const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

	function formatBytes(n: number): string {
		if (n < 1024) return `${n} B`;
		if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
		return `${(n / (1024 * 1024)).toFixed(1)} MB`;
	}

	let editorEl = $state<HTMLDivElement | undefined>();
	let editor: Editor | null = $state(null);
	let lastMode: 'popup' | 'fullscreen' | 'minimized' | 'closed' = 'closed';
	let lastAppliedSignatureId: number | null | 'unset' = 'unset';

	const EMOJIS = ['😀','😂','🙂','😊','😉','😍','🤔','😅','🙏','👍','👎','👏','🙌','💪','❤️','🎉','🔥','✨','✅','❌','⚠️','💡','🚀','⭐'];

	// Subject shown in minimized title bar / header
	// "Draft" only for a draft you opened, not once auto-save has given a
	// new message a draft id.
	let openedDraft = $state(false);
	let displayTitle = $derived(subject || (inReplyTo ? 'Reply' : isForward ? 'Forward' : openedDraft ? 'Draft' : 'New message'));

	onDestroy(() => editor?.destroy());

	// Build the Tiptap editor on first open. We deliberately keep the editor
	// alive across mode switches (popup ↔ fullscreen ↔ minimized) so editing
	// state — selection, history, scroll — survives.
	function initEditor(initialContent: string) {
		if (editor || !editorEl) return;
		editor = new Editor({
			element: editorEl,
			extensions: [
				StarterKit.configure({ link: false, underline: false }),
				Underline,
				TextAlign.configure({ types: ['heading', 'paragraph'] }),
				Link.configure({ openOnClick: false }),
				TextStyle,
				// Registered so the size menu does something: setting a
				// fontSize mark without it was silently dropped.
				FontSize,
				FontFamily,
				Color,
				Highlight.configure({ multicolor: false }),
				Subscript,
				Superscript,
				Table.configure({ resizable: false }),
				TableRow,
				TableCell,
				TableHeader,
				Image.configure({ inline: false, allowBase64: true }),
				SignatureNode
			],
			content: initialContent,
			onTransaction: () => {
				editor = editor;
			},
			onUpdate: ({ editor: e }) => {
				body = e.getHTML();
			}
		});

		// Tiptap's default paste handler ignores image files. Intercept on the
		// editor's DOM and re-route image pastes through our compressor.
		editor.view.dom.addEventListener('paste', handlePaste);
		editor.on('selectionUpdate', updateBubble);
		editor.on('focus', updateBubble);
		// After the click that blurred it has landed, so a click inside the
		// menu (which keeps focus) doesn't close it.
		editor.on('blur', () => setTimeout(updateBubble, 0));
	}

	async function handlePaste(e: ClipboardEvent) {
		const items = Array.from(e.clipboardData?.items ?? []);
		const imageItems = items.filter((i) => i.type.startsWith('image/'));
		if (imageItems.length === 0) return; // let Tiptap handle text/HTML paste
		e.preventDefault();
		e.stopPropagation();

		for (const item of imageItems) {
			const file = item.getAsFile();
			if (!file) continue;
			if (file.size > 15 * 1024 * 1024) {
				showToast({ message: 'Image too large (15MB max)' });
				continue;
			}
			try {
				const dataUrl = await compressImageForBody(file);
				editor?.chain().focus().setImage({ src: dataUrl }).run();
			} catch (err) {
				console.error('paste image compression failed', err);
				showToast({ message: 'Could not paste image' });
			}
		}
	}

	function isActive(name: string, attrs?: Record<string, unknown>) {
		return editor?.isActive(name, attrs) ?? false;
	}

	function openLinkPopover() {
		linkUrl = (editor?.getAttributes('link').href as string) ?? '';
		openMenu = 'link';
	}

	function applyLink() {
		const url = linkUrl.trim();
		if (!url) {
			editor?.chain().focus().extendMarkRange('link').unsetLink().run();
		} else {
			const href = /^[a-z]+:|^\//i.test(url) ? url : `https://${url}`;
			editor?.chain().focus().extendMarkRange('link').setLink({ href }).run();
		}
		openMenu = null;
	}

	function insertEmoji(emoji: string) {
		editor?.chain().focus().insertContent(emoji).run();
		openMenu = null;
	}

	function toggleMenu(name: MenuName) {
		if (name === 'link') return openMenu === 'link' ? (openMenu = null) : openLinkPopover();
		openMenu = openMenu === name ? null : name;
	}

	function toggleSendLater() {
		if (openMenu === 'schedule') {
			openMenu = null;
			return;
		}
		presets = sendLaterPresets(new Date());
		({ date: pickDate, time: pickTime } = toInputValues(presets[0].at));
		pickingTime = false;
		pickError = '';
		openMenu = 'schedule';
	}

	function sendAtPicked() {
		const at = fromInputValues(pickDate, pickTime);
		if (!at || at.getTime() < Date.now() + 60_000) {
			pickError = 'Pick a time in the future';
			return;
		}
		void handleSend(at);
	}

	function closeMenusOnOutsideClick(e: PointerEvent) {
		if (openMenu && !(e.target as Element | null)?.closest('[data-menu-root]')) openMenu = null;
	}

	// Text size: four steps, like Gmail, instead of an 8-72pt list.
	const TEXT_SIZES = [
		{ label: 'Small', size: '10pt' },
		{ label: 'Normal', size: null },
		{ label: 'Large', size: '14pt' },
		{ label: 'Huge', size: '18pt' }
	] as const;

	function setTextSize(size: string | null) {
		const chain = editor?.chain().focus();
		if (size) chain?.setFontSize(size).run();
		else chain?.unsetFontSize().run();
		openMenu = null;
	}

	const TEXT_COLORS = ['#d1242f', '#bc4c00', '#9a6700', '#1a7f37', '#0969da', '#8250df', '#bf3989', '#6e7781'];

	function setTextColor(color: string | null) {
		const chain = editor?.chain().focus();
		if (color) chain?.setColor(color).run();
		else chain?.unsetColor().run();
		openMenu = null;
	}

	function setAlign(align: 'left' | 'center' | 'right') {
		editor?.chain().focus().setTextAlign(align).run();
		openMenu = null;
	}

	function run(command: (c: ReturnType<Editor['chain']>) => ReturnType<Editor['chain']>) {
		if (editor) command(editor.chain().focus()).run();
		openMenu = null;
	}

	// --- Selection menu ---
	// Bold, italic, link and the like float over selected text, so the
	// common formatting is where you're looking rather than in the toolbar.
	let bodyEl = $state<HTMLDivElement | undefined>();
	let bubble = $state<{ x: number; y: number; below: boolean } | null>(null);

	function updateBubble() {
		if (!editor || !bodyEl) return (bubble = null);
		const { from, to, empty } = editor.state.selection;
		if (empty || !editor.view.hasFocus() || editor.isActive('image')) return (bubble = null);
		const a = editor.view.coordsAtPos(from);
		const b = editor.view.coordsAtPos(to);
		const box = bodyEl.getBoundingClientRect();
		const half = 110;
		const x = Math.min(Math.max((a.left + b.right) / 2 - box.left, half), box.width - half);
		// Above the selection, unless that would put it outside the scrolling
		// body (the first lines), where it would be clipped; then below.
		const top = Math.min(a.top, b.top) - box.top;
		const below = top < 48;
		const y = below ? Math.max(a.bottom, b.bottom) - box.top + 6 : top - 6;
		bubble = { x, y: y + bodyEl.scrollTop, below };
	}

	// --- Attachment upload ---
	function triggerFilePick() {
		fileInputEl?.click();
	}

	async function handleFiles(list: FileList | null) {
		if (!list || list.length === 0) return;
		for (const file of Array.from(list)) {
			if (file.size > MAX_ATTACHMENT_BYTES) {
				showToast({ message: `"${file.name}" exceeds the 25MB limit` });
				continue;
			}
			// Use a stable primitive ID rather than object identity. Values placed
			// inside a Svelte $state array may be exposed through a proxy, so the
			// original object is not a reliable removal key in the finally block.
			const marker = { id: nextUploadId++, name: file.name, size: file.size };
			pendingUploads = [...pendingUploads, marker];
			try {
				const fd = new FormData();
				fd.append('file', file);
				const res = await fetch('/api/upload', { method: 'POST', body: fd });
				const data = await res.json();
				if (res.ok && data.blobId) {
					attachments = [...attachments, data as ComposeAttachment];
				} else {
					showToast({ message: data.error ?? `Could not upload "${file.name}"` });
				}
			} catch {
				showToast({ message: `Could not upload "${file.name}"` });
			} finally {
				pendingUploads = pendingUploads.filter((p) => p.id !== marker.id);
			}
		}
		if (fileInputEl) fileInputEl.value = '';
	}

	function removeAttachment(blobId: string) {
		attachments = attachments.filter((a) => a.blobId !== blobId);
	}

	let dragOver = $state(false);

	function handleDragOver(e: DragEvent) {
		if (!e.dataTransfer?.types.includes('Files')) return;
		e.preventDefault();
		dragOver = true;
	}

	function handleDrop(e: DragEvent) {
		if (!e.dataTransfer?.types.includes('Files')) return;
		e.preventDefault();
		dragOver = false;
		handleFiles(e.dataTransfer.files);
	}

	const totalAttachmentBytes = $derived(attachments.reduce((sum, a) => sum + (a.size ?? 0), 0));

	// The account's default composer font, as a CSS font stack.
	const composerFont = $derived(fontStack(String(page.data.composerFont ?? 'Calibri')));
	const composerFontSize = $derived(`${Number(page.data.composerFontSize) || 12}pt`);

	function fontStack(name: string): string {
		const quoted = /\s/.test(name) ? `'${name}'` : name;
		const generic = /georgia|times|garamond|serif$/i.test(name) && !/sans/i.test(name) ? 'serif' : 'sans-serif';
		return `${quoted}, ${generic}`;
	}

	// The body as sent: wrapped in the default font, so recipients see what
	// the editor showed instead of their own client's default.
	function outgoingBody(html: string): string {
		return `<div style="font-family: ${composerFont}; font-size: ${composerFontSize};">${html}</div>`;
	}

	function buildPayload() {
		return {
			to,
			cc,
			bcc,
			subject,
			body: outgoingBody(body),
			inReplyTo,
			references,
			draftId,
			fromIdentityId: $composer.fromIdentityId,
			attachments,
			importance
		};
	}

	function snapshot(): string {
		return JSON.stringify([to, cc, bcc, subject, body, importance, attachments.map((a) => a.blobId), $composer.fromIdentityId]);
	}

	const isDirty = $derived(snapshot() !== lastSavedSnapshot);

	// Typed text, not counting the signature: a fresh composer holding only
	// the auto-inserted signature isn't worth a draft.
	function bodyHasUserText(): boolean {
		if (!editor) return body.replace(/<[^>]+>/g, '').trim().length > 0;
		let found = false;
		editor.state.doc.descendants((node) => {
			if (found || node.type.name === 'signature') return false;
			if (node.isText && node.text?.trim()) found = true;
			return !found;
		});
		return found;
	}

	function hasContent(): boolean {
		return !!(to.trim() || cc.trim() || bcc.trim() || subject.trim() || attachments.length > 0 || bodyHasUserText());
	}

	async function postApi(
		endpoint: string,
		payload: Record<string, unknown> = buildPayload()
	): Promise<{ ok: boolean; error?: string; draftId?: string; scheduled?: ScheduledSend }> {
		const res = await fetch(endpoint, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(payload)
		});
		const result = await res.json();
		if (result.success) return { ok: true, draftId: result.draftId, scheduled: result.scheduled };
		return { ok: false, error: result.error ?? `Server error (${res.status})`, draftId: result.draftId };
	}

	let saveInFlight: Promise<boolean> | null = null;

	/** Save the open message as a draft without closing. True when saved. */
	async function saveDraftNow(): Promise<boolean> {
		if (saveInFlight) return saveInFlight;
		if (pendingUploads.length > 0) return false;
		const snap = snapshot();
		saveStatus = 'saving';
		saveInFlight = (async () => {
			try {
				const result = await postApi('/api/draft');
				if (!result.ok) {
					saveStatus = 'error';
					return false;
				}
				draftId = result.draftId;
				lastSavedSnapshot = snap;
				saveStatus = 'saved';
				savedAt = new Date();
				return true;
			} catch {
				saveStatus = 'error';
				return false;
			} finally {
				saveInFlight = null;
			}
		})();
		return saveInFlight;
	}

	// Auto-save on the interval from Settings > Composer, which used to be
	// stored and never read.
	$effect(() => {
		if ($composer.mode === 'closed') return;
		const seconds = Math.min(300, Math.max(5, Number(page.data.autoSaveInterval) || 10));
		const timer = setInterval(() => {
			if (sending || savingDraft || discarding || !isDirty || !hasContent()) return;
			void saveDraftNow();
		}, seconds * 1000);
		return () => clearInterval(timer);
	});

	// The Save draft button doubles as the save status, so the footer has
	// room for the Send later arrow and the signature menu.
	const isSaved = $derived(saveStatus === 'saved' && !!savedAt && !isDirty);
	const saveButtonLabel = $derived(
		saveStatus === 'saving' ? 'Saving…' : isSaved ? 'Saved' : 'Save draft'
	);

	/**
	 * Send now, or at `sendAt`. With Undo send on, "now" is a few seconds
	 * out; either way the server holds the message and sends it, and Undo
	 * brings it back here as it is now.
	 */
	async function handleSend(sendAt?: Date) {
		openMenu = null;
		if (!to.trim()) {
			error = 'Recipient is required';
			return;
		}
		if (pendingUploads.length > 0) {
			error = 'Wait for attachments to finish uploading';
			return;
		}
		sending = true;
		error = '';
		const restore = {
			to,
			cc,
			bcc,
			subject,
			body,
			inReplyTo,
			references,
			attachments: [...attachments],
			importance,
			fromIdentityId: $composer.fromIdentityId
		};
		try {
			const result = await postApi('/api/send', {
				...buildPayload(),
				...(sendAt && { sendAt: sendAt.toISOString() })
			});
			if (result.ok) {
				rememberRecipients([
					...to.split(','),
					...cc.split(','),
					...bcc.split(',')
				]);
				closeCompose();
				if (result.scheduled) afterScheduling(result.scheduled, restore);
				else showToast({ message: 'Message sent' });
			} else {
				// A failed send is kept as a draft; carry on with that one.
				if (result.draftId) {
					draftId = result.draftId;
					lastSavedSnapshot = snapshot();
				}
				error = result.error ?? 'Failed to send';
			}
		} catch {
			error = 'Network error';
		} finally {
			sending = false;
		}
	}

	async function handleSaveDraft() {
		if (pendingUploads.length > 0) {
			error = 'Wait for attachments to finish uploading';
			return;
		}
		savingDraft = true;
		error = '';
		try {
			// Saves and stays open; closing is the X (which also saves).
			if (!(await saveDraftNow())) error = 'Could not save the draft';
		} finally {
			savingDraft = false;
		}
	}

	/**
	 * The X. It used to run Discard, which deleted a saved draft and threw
	 * away anything unsaved. Now it saves first and only closes once the
	 * draft is safe; if saving fails the composer stays open.
	 */
	// The corner's Compose button closes an open composer the same way.
	let seenCloseRequest = 0;
	$effect(() => {
		const n = $closeRequests;
		if (n === seenCloseRequest) return;
		seenCloseRequest = n;
		untrack(() => void closeComposer());
	});

	async function closeComposer() {
		if (sending || discarding) return;
		confirmingDiscard = false;
		if (isDirty && hasContent()) {
			if (pendingUploads.length > 0) {
				error = 'Wait for attachments to finish uploading';
				return;
			}
			if (!(await saveDraftNow())) {
				error = 'Could not save the draft. Try again, or use Discard to throw it away.';
				return;
			}
			showToast({ message: 'Draft saved' });
		}
		closeCompose();
	}

	function requestDiscard() {
		// Nothing to lose: discard straight away.
		if (!draftId && !hasContent()) return handleDiscard();
		confirmingDiscard = true;
	}

	async function handleDiscard() {
		if (draftId) {
			discarding = true;
			try {
				await fetch('/api/discard', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ draftId })
				});
			} catch {
				/* best effort */
			} finally {
				discarding = false;
			}
		}
		closeCompose();
	}

	function toggleFullscreen() {
		setMode($composer.mode === 'fullscreen' ? 'popup' : 'fullscreen');
	}

	function minimize() {
		setMode('minimized');
	}

	function restoreFromMinimized() {
		setMode('popup');
	}

	function handleKeydown(e: KeyboardEvent) {
		if (e.key === 'Escape' && confirmingDiscard) {
			confirmingDiscard = false;
			return;
		}
		if (e.key === 'Escape' && openMenu) {
			openMenu = null;
			return;
		}
		if (e.key === 'Escape' && $composer.mode === 'fullscreen') {
			setMode('popup');
			return;
		}
		// Cmd/Ctrl+Enter sends from anywhere in the composer.
		if (
			(e.metaKey || e.ctrlKey) &&
			e.key === 'Enter' &&
			$composer.mode !== 'closed' &&
			$composer.mode !== 'minimized' &&
			!sending &&
			!savingDraft
		) {
			e.preventDefault();
			handleSend();
		}
	}

	// Sync local state from the store on each fresh open.
	// We detect "open" as a transition from `closed` → anything else and
	// avoid clobbering local edits on subsequent mode toggles.
	function loadFromStore() {
		const s = $composer;
		to = s.to;
		cc = s.cc;
		bcc = s.bcc;
		subject = s.subject;
		body = s.body;
		inReplyTo = s.inReplyTo ?? '';
		references = s.references ?? '';
		draftId = s.draftId;
		openedDraft = !!s.draftId;
		isForward = !!s.isForward;
		showCc = !!s.cc;
		showBcc = !!s.bcc;
		error = '';
		importance = s.importance ?? 'normal';
		attachments = [...(s.attachments ?? [])];
		pendingUploads = [];
		openMenu = null;
		bubble = null;
		confirmingDiscard = false;
		saveStatus = 'idle';
		savedAt = null;
		lastAppliedSignatureId = 'unset';
		// What was opened counts as saved: an untouched reply or draft isn't
		// written back just for being opened.
		lastSavedSnapshot = snapshot();
	}

	$effect(() => {
		const mode = $composer.mode;
		const session = $composer.session;
		if (lastMode === 'closed' && mode !== 'closed') {
			loadFromStore();
		} else if (mode !== 'closed' && session !== lastSession && lastSession !== 0) {
			// Reply (or New message) while already writing one: this used to be
			// ignored, leaving the old message in place. Keep the old one as a
			// draft, then switch to the new one.
			if (isDirty && hasContent() && pendingUploads.length === 0) {
				void postApi('/api/draft', buildPayload()).then((r) => {
					if (r.ok) showToast({ message: 'Your other message was saved as a draft' });
				});
			}
			loadFromStore();
			editor?.commands.setContent(body, { emitUpdate: false });
		} else if (lastMode !== 'closed' && mode === 'closed') {
			// Tear down Tiptap when the composer fully closes — its mount node
			// is unmounted by the {#if}, so leaving the instance alive points
			// it at a detached element and the next open won't re-init.
			editor?.destroy();
			editor = null;
		}
		lastMode = mode;
		lastSession = session;
	});

	// Spin up Tiptap as soon as the editor mount node exists. Re-fires on
	// every open because we destroyed the editor on close.
	$effect(() => {
		if ($composer.mode === 'closed') return;
		if (!editorEl) return;
		if (editor) return;
		initEditor(body);
	});

	// Pick a default From identity (primary, or the first one we have) the
	// first time the composer opens with no explicit fromIdentityId set.
	$effect(() => {
		if ($composer.mode === 'closed') return;
		if (!$userState.loaded) return;
		if ($composer.fromIdentityId !== null) return;
		const ids = $userState.identities;
		if (ids.length === 0) return;
		const primary = ids.find((i) => i.isPrimary) ?? ids[0];
		const wasClean = !isDirty;
		setFromIdentity(primary.jmapId);
		// Filled in by the app, not chosen: an untouched message stays clean.
		if (wasClean) lastSavedSnapshot = snapshot();
	});

	// Auto-resolve signature based on the current From identity. Re-runs
	// whenever fromIdentityId changes (so switching aliases swaps to the
	// per-identity override) UNLESS the user has manually picked one — in
	// which case their choice is respected for the rest of the session.
	$effect(() => {
		if ($composer.mode === 'closed') return;
		if (!$userState.loaded) return;
		if ($composer.signatureManuallyChosen) return;
		// New conversations only — don't bury an existing reply/draft body
		// under an auto-signature.
		if (inReplyTo || draftId || isForward) return;
		const id = resolveSignatureForIdentity($composer.fromIdentityId);
		if (id !== $composer.signatureId) setSignature(id, false);
	});

	// Whenever the resolved signatureId changes, rewrite the body so the
	// signature block matches. Skip the very first apply if the body already
	// contains a signature marker (e.g. an existing draft).
	$effect(() => {
		const sigId = $composer.signatureId;
		if ($composer.mode === 'closed') return;
		if (!editor) return;
		if (sigId === lastAppliedSignatureId) return;
		const sig = getSignatureById(sigId);
		const next = applySignature(body, sig?.html ?? null);
		if (next !== body) {
			const wasClean = !isDirty;
			editor.commands.setContent(next, { emitUpdate: false });
			body = next;
			// Inserted by the app, not typed: an untouched message stays clean.
			if (wasClean) lastSavedSnapshot = snapshot();
		}
		lastAppliedSignatureId = sigId;
	});
</script>

<svelte:window onkeydown={handleKeydown} onpointerdown={closeMenusOnOutsideClick} />

{#snippet markButtons()}
	<button type="button" onclick={() => run((c) => c.toggleBold())} class="fc-btn {isActive('bold') ? 'fc-active' : ''}" title="Bold" aria-label="Bold" aria-pressed={isActive('bold')}><Icon name="bold" /></button>
	<button type="button" onclick={() => run((c) => c.toggleItalic())} class="fc-btn {isActive('italic') ? 'fc-active' : ''}" title="Italic" aria-label="Italic" aria-pressed={isActive('italic')}><Icon name="italic" /></button>
	<button type="button" onclick={() => run((c) => c.toggleUnderline())} class="fc-btn {isActive('underline') ? 'fc-active' : ''}" title="Underline" aria-label="Underline" aria-pressed={isActive('underline')}><Icon name="underline" /></button>
	<button type="button" onclick={() => run((c) => c.toggleStrike())} class="fc-btn {isActive('strike') ? 'fc-active' : ''}" title="Strikethrough" aria-label="Strikethrough" aria-pressed={isActive('strike')}><Icon name="strikethrough" /></button>
{/snippet}

{#if $composer.mode === 'fullscreen'}
	<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
	<div class="fixed inset-0 bg-black/60 z-40 animate-compose-backdrop-in" onclick={() => setMode('popup')}></div>
{/if}

{#if $composer.mode !== 'closed'}
	<!-- Single hidden file input drives every attach button across modes. -->
	<input
		bind:this={fileInputEl}
		type="file"
		multiple
		class="hidden"
		onchange={(e) => handleFiles((e.target as HTMLInputElement).files)}
	/>
	<div
		class="composer-shell bg-bg border border-border shadow-[0_16px_48px_rgba(0,0,0,0.5)] flex flex-col z-50"
		in:cornerWindow={{ duration: 200, easing: expoOut }}
		out:cornerWindow={{ duration: 140, easing: expoOut }}
		class:composer--popup={$composer.mode === 'popup'}
		class:composer--fullscreen={$composer.mode === 'fullscreen'}
		class:composer--minimized={$composer.mode === 'minimized'}
		role="dialog"
		aria-label="Compose email"
		aria-modal={$composer.mode === 'fullscreen'}
	>
		<!-- Title bar. Minimized, it is the whole composer and restores on click. -->
		<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
		<div
			class="flex items-center justify-between pl-4 pr-2 h-10 bg-surface border-b border-border shrink-0 {$composer.mode === 'minimized' ? 'cursor-pointer' : ''}"
			onclick={() => { if ($composer.mode === 'minimized') restoreFromMinimized(); }}
		>
			<span class="text-sm font-medium text-text truncate flex-1">{displayTitle}</span>
			<div class="flex items-center gap-0.5 shrink-0 ml-2">
				{#if $composer.mode === 'minimized'}
					<button onclick={(e) => { e.stopPropagation(); restoreFromMinimized(); }} aria-label="Restore" title="Restore" class="header-btn">
						<Icon name="restore" size={14} />
					</button>
				{:else}
					<!-- The title bar restores a minimized composer on click, so these
					     must not reach it: Minimize used to restore straight away. -->
					<button onclick={(e) => { e.stopPropagation(); minimize(); }} aria-label="Minimize" title="Minimize" class="header-btn">
						<Icon name="minimize" size={14} />
					</button>
					<button
						onclick={(e) => { e.stopPropagation(); toggleFullscreen(); }}
						aria-label={$composer.mode === 'fullscreen' ? 'Exit full screen' : 'Full screen'}
						title={$composer.mode === 'fullscreen' ? 'Exit full screen' : 'Full screen'}
						class="header-btn"
					>
						{#if $composer.mode === 'fullscreen'}
							<Icon name="exit-full-screen" size={14} />
						{:else}
							<Icon name="full-screen" size={14} />
						{/if}
					</button>
				{/if}
				<button onclick={(e) => { e.stopPropagation(); void closeComposer(); }} aria-label="Save draft and close" title="Save draft and close" class="header-btn">
					<Icon name="close" size={14} />
				</button>
			</div>
		</div>

		<!-- Recipient fields -->
		<div class="shrink-0 border-b border-border" class:hidden={$composer.mode === 'minimized'}>
			<FromPicker />
			<div class="relative">
				<RecipientInput bind:value={to} label="To" />
				{#if !showCc || !showBcc}
					<div class="absolute right-3 top-1.5 flex items-center gap-2">
						{#if !showCc}<button type="button" onclick={() => (showCc = true)} class="text-xs text-text-tertiary hover:text-text cursor-pointer">Cc</button>{/if}
						{#if !showBcc}<button type="button" onclick={() => (showBcc = true)} class="text-xs text-text-tertiary hover:text-text cursor-pointer">Bcc</button>{/if}
					</div>
				{/if}
			</div>
			{#if showCc}
				<RecipientInput bind:value={cc} label="Cc" />
			{/if}
			{#if showBcc}
				<RecipientInput bind:value={bcc} label="Bcc" />
			{/if}
			<div class="flex items-center pl-3 pr-3 py-2">
				<span class="text-xs text-text-tertiary w-12 shrink-0">Subject</span>
				<input bind:value={subject} type="text" aria-label="Subject" class="flex-1 bg-transparent text-sm font-medium text-text outline-none focus-visible:outline-none!" />
			</div>
		</div>

		{#if error}
			<div class="px-4 py-1.5 bg-danger/10 border-b border-danger/20 shrink-0" class:hidden={$composer.mode === 'minimized'}>
				<p class="text-xs text-danger">{error}</p>
			</div>
		{/if}

		<!-- Editor body — always rendered, hidden when minimized -->
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<div
			bind:this={bodyEl}
			class="relative flex-1 overflow-y-auto px-4 py-3 min-h-0"
			class:hidden={$composer.mode === 'minimized'}
			ondragover={handleDragOver}
			ondragleave={() => (dragOver = false)}
			ondrop={handleDrop}
		>
			<div
				bind:this={editorEl}
				class="min-h-full full-composer-editor"
				style="--composer-font: {composerFont}; --composer-size: {composerFontSize};"
			></div>

			{#if bubble}
				<div
					class="absolute z-30 flex items-center gap-0.5 p-1 rounded-lg border border-border bg-surface shadow-[0_8px_24px_rgba(0,0,0,0.35)] -translate-x-1/2 {bubble.below ? '' : '-translate-y-full'}"
					style="left: {bubble.x}px; top: {bubble.y}px;"
					onmousedown={(e) => e.preventDefault()}
					role="toolbar"
					tabindex="-1"
					aria-label="Format selection"
				>
					{@render markButtons()}
					<div class="fc-sep"></div>
					<button type="button" onclick={openLinkPopover} class="fc-btn {isActive('link') ? 'fc-active' : ''}" title="Link" aria-label="Link">
						<Icon name="link" size={16} />
					</button>
					<button type="button" onclick={() => run((c) => c.toggleHighlight())} class="fc-btn {isActive('highlight') ? 'fc-active' : ''}" title="Highlight" aria-label="Highlight">
						<Icon name="highlight" size={16} />
					</button>
					<button type="button" onclick={() => run((c) => c.clearNodes().unsetAllMarks())} class="fc-btn" title="Clear formatting" aria-label="Clear formatting">
						<Icon name="clear-formatting" size={16} />
					</button>
				</div>
			{/if}

			{#if dragOver}
				<div class="absolute inset-2 z-20 flex items-center justify-center rounded-lg border-2 border-dashed border-accent bg-accent/10 pointer-events-none">
					<span class="text-sm font-medium text-accent-fg">Drop files to attach</span>
				</div>
			{/if}
		</div>

		<!-- Attachment tray -->
		{#if attachments.length > 0 || pendingUploads.length > 0}
			<div class="shrink-0 px-4 py-2 flex flex-wrap gap-1.5" class:hidden={$composer.mode === 'minimized'}>
				{#each attachments as a (a.blobId)}
					<span class="inline-flex items-center gap-1.5 h-8 pl-2.5 pr-1 rounded-lg bg-surface border border-border text-xs text-text max-w-[240px]">
						<span class="shrink-0 text-text-tertiary"><Icon name="attachment" size={14} /></span>
						<span class="truncate" title={a.name}>{a.name}</span>
						<span class="shrink-0 text-text-tertiary tabular-nums">{formatBytes(a.size)}</span>
						<button type="button" onclick={() => removeAttachment(a.blobId)} class="shrink-0 w-5 h-5 grid place-items-center rounded-md text-text-tertiary hover:text-text hover:bg-surface-hover cursor-pointer" aria-label={`Remove ${a.name}`}>
							<Icon name="close" size={14} />
						</button>
					</span>
				{/each}
				{#each pendingUploads as u (u.id)}
					<span class="inline-flex items-center gap-1.5 h-8 px-2.5 rounded-lg bg-surface border border-border text-xs text-text-tertiary max-w-[240px]">
						<Icon name="loading" size={14} class="animate-spin" />
						<span class="truncate">{u.name}</span>
					</span>
				{/each}
				{#if attachments.length > 1}
					<span class="self-center text-xs text-text-tertiary tabular-nums">{formatBytes(totalAttachmentBytes)}</span>
				{/if}
			</div>
		{/if}

		<!-- Formatting bar: the same in the popup and full screen. -->
		<div
			class="shrink-0 flex items-center gap-0.5 flex-wrap px-2 py-1 border-t border-border"
			class:hidden={$composer.mode === 'minimized'}
			role="toolbar"
			aria-label="Formatting"
		>
			<div class="relative" data-menu-root>
				<button type="button" onclick={() => toggleMenu('size')} class="fc-btn {openMenu === 'size' ? 'fc-active' : ''}" title="Text size" aria-label="Text size" aria-haspopup="menu" aria-expanded={openMenu === 'size'}>
					<Icon name="text-size" size={16} />
				</button>
				{#if openMenu === 'size'}
					<div class="absolute bottom-full mb-1 left-0 z-50 w-36 py-1 rounded-lg border border-border bg-surface shadow-[0_8px_24px_rgba(0,0,0,0.35)]" role="menu">
						{#each TEXT_SIZES as t (t.label)}
							<button type="button" role="menuitem" onclick={() => setTextSize(t.size)} class="w-full text-left px-3 py-1.5 text-text hover:bg-surface-hover cursor-pointer" style={t.size ? `font-size: ${t.size}` : ''}>{t.label}</button>
						{/each}
					</div>
				{/if}
			</div>
			<div class="fc-sep"></div>
			{@render markButtons()}
			<div class="relative" data-menu-root>
				<button type="button" onclick={() => toggleMenu('color')} class="fc-btn {openMenu === 'color' ? 'fc-active' : ''}" title="Text color" aria-label="Text color" aria-haspopup="menu" aria-expanded={openMenu === 'color'}>
					<span class="flex flex-col items-center leading-none">
						<Icon name="text-color" size={14} />
						<span class="mt-0.5 h-0.5 w-3.5 rounded-full" style="background: {(editor?.getAttributes('textStyle').color as string) ?? 'currentColor'}"></span>
					</span>
				</button>
				{#if openMenu === 'color'}
					<div class="absolute bottom-full mb-1 left-0 z-50 p-2 rounded-lg border border-border bg-surface shadow-[0_8px_24px_rgba(0,0,0,0.35)]" role="menu" aria-label="Text color">
						<div class="grid grid-cols-4 gap-1.5">
							{#each TEXT_COLORS as color}
								<button type="button" role="menuitem" onclick={() => setTextColor(color)} class="w-6 h-6 rounded-full cursor-pointer ring-offset-2 ring-offset-surface hover:ring-2 hover:ring-border" style="background: {color}" aria-label="Color {color}"></button>
							{/each}
						</div>
						<button type="button" role="menuitem" onclick={() => setTextColor(null)} class="mt-2 w-full text-left px-1 py-1 text-xs text-text-secondary hover:text-text cursor-pointer">Default color</button>
					</div>
				{/if}
			</div>
			<button type="button" onclick={() => run((c) => c.toggleHighlight())} class="fc-btn {isActive('highlight') ? 'fc-active' : ''}" title="Highlight" aria-label="Highlight" aria-pressed={isActive('highlight')}>
				<Icon name="highlight" size={16} />
			</button>
			<div class="fc-sep"></div>
			<button type="button" onclick={() => run((c) => c.toggleBulletList())} class="fc-btn {isActive('bulletList') ? 'fc-active' : ''}" title="Bulleted list" aria-label="Bulleted list" aria-pressed={isActive('bulletList')}>
				<Icon name="bulleted-list" size={16} />
			</button>
			<button type="button" onclick={() => run((c) => c.toggleOrderedList())} class="fc-btn {isActive('orderedList') ? 'fc-active' : ''}" title="Numbered list" aria-label="Numbered list" aria-pressed={isActive('orderedList')}>
				<Icon name="numbered-list" size={16} />
			</button>
			<button type="button" onclick={() => run((c) => c.toggleBlockquote())} class="fc-btn {isActive('blockquote') ? 'fc-active' : ''}" title="Quote" aria-label="Quote" aria-pressed={isActive('blockquote')}>
				<Icon name="quote" size={16} />
			</button>
			<div class="relative" data-menu-root>
				<button type="button" onclick={() => toggleMenu('align')} class="fc-btn {openMenu === 'align' ? 'fc-active' : ''}" title="Align" aria-label="Align" aria-haspopup="menu" aria-expanded={openMenu === 'align'}>
					{#if isActive('', { textAlign: 'center' })}
						<Icon name="align-center" size={16} />
					{:else if isActive('', { textAlign: 'right' })}
						<Icon name="align-right" size={16} />
					{:else}
						<Icon name="align-left" size={16} />
					{/if}
				</button>
				{#if openMenu === 'align'}
					<div class="absolute bottom-full mb-1 left-0 z-50 flex gap-0.5 p-1 rounded-lg border border-border bg-surface shadow-[0_8px_24px_rgba(0,0,0,0.35)]" role="menu" aria-label="Align">
						<button type="button" role="menuitem" onclick={() => setAlign('left')} class="fc-btn" title="Align left" aria-label="Align left"><Icon name="align-left" size={16} /></button>
						<button type="button" role="menuitem" onclick={() => setAlign('center')} class="fc-btn" title="Center" aria-label="Center"><Icon name="align-center" size={16} /></button>
						<button type="button" role="menuitem" onclick={() => setAlign('right')} class="fc-btn" title="Align right" aria-label="Align right"><Icon name="align-right" size={16} /></button>
					</div>
				{/if}
			</div>
			<div class="fc-sep"></div>
			<button type="button" onclick={() => run((c) => c.clearNodes().unsetAllMarks())} class="fc-btn" title="Clear formatting" aria-label="Clear formatting">
				<Icon name="clear-formatting" size={16} />
			</button>
			<div class="relative" data-menu-root>
				<button type="button" onclick={() => toggleMenu('more')} class="fc-btn {openMenu === 'more' ? 'fc-active' : ''}" title="More formatting" aria-label="More formatting" aria-haspopup="menu" aria-expanded={openMenu === 'more'}>
					<Icon name="more" size={16} />
				</button>
				{#if openMenu === 'more'}
					<div class="absolute bottom-full mb-1 left-0 z-50 w-48 py-1 rounded-lg border border-border bg-surface shadow-[0_8px_24px_rgba(0,0,0,0.35)] text-sm" role="menu">
						{#if isActive('table')}
							<button type="button" role="menuitem" onclick={() => run((c) => c.addRowAfter())} class="w-full text-left px-3 py-1.5 text-text hover:bg-surface-hover cursor-pointer">Add row</button>
							<button type="button" role="menuitem" onclick={() => run((c) => c.addColumnAfter())} class="w-full text-left px-3 py-1.5 text-text hover:bg-surface-hover cursor-pointer">Add column</button>
							<button type="button" role="menuitem" onclick={() => run((c) => c.deleteRow())} class="w-full text-left px-3 py-1.5 text-text hover:bg-surface-hover cursor-pointer">Delete row</button>
							<button type="button" role="menuitem" onclick={() => run((c) => c.deleteColumn())} class="w-full text-left px-3 py-1.5 text-text hover:bg-surface-hover cursor-pointer">Delete column</button>
							<button type="button" role="menuitem" onclick={() => run((c) => c.deleteTable())} class="w-full text-left px-3 py-1.5 text-danger hover:bg-danger/10 cursor-pointer">Delete table</button>
							<div class="my-1 h-px bg-border"></div>
						{:else}
							<button type="button" role="menuitem" onclick={() => run((c) => c.insertTable({ rows: 3, cols: 3, withHeaderRow: true }))} class="w-full text-left px-3 py-1.5 text-text hover:bg-surface-hover cursor-pointer">Insert table</button>
						{/if}
						<button type="button" role="menuitem" onclick={() => run((c) => c.setHorizontalRule())} class="w-full text-left px-3 py-1.5 text-text hover:bg-surface-hover cursor-pointer">Divider</button>
						<button type="button" role="menuitem" onclick={() => run((c) => c.sinkListItem('listItem'))} class="w-full text-left px-3 py-1.5 text-text hover:bg-surface-hover cursor-pointer">Indent</button>
						<button type="button" role="menuitem" onclick={() => run((c) => c.liftListItem('listItem'))} class="w-full text-left px-3 py-1.5 text-text hover:bg-surface-hover cursor-pointer">Outdent</button>
						<button type="button" role="menuitem" onclick={() => run((c) => c.toggleSubscript())} class="w-full text-left px-3 py-1.5 text-text hover:bg-surface-hover cursor-pointer">Subscript</button>
						<button type="button" role="menuitem" onclick={() => run((c) => c.toggleSuperscript())} class="w-full text-left px-3 py-1.5 text-text hover:bg-surface-hover cursor-pointer">Superscript</button>
					</div>
				{/if}
			</div>
		</div>

		<!-- Footer -->
		<div
			class="flex items-center gap-1 px-3 py-2 border-t border-border shrink-0 bg-surface"
			class:hidden={$composer.mode === 'minimized'}
		>
			<div class="relative flex" data-menu-root>
				<button
					onclick={() => handleSend()}
					disabled={sending || savingDraft}
					title="Send ({shortcutLabel('Enter')})"
					class="btn btn-primary px-5 rounded-r-none"
				>
					{sending ? 'Sending…' : 'Send'}
				</button>
				<button
					type="button"
					onclick={toggleSendLater}
					disabled={sending || savingDraft}
					class="btn btn-primary px-1.5 rounded-l-none border-l border-l-black/25"
					title="Send later"
					aria-label="Send later"
					aria-haspopup="menu"
					aria-expanded={openMenu === 'schedule'}
				>
					<Icon name="send-later" size={14} />
				</button>
				{#if openMenu === 'schedule'}
					<div class="absolute bottom-full mb-1 left-0 z-50 w-72 py-1 rounded-lg border border-border bg-surface shadow-[0_8px_24px_rgba(0,0,0,0.35)] text-sm" role="menu" aria-label="Send later">
						{#if !pickingTime}
							{#each presets as preset (preset.label)}
								<button type="button" role="menuitem" onclick={() => handleSend(preset.at)} class="w-full flex items-center justify-between gap-3 text-left px-3 py-1.5 hover:bg-surface-hover cursor-pointer">
									<span class="text-text">{preset.label}</span>
									<span class="text-xs text-text-tertiary">{formatSendDate(preset.at)}</span>
								</button>
							{/each}
							<div class="my-1 border-t border-border"></div>
							<button type="button" role="menuitem" onclick={() => (pickingTime = true)} class="w-full flex items-center gap-2 text-left px-3 py-1.5 text-text hover:bg-surface-hover cursor-pointer">
								<Icon name="pick-date" size={14} />
								Pick date & time
							</button>
						{:else}
							<div class="px-2 py-1.5 space-y-2">
								<div class="flex items-center gap-2">
									<input
										type="date"
										bind:value={pickDate}
										min={toInputValues(new Date()).date}
										aria-label="Send date"
										class="flex-1 min-w-0 bg-bg border border-border rounded-md px-2 py-1.5 text-sm text-text outline-none focus:border-accent"
									/>
									<input
										type="time"
										bind:value={pickTime}
										aria-label="Send time"
										class="w-32 bg-bg border border-border rounded-md px-2 py-1.5 text-sm text-text outline-none focus:border-accent"
									/>
								</div>
								{#if pickError}
									<p class="text-xs text-danger" aria-live="polite">{pickError}</p>
								{/if}
								<div class="flex items-center justify-end gap-1.5">
									<button type="button" onclick={() => (pickingTime = false)} class="btn btn-ghost btn-sm">Back</button>
									<button type="button" onclick={sendAtPicked} class="btn btn-primary btn-sm">Schedule send</button>
								</div>
							</div>
						{/if}
					</div>
				{/if}
			</div>
			<button
				onclick={handleSaveDraft}
				disabled={sending || savingDraft || saveStatus === 'saving'}
				title={isSaved && savedAt ? `Saved at ${savedAt.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}` : undefined}
				class="btn btn-ghost min-w-[5.75rem] {isSaved ? 'text-text-tertiary' : ''}"
				aria-live="polite"
			>
				{saveButtonLabel}
			</button>
			{#if saveStatus === 'error'}
				<span class="ml-1 text-xs truncate text-danger" aria-live="polite">Not saved</span>
			{/if}
			<div class="flex-1"></div>

			{#if confirmingDiscard}
				<span class="text-xs text-text-secondary mr-1">Discard this draft?</span>
				<button onclick={() => (confirmingDiscard = false)} class="btn btn-ghost btn-sm">Keep</button>
				<button onclick={handleDiscard} disabled={discarding} class="btn btn-danger-solid btn-sm">
					{discarding ? 'Discarding…' : 'Discard'}
				</button>
			{:else}
				<button type="button" onclick={triggerFilePick} class="fc-btn" title="Attach files" aria-label="Attach files">
					<Icon name="attachment" size={16} />
				</button>
				<div class="relative" data-menu-root>
					<button type="button" onclick={() => toggleMenu('link')} class="fc-btn {openMenu === 'link' || isActive('link') ? 'fc-active' : ''}" title="Link" aria-label="Link" aria-haspopup="dialog" aria-expanded={openMenu === 'link'}>
						<Icon name="link" size={16} />
					</button>
					{#if openMenu === 'link'}
						<div class="absolute bottom-full mb-1 right-0 z-50 w-72 p-2 rounded-lg border border-border bg-surface shadow-[0_8px_24px_rgba(0,0,0,0.35)]">
							<!-- svelte-ignore a11y_autofocus -->
							<input
								bind:value={linkUrl}
								type="text"
								aria-label="Link address"
								autofocus
								onkeydown={(e) => { if (e.key === 'Enter') { e.preventDefault(); applyLink(); } }}
								class="w-full bg-bg border border-border rounded-md px-2 py-1.5 text-sm text-text outline-none focus:border-accent"
							/>
							<div class="flex items-center justify-end gap-1.5 mt-2">
								<button type="button" onclick={() => (openMenu = null)} class="btn btn-ghost btn-sm">Cancel</button>
								<button type="button" onclick={applyLink} class="btn btn-primary btn-sm">Apply</button>
							</div>
						</div>
					{/if}
				</div>
				<div class="relative" data-menu-root>
					<button type="button" onclick={() => toggleMenu('emoji')} class="fc-btn {openMenu === 'emoji' ? 'fc-active' : ''}" title="Emoji" aria-label="Emoji" aria-haspopup="menu" aria-expanded={openMenu === 'emoji'}>
						<Icon name="emoji" size={16} />
					</button>
					{#if openMenu === 'emoji'}
						<div class="absolute bottom-full mb-1 right-0 z-50 p-2 rounded-lg border border-border bg-surface shadow-[0_8px_24px_rgba(0,0,0,0.35)] grid grid-cols-[repeat(6,2rem)] gap-1 w-max" role="menu" aria-label="Emoji">
							{#each EMOJIS as emoji}
								<button type="button" role="menuitem" onclick={() => insertEmoji(emoji)} class="w-8 h-8 flex items-center justify-center text-lg rounded-md hover:bg-surface-hover cursor-pointer">{emoji}</button>
							{/each}
						</div>
					{/if}
				</div>
				<div class="relative" data-menu-root>
					<button
						type="button"
						onclick={() => toggleMenu('importance')}
						class="fc-btn {importance === 'high' ? 'fc-active-red' : importance === 'low' ? 'fc-active-blue' : openMenu === 'importance' ? 'fc-active' : ''}"
						title="Importance: {importance}"
						aria-label="Importance"
						aria-haspopup="menu"
						aria-expanded={openMenu === 'importance'}
					>
						<Icon name={importance === 'high' ? 'importance-high' : importance === 'low' ? 'importance-low' : 'importance'} />
					</button>
					{#if openMenu === 'importance'}
						<div class="absolute bottom-full mb-1 right-0 z-50 w-40 py-1 rounded-lg border border-border bg-surface shadow-[0_8px_24px_rgba(0,0,0,0.35)] text-sm" role="menu" aria-label="Importance">
							{#each [['high', 'High importance'], ['normal', 'Normal'], ['low', 'Low importance']] as [value, label] (value)}
								<button type="button" role="menuitemradio" aria-checked={importance === value} onclick={() => { importance = value as typeof importance; openMenu = null; }} class="w-full flex items-center gap-2 text-left px-3 py-1.5 text-text hover:bg-surface-hover cursor-pointer">
									<span class="w-3.5 text-accent-fg">{#if importance === value}<Icon name="check" size={14} />{/if}</span>
									{label}
								</button>
							{/each}
						</div>
					{/if}
				</div>
				<SignaturePicker />
				<div class="fc-sep"></div>
				<button
					onclick={requestDiscard}
					disabled={sending || savingDraft || discarding}
					class="fc-btn hover:text-danger"
					title="Discard draft"
					aria-label="Discard draft"
				>
					<Icon name="delete" size={16} />
				</button>
			{/if}
		</div>
	</div>
{/if}

<style>
	.composer-shell {
		position: fixed;
		border-radius: 12px;
		overflow: hidden;
		transition: width 0.18s ease, height 0.18s ease, top 0.18s ease, left 0.18s ease, bottom 0.18s ease, right 0.18s ease, border-radius 0.18s ease;
	}
	/* Above the corner buttons, the same size as Zajel's card. */
	.composer--popup {
		bottom: var(--corner-window-bottom);
		right: var(--corner-window-right);
		width: var(--corner-window-width);
		height: var(--corner-window-height);
		max-width: calc(100vw - 96px);
		transform-origin: bottom right;
	}
	.composer--fullscreen {
		top: 50%;
		left: 50%;
		transform: translate(-50%, -50%);
		width: 80vw;
		height: 84vh;
		max-width: 1100px;
	}
	/* Beside the corner buttons, on their row: 68px rail gap + two 48px
	   circles and the 10px between them + 12px. */
	.composer--minimized {
		bottom: 24px;
		right: 186px;
		width: 280px;
		height: 40px;
		border-radius: 10px;
	}
	/* Phones: a 540px floating window doesn't fit, so both the popup and the
	   expanded composer take the whole screen. Same breakpoint as Tailwind's
	   `md`, which the rest of the phone layout keys off. */
	@media (max-width: 767.98px) {
		.composer--popup,
		.composer--fullscreen {
			inset: 0;
			width: 100%;
			height: 100dvh;
			max-width: none;
			max-height: none;
			transform: none;
			border-radius: 0;
			/* Clear of the status bar and home indicator when run from the
			   Home Screen (0 in a browser tab). */
			padding-top: env(safe-area-inset-top);
			padding-bottom: env(safe-area-inset-bottom);
		}
		/* Just above the tab bar, clear of the corner buttons above it. */
		.composer--minimized {
			right: 8px;
			bottom: calc(3.5rem + env(safe-area-inset-bottom) + 8px);
			width: calc(100vw - 16px);
		}
	}

	.header-btn {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 26px;
		height: 26px;
		border-radius: 4px;
		color: var(--color-text-tertiary);
		background: transparent;
		border: none;
		cursor: pointer;
		transition: background 0.1s, color 0.1s;
	}
	.header-btn:hover {
		background: var(--color-surface-hover);
		color: var(--color-text);
	}

	/*
	 * The .fc-* toolbar rules live in routes/layout.css. They were duplicated
	 * here as :global() overrides, which shipped in a second chunk and silently
	 * won on some properties — including a plain :hover that highlighted
	 * disabled buttons. One definition now.
	 */
	:global(.full-composer-editor .ProseMirror) {
		outline: none;
		min-height: 200px;
		font-family: Calibri, 'Segoe UI', Arial, sans-serif;
		font-size: 14px;
		line-height: 1.5;
		color: var(--color-text);
	}
	/* Outlook-style single-spacing: Enter starts a new paragraph that sits
	   directly below the previous one. No per-paragraph bottom margin, so the
	   text doesn't read as double-spaced. An explicit blank line still creates
	   a real gap. */
	:global(.full-composer-editor .ProseMirror p) {
		margin: 0;
	}
	:global(.full-composer-editor .ProseMirror ul) {
		list-style: disc;
		padding-left: 1.5em;
	}
	:global(.full-composer-editor .ProseMirror ol) {
		list-style: decimal;
		padding-left: 1.5em;
	}
	:global(.full-composer-editor .ProseMirror a) {
		color: var(--color-accent);
		text-decoration: underline;
	}
	:global(.full-composer-editor .ProseMirror img) {
		max-width: 100%;
		height: auto;
		border-radius: 4px;
	}
	:global(.full-composer-editor .ProseMirror blockquote) {
		border-left: 3px solid var(--color-border);
		padding-left: 1em;
		margin-left: 0;
		color: var(--color-text-secondary);
	}
	:global(.full-composer-editor .ProseMirror .is-editor-empty:first-child::before) {
		content: attr(data-placeholder);
		color: var(--color-text-tertiary);
		pointer-events: none;
		float: left;
		height: 0;
	}
</style>
