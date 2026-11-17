import { writable } from 'svelte/store';
import type { ComposeAttachment } from '$lib/jmap/types';
import type { ImageSources } from '$lib/editor/body-html';

export type ComposerMode = 'popup' | 'fullscreen' | 'minimized' | 'closed';

export interface ComposeData {
	to: string;
	cc: string;
	bcc: string;
	subject: string;
	body: string;
	inReplyTo?: string;
	references?: string;
	draftId?: string;
	isForward?: boolean;
	fromIdentityId?: string | null;
	/** Blobs already on the server: a draft's attachments, or a forward's. */
	attachments?: ComposeAttachment[];
	/**
	 * Inline parts of the message being quoted, forwarded or reopened: the
	 * pictures its body draws by Content-ID. Sent along as inline parts while
	 * the body still draws them.
	 */
	inlineParts?: ComposeAttachment[];
	/** Where the body's pictures can be shown from while it is edited. */
	images?: ImageSources;
	importance?: 'high' | 'normal' | 'low';
}

export interface ComposerState extends ComposeData {
	mode: ComposerMode;
	/** Bumped by every openCompose, so the composer can tell a new message
	 *  (Reply while already writing something) from a mode change. */
	session: number;
	signatureId: number | null;
	signatureManuallyChosen: boolean;
	fromIdentityId: string | null;
}

const defaultState: ComposerState = {
	to: '',
	cc: '',
	bcc: '',
	subject: '',
	body: '',
	mode: 'closed',
	session: 0,
	signatureId: null,
	signatureManuallyChosen: false,
	fromIdentityId: null
};

export const composer = writable<ComposerState>(defaultState);

let sessionCounter = 0;

export function openCompose(init: Partial<ComposeData> = {}) {
	composer.set({
		...defaultState,
		...init,
		session: ++sessionCounter,
		mode: 'popup',
		signatureId: null,
		signatureManuallyChosen: false,
		fromIdentityId: init.fromIdentityId ?? null
	});
}

export function closeCompose() {
	composer.set(defaultState);
}

/**
 * Ask the open composer to close the way its X does: a message with anything
 * in it is saved as a draft first, an empty one just closes. A counter, so
 * the composer can tell one request from the next.
 */
export const closeRequests = writable(0);

export function requestCloseCompose() {
	closeRequests.update((n) => n + 1);
}

export function setMode(mode: ComposerMode) {
	composer.update((s) => ({ ...s, mode }));
}

export function setSignature(id: number | null, manual = true) {
	composer.update((s) => ({ ...s, signatureId: id, signatureManuallyChosen: manual }));
}

export function setFromIdentity(identityId: string | null) {
	composer.update((s) => ({ ...s, fromIdentityId: identityId }));
}
