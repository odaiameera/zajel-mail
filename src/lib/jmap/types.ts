export interface EmailAddress {
	name: string | null;
	email: string;
}

export interface JMAPSession {
	apiUrl: string;
	downloadUrl: string;
	uploadUrl: string;
	eventSourceUrl: string;
	primaryAccounts: Record<string, string>;
	accounts: Record<
		string,
		{
			name: string;
			isPersonal: boolean;
			isReadOnly: boolean;
			accountCapabilities?: Record<string, unknown>;
		}
	>;
	capabilities: Record<string, unknown>;
	state: string;
}

export interface AddressBook {
	id: string;
	name: string;
	description: string | null;
	sortOrder: number;
	isDefault: boolean;
	isSubscribed: boolean;
	myRights: {
		mayRead: boolean;
		mayWrite: boolean;
		mayShare: boolean;
		mayDelete: boolean;
	};
}

export interface JSContactEmail {
	address: string;
	contexts?: Record<string, boolean>;
	pref?: number;
	label?: string;
	[key: string]: unknown;
}

export interface JSContactPhone {
	number: string;
	contexts?: Record<string, boolean>;
	pref?: number;
	label?: string;
	[key: string]: unknown;
}

export interface JSContactName {
	full?: string;
	components?: Array<{ kind: string; value: string }>;
	isOrdered?: boolean;
	[key: string]: unknown;
}

export interface JSContactCard {
	'@type': 'Card';
	version: '1.0';
	uid: string;
	kind?: 'individual' | 'group' | 'org' | 'location' | 'device' | 'application' | string;
	name?: JSContactName;
	emails?: Record<string, JSContactEmail>;
	phones?: Record<string, JSContactPhone>;
	organizations?: Record<string, { name: string; [key: string]: unknown }>;
	notes?: Record<string, { note: string; [key: string]: unknown }>;
	keywords?: Record<string, boolean>;
	[key: string]: unknown;
}

/** RFC 9610 extends the JSContact Card directly; there is no nested `card` property. */
export interface ContactCard extends JSContactCard {
	id: string;
	addressBookIds: Record<string, boolean>;
}

export type ContactCardCreate = JSContactCard & {
	addressBookIds: Record<string, boolean>;
};

export type MethodCall = [string, Record<string, unknown>, string];

export interface JMAPRequest {
	using: string[];
	methodCalls: MethodCall[];
}

export interface JMAPResponse {
	methodResponses: [string, Record<string, unknown>, string][];
	sessionState: string;
}

export interface Mailbox {
	id: string;
	name: string;
	role: string | null;
	sortOrder: number;
	totalEmails: number;
	unreadEmails: number;
	parentId: string | null;
}

export interface EmailAttachment {
	partId: string;
	blobId: string;
	/** MIME type, e.g. `application/pdf`. */
	type: string;
	/** Filename as declared in the message, or null if absent. */
	name: string | null;
	/** Size in bytes. */
	size: number;
	/** Inline Content-ID, if any. Present for images referenced via `cid:` in HTML. */
	cid: string | null;
	/** `attachment`, `inline`, or null. */
	disposition: string | null;
}

export interface Email {
	id: string;
	blobId: string;
	threadId: string;
	mailboxIds: Record<string, boolean>;
	from: EmailAddress[] | null;
	to: EmailAddress[] | null;
	cc: EmailAddress[] | null;
	/** Only present on drafts and sent copies, and only in the detail fetch. */
	bcc?: EmailAddress[] | null;
	subject: string | null;
	receivedAt: string;
	size: number;
	preview: string;
	keywords: Record<string, boolean>;
	hasAttachment: boolean;
	bodyValues?: Record<string, { value: string; isEncodingProblem: boolean; isTruncated: boolean }>;
	htmlBody?: Array<{ partId: string; blobId: string; type: string; name: string | null }>;
	textBody?: Array<{ partId: string; blobId: string; type: string; name: string | null }>;
	attachments?: EmailAttachment[];
	/** Raw List-Unsubscribe value; RFC 8621 allows no Text form for this RFC 2369 header. */
	'header:list-unsubscribe'?: string | null;
	'header:list-unsubscribe-post:asText'?: string | null;
	/** Spam classifier status set by the server, typically `Yes, ...` or `No, ...`. */
	'header:x-spam-status:asText'?: string | null;
	/** Numeric spam score; higher = more spammy. */
	'header:x-spam-score:asText'?: string | null;
	/** Per-rule breakdown behind the score, where the server publishes one. */
	'header:x-spam-result:asText'?: string | null;
	replyTo?: EmailAddress[] | null;
	/** Message-ID header value(s), without angle brackets. */
	messageId?: string[] | null;
	inReplyTo?: string[] | null;
	references?: string[] | null;
	/** Every Authentication-Results header, topmost (our own server's) first. */
	'header:authentication-results:asText:all'?: string[] | null;
	/** Mailing-list headers, read for Jev's facts. */
	'header:list-id:asText'?: string | null;
	'header:precedence:asText'?: string | null;
	'header:auto-submitted:asText'?: string | null;
}

export interface EmailQueryResult {
	emails: Email[];
	total: number;
}

/** A blob already uploaded to the server, ready to attach to an email. */
export interface ComposeAttachment {
	blobId: string;
	name: string;
	type: string;
	size: number;
}

export interface ComposeEmail {
	from: EmailAddress;
	to: EmailAddress[];
	cc: EmailAddress[];
	bcc?: EmailAddress[];
	subject: string;
	body: string;
	/** The original's Message-ID (bare, no angle brackets). */
	inReplyTo?: string;
	/** Space-separated Message-IDs. */
	references?: string;
	attachments?: ComposeAttachment[];
	importance?: 'high' | 'normal' | 'low';
	/** The Date header, when it isn't now: a scheduled message carries its send time. */
	sentAt?: string;
}

export interface AuthState {
	authHeader: string;
	accountId: string;
	apiUrl: string;
	sessionState: string;
}
