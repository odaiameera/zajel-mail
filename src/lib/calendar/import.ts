/**
 * Reading an .ics file in the browser before it is imported: the events it
 * holds (for the preview) and the batches it goes up in. The server parses
 * each batch properly with ical.js and stores one calendar object per UID;
 * this side only cuts the text at component boundaries, so a large export
 * never outgrows the server's request body limit (1 MB in the image).
 */

export interface IcsPreviewEvent {
	/** The VEVENT's UID, or a placeholder when it has none. */
	key: string;
	title: string;
	/** Local start date for display, or null when DTSTART is unreadable. */
	start: Date | null;
}

export interface IcsBatch {
	ics: string;
	/** Events (UID groups) in this batch. */
	count: number;
}

export interface IcsFile {
	/** One entry per UID — a recurring series and its overrides count once. */
	events: IcsPreviewEvent[];
	/** Self-contained VCALENDAR texts, each holding whole UID groups. */
	batches: IcsBatch[];
	/** Components other than events (to-dos, journals, free/busy). */
	skipped: number;
}

/** Leaves headroom under the 1 MB body limit for JSON escaping. */
export const MAX_BATCH_BYTES = 600_000;
/** Well under the server's per-request cap (MAX_IMPORT_EVENTS). */
export const MAX_BATCH_EVENTS = 200;

const HEADER = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Zajel Mail//Calendar import//EN\r\n';
const FOOTER = 'END:VCALENDAR\r\n';

interface Group {
	key: string;
	blocks: string[][];
}

/** Split a content line into its name and value, skipping quoted parameters. */
function splitLine(line: string): { name: string; params: string; value: string } | null {
	let quoted = false;
	for (let i = 0; i < line.length; i++) {
		const ch = line[i];
		if (ch === '"') quoted = !quoted;
		else if (ch === ':' && !quoted) {
			const head = line.slice(0, i);
			const semi = head.indexOf(';');
			return {
				name: (semi === -1 ? head : head.slice(0, semi)).toUpperCase(),
				params: semi === -1 ? '' : head.slice(semi + 1),
				value: line.slice(i + 1)
			};
		}
	}
	return null;
}

function unescapeText(value: string): string {
	return value.replace(/\\([\\;,nN])/g, (_, c: string) => (c === 'n' || c === 'N' ? ' ' : c));
}

function parseStart(value: string): Date | null {
	const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?/.exec(value.trim());
	if (!m) return null;
	const [, y, mo, d, h = '0', mi = '0', s = '0', z] = m;
	const parts = [+y, +mo - 1, +d, +h, +mi, +s] as const;
	const date = z ? new Date(Date.UTC(...parts)) : new Date(...parts);
	return isNaN(date.getTime()) ? null : date;
}

/** The top-level properties of one VEVENT (not its VALARMs), unfolded. */
function eventProps(block: string[]): Map<string, string> {
	const unfolded: string[] = [];
	for (const line of block) {
		if ((line.startsWith(' ') || line.startsWith('\t')) && unfolded.length) {
			unfolded[unfolded.length - 1] += line.slice(1);
		} else {
			unfolded.push(line);
		}
	}
	const props = new Map<string, string>();
	let depth = 0;
	for (const line of unfolded) {
		const upper = line.toUpperCase();
		if (upper.startsWith('BEGIN:')) depth++;
		else if (upper.startsWith('END:')) depth--;
		else if (depth === 1) {
			const parsed = splitLine(line);
			if (parsed && !props.has(parsed.name)) props.set(parsed.name, parsed.value);
		}
	}
	return props;
}

function byteLength(s: string): number {
	return new TextEncoder().encode(s).length;
}

export function readIcsFile(text: string, maxBatchBytes = MAX_BATCH_BYTES): IcsFile {
	const lines = text.replace(/\r\n?/g, '\n').split('\n');
	const timezones: string[][] = [];
	const groups = new Map<string, Group>();
	const previews = new Map<string, IcsPreviewEvent>();
	let skipped = 0;
	let sawCalendar = false;
	let unnamed = 0;

	let depth = 0;
	let block: string[] | null = null;
	let blockType = '';

	for (const line of lines) {
		const upper = line.toUpperCase();
		if (upper.startsWith('BEGIN:')) {
			depth++;
			if (depth === 1) {
				if (upper.slice(6).trim() === 'VCALENDAR') sawCalendar = true;
				continue;
			}
			if (depth === 2) {
				block = [];
				blockType = upper.slice(6).trim();
			}
		}
		if (block && line !== '') block.push(line);
		if (upper.startsWith('END:')) {
			depth = Math.max(0, depth - 1);
			if (depth === 1 && block) {
				if (blockType === 'VTIMEZONE') {
					timezones.push(block);
				} else if (blockType === 'VEVENT') {
					const props = eventProps(block);
					const uid = props.get('UID')?.trim();
					const key = uid || `zajel-import-${++unnamed}`;
					const group = groups.get(key) ?? { key, blocks: [] };
					group.blocks.push(block);
					groups.set(key, group);
					// The master (no RECURRENCE-ID) names the series in the preview.
					if (!previews.has(key) || !props.has('RECURRENCE-ID')) {
						previews.set(key, {
							key,
							title: unescapeText(props.get('SUMMARY') ?? '').trim(),
							start: parseStart(props.get('DTSTART') ?? '')
						});
					}
				} else {
					skipped++;
				}
				block = null;
			}
		}
	}

	if (!sawCalendar) throw new Error('This isn’t a calendar file.');

	const tzText = timezones.map((b) => b.join('\r\n') + '\r\n').join('');
	const baseBytes = byteLength(HEADER) + byteLength(FOOTER) + byteLength(tzText);
	const batches: IcsBatch[] = [];
	let current = '';
	let currentBytes = baseBytes;
	let currentCount = 0;
	for (const group of groups.values()) {
		// Events without a UID get theirs on the server; the placeholder
		// key only keeps them apart here.
		const text = group.blocks.map((b) => b.join('\r\n') + '\r\n').join('');
		const bytes = byteLength(text);
		if (current && (currentBytes + bytes > maxBatchBytes || currentCount >= MAX_BATCH_EVENTS)) {
			batches.push({ ics: HEADER + tzText + current + FOOTER, count: currentCount });
			current = '';
			currentBytes = baseBytes;
			currentCount = 0;
		}
		current += text;
		currentBytes += bytes;
		currentCount++;
	}
	if (current) batches.push({ ics: HEADER + tzText + current + FOOTER, count: currentCount });

	return { events: [...previews.values()], batches, skipped };
}
