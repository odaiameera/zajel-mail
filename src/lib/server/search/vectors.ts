import { iterateVectors, type StoredVector } from './store';

/**
 * Brute-force nearest neighbours over each account's vectors, held in memory.
 *
 * Measured on 50,000 synthetic messages (75,000 chunk vectors, 768-d): Int8
 * vectors take 60 MB in SQLite and 55 MB here, and one query scans them in
 * ~75 ms. Reading them back from SQLite on every query took 600 ms+, so an
 * account's vectors are loaded once, on its first search, and the indexer
 * keeps the loaded copy current. sqlite-vec would scan faster, but it ships
 * no musl build for the Alpine image, and it too is brute force.
 */

/** Symmetric Int8 quantization, one scale per vector. */
export function quantize(vector: Float32Array): StoredVector {
	let max = 0;
	for (let i = 0; i < vector.length; i++) max = Math.max(max, Math.abs(vector[i]));
	const scale = max > 0 ? max / 127 : 1;
	const data = new Int8Array(vector.length);
	for (let i = 0; i < vector.length; i++) data[i] = Math.round(vector[i] / scale);
	return { scale, data };
}

export interface EmailMeta {
	id: string;
	receivedAt: number;
	mailboxIds: string[];
}

export interface Neighbour {
	id: string;
	score: number;
}

export class AccountVectors {
	private data: Int8Array;
	private scales: Float32Array;
	private owner: Int32Array;
	private rows = 0;
	private deadRows = 0;
	private emails: (EmailMeta & { removed: boolean; rows: number })[] = [];
	private byId = new Map<string, number>();

	constructor(readonly dims: number, capacity = 1024) {
		this.data = new Int8Array(capacity * dims);
		this.scales = new Float32Array(capacity);
		this.owner = new Int32Array(capacity);
	}

	get size(): number {
		return this.byId.size;
	}

	has(id: string): boolean {
		return this.byId.has(id);
	}

	add(meta: EmailMeta, vectors: StoredVector[]): void {
		if (vectors.some((v) => v.data.length !== this.dims)) throw new Error('Vector size does not match the index');
		this.remove(meta.id);
		this.reserve(this.rows + vectors.length);
		const index = this.emails.length;
		this.emails.push({ ...meta, removed: false, rows: vectors.length });
		this.byId.set(meta.id, index);
		for (const v of vectors) {
			this.data.set(v.data, this.rows * this.dims);
			this.scales[this.rows] = v.scale;
			this.owner[this.rows] = index;
			this.rows++;
		}
	}

	remove(id: string): void {
		const index = this.byId.get(id);
		if (index === undefined) return;
		const email = this.emails[index];
		email.removed = true;
		this.byId.delete(id);
		this.deadRows += email.rows;
		if (this.deadRows > 1000 && this.deadRows > this.rows / 4) this.compact();
	}

	setMailboxes(id: string, mailboxIds: string[]): void {
		const index = this.byId.get(id);
		if (index !== undefined) this.emails[index].mailboxIds = mailboxIds;
	}

	/**
	 * The `k` messages nearest `query`, each scored by its best chunk.
	 * `allow` filters on what the index knows (mailboxes, date) before scoring.
	 * With `minZ`, only messages that stand out from the rest are returned;
	 * see `outlierFloor`.
	 */
	search(query: Float32Array, k: number, allow: (meta: EmailMeta) => boolean = () => true, minZ = 0): Neighbour[] {
		if (query.length !== this.dims || k <= 0) return [];
		const q = quantize(query);
		const allowed = new Uint8Array(this.emails.length);
		this.emails.forEach((e, i) => (allowed[i] = !e.removed && allow(e) ? 1 : 0));

		const best = new Float32Array(this.emails.length).fill(-Infinity);
		const { data, scales, owner, dims } = this;
		const qd = q.data;
		for (let r = 0; r < this.rows; r++) {
			const o = owner[r];
			if (!allowed[o]) continue;
			let acc = 0;
			const base = r * dims;
			for (let i = 0; i < dims; i++) acc += data[base + i] * qd[i];
			const score = acc * scales[r] * q.scale;
			if (score > best[o]) best[o] = score;
		}

		const floor = minZ > 0 ? outlierFloor(best, minZ) : -Infinity;
		const top = new MinHeap(k);
		for (let i = 0; i < best.length; i++) if (best[i] > -Infinity && best[i] >= floor) top.offer(i, best[i]);
		return top.sorted().map(([i, score]) => ({ id: this.emails[i].id, score }));
	}

