import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import qrcode from 'qrcode-generator';

/**
 * Authenticator-app codes (TOTP, RFC 6238): HMAC-SHA1, 30-second steps,
 * six digits, the settings every authenticator app uses by default.
 */

const STEP_SECONDS = 30;
const DIGITS = 6;
const ISSUER = 'Zajel Mail';
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(bytes: Buffer): string {
	let bits = 0;
	let value = 0;
	let out = '';
	for (const byte of bytes) {
		value = (value << 8) | byte;
		bits += 8;
		while (bits >= 5) {
			out += B32[(value >>> (bits - 5)) & 31];
			bits -= 5;
		}
	}
	if (bits > 0) out += B32[(value << (5 - bits)) & 31];
	return out;
}

export function base32Decode(text: string): Buffer {
	const clean = text.toUpperCase().replace(/[\s=-]/g, '');
	let bits = 0;
	let value = 0;
	const out: number[] = [];
	for (const char of clean) {
		const index = B32.indexOf(char);
		if (index === -1) throw new Error('Invalid base32');
		value = (value << 5) | index;
		bits += 5;
		if (bits >= 8) {
			out.push((value >>> (bits - 8)) & 255);
			bits -= 8;
		}
	}
	return Buffer.from(out);
}

/** A new 160-bit secret, base32 as authenticator apps expect it. */
export function generateTotpSecret(): string {
	return base32Encode(randomBytes(20));
}

export function timeStep(nowMs: number): number {
	return Math.floor(nowMs / 1000 / STEP_SECONDS);
}

/** The code for one time step (RFC 4226 dynamic truncation). */
export function totpCode(secret: string | Buffer, step: number, digits = DIGITS): string {
	const key = typeof secret === 'string' ? base32Decode(secret) : secret;
	const counter = Buffer.alloc(8);
	counter.writeBigUInt64BE(BigInt(step));
	const mac = createHmac('sha1', key).update(counter).digest();
	const offset = mac[mac.length - 1] & 0x0f;
	const binary =
		((mac[offset] & 0x7f) << 24) |
		(mac[offset + 1] << 16) |
		(mac[offset + 2] << 8) |
		mac[offset + 3];
	return String(binary % 10 ** digits).padStart(digits, '0');
}

/**
 * The time step `code` belongs to, allowing one step of clock drift either
 * way, or null. A step at or before `lastStep` is refused, so a code that
 * signed someone in once can't be replayed.
 */
export function matchTotp(secret: string, code: string, nowMs: number, lastStep = 0): number | null {
	const digits = code.replace(/\s/g, '');
	if (!/^\d{6}$/.test(digits)) return null;
	const current = timeStep(nowMs);
	for (const step of [current - 1, current, current + 1]) {
		if (step <= lastStep) continue;
		const expected = Buffer.from(totpCode(secret, step));
		if (timingSafeEqual(expected, Buffer.from(digits))) return step;
	}
	return null;
}

/** The otpauth:// link an authenticator app imports, from a QR code or a tap. */
export function otpauthUri(secret: string, account: string): string {
	const label = encodeURIComponent(`${ISSUER}:${account}`);
	const params = new URLSearchParams({ secret, issuer: ISSUER, algorithm: 'SHA1', digits: String(DIGITS), period: String(STEP_SECONDS) });
	return `otpauth://totp/${label}?${params}`;
}

/** The same link as an SVG QR code, drawn here so the secret goes nowhere else. */
export function otpauthQrSvg(uri: string): string {
	const qr = qrcode(0, 'M');
	qr.addData(uri);
	qr.make();
	return qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
}