	private reserve(rows: number): void {
		const capacity = this.scales.length;
		if (rows <= capacity) return;
		const next = Math.max(rows, capacity * 2);
		const data = new Int8Array(next * this.dims);
		data.set(this.data.subarray(0, this.rows * this.dims));
		const scales = new Float32Array(next);
		scales.set(this.scales.subarray(0, this.rows));
		const owner = new Int32Array(next);
		owner.set(this.owner.subarray(0, this.rows));
		this.data = data;
		this.scales = scales;
		this.owner = owner;
	}

	/** Rebuild without removed messages. */
	private compact(): void {
		const live: typeof this.emails = [];
		const remap = new Int32Array(this.emails.length);
		this.emails.forEach((e, i) => {
			remap[i] = e.removed ? -1 : live.push(e) - 1;
		});
		let w = 0;
		for (let r = 0; r < this.rows; r++) {
			const to = remap[this.owner[r]];
			if (to < 0) continue;
			this.data.copyWithin(w * this.dims, r * this.dims, (r + 1) * this.dims);
			this.scales[w] = this.scales[r];
			this.owner[w] = to;
			w++;
		}
		this.rows = w;
		this.deadRows = 0;
		this.emails = live;
		this.byId = new Map(live.map((e, i) => [e.id, i]));
	}
}

/** Too few scores to say what's typical. */
const MIN_SCORES_FOR_FLOOR = 10;

/**
 * The score a message needs to stand out: `minZ` robust standard deviations
 * (median and MAD) above the median of every score.
 *
 * Nearest neighbours always exist, even for a question nothing answers. With
 * embeddinggemma-2, unrelated mail scored 0.50–0.58 and the right message
 * 0.68–0.80, but those numbers move with the model and the query; how far a
 * message sits above the bulk of the mailbox does not. The median and MAD
 * ignore the few real matches, which a mean and standard deviation would let
 * drag the floor up past them.
 */
export function outlierFloor(scores: Float32Array, minZ: number): number {
	const finite = scores.filter((s) => s > -Infinity);
	if (finite.length < MIN_SCORES_FOR_FLOOR) return -Infinity;
	finite.sort();
	const median = finite[finite.length >> 1];
	const deviations = finite.map((s) => Math.abs(s - median)).sort();
	const mad = deviations[deviations.length >> 1];
	// Most scores identical: anything above them stands out.
	if (mad === 0) return median + 1e-6;
	return median + (minZ * mad) / 0.6745;
}

/** Keeps the `k` largest scores seen. */
class MinHeap {
	private items: [number, number][] = [];
	constructor(private k: number) {}

	offer(index: number, score: number): void {
		const items = this.items;
		if (items.length < this.k) {
			items.push([index, score]);
			let i = items.length - 1;
			while (i > 0) {
				const parent = (i - 1) >> 1;
				if (items[parent][1] <= items[i][1]) break;
				[items[parent], items[i]] = [items[i], items[parent]];
				i = parent;
			}
			return;
		}
		if (score <= items[0][1]) return;
		items[0] = [index, score];
		let i = 0;
		for (;;) {
			const l = 2 * i + 1;
			const r = l + 1;
			let min = i;
			if (l < items.length && items[l][1] < items[min][1]) min = l;
			if (r < items.length && items[r][1] < items[min][1]) min = r;
			if (min === i) break;
			[items[min], items[i]] = [items[i], items[min]];
			i = min;
		}
	}

	sorted(): [number, number][] {
		return [...this.items].sort((a, b) => b[1] - a[1]);
	}
}

const loaded = new Map<string, AccountVectors>();

/** The account's vectors, read from SQLite on first use. */
export function accountVectors(accountId: string, dims: number): AccountVectors {
	const cached = loaded.get(accountId);
	if (cached && cached.dims === dims) return cached;
	const index = new AccountVectors(dims);
	// Rows arrive grouped by message.
	let meta = null as EmailMeta | null;
	let vectors: StoredVector[] = [];
	for (const row of iterateVectors(accountId)) {
		if (row.vector.data.length !== dims) continue;
		if (meta?.id !== row.emailId) {
			if (meta) index.add(meta, vectors);
			meta = { id: row.emailId, receivedAt: Date.parse(row.receivedAt), mailboxIds: row.mailboxIds };
			vectors = [];
		}
		vectors.push(row.vector);
	}
	if (meta) index.add(meta, vectors);
	loaded.set(accountId, index);
	return index;
}

/** The loaded copy, if a search has loaded one: the indexer updates only that. */
export function loadedVectors(accountId: string): AccountVectors | undefined {
	return loaded.get(accountId);
}

export function forgetVectors(accountId: string): void {
	loaded.delete(accountId);
}
