import { describe, expect, it } from 'vitest';
import {
	base32Decode,
	base32Encode,
	generateTotpSecret,
	matchTotp,
	otpauthQrSvg,
	otpauthUri,
	timeStep,
	totpCode
} from './totp';

// RFC 6238 appendix B, SHA-1, with the RFC's ASCII secret.
const RFC_SECRET = Buffer.from('12345678901234567890');
const RFC_VECTORS: [number, string][] = [
	[59, '94287082'],
	[1111111109, '07081804'],
	[1111111111, '14050471'],
	[1234567890, '89005924'],
	[2000000000, '69279037'],
	[20000000000, '65353130']
];

describe('TOTP', () => {
	it('matches the RFC 6238 test vectors', () => {
		for (const [seconds, code] of RFC_VECTORS) {
			expect(totpCode(RFC_SECRET, timeStep(seconds * 1000), 8)).toBe(code);
			expect(totpCode(RFC_SECRET, timeStep(seconds * 1000))).toBe(code.slice(-6));
		}
	});

	it('round-trips base32 the way authenticator apps write it', () => {
		const secret = generateTotpSecret();
		expect(secret).toMatch(/^[A-Z2-7]{32}$/);
		expect(base32Encode(base32Decode(secret))).toBe(secret);
		expect(base32Decode('gezd gnbv-gy3t qojq')).toEqual(Buffer.from('1234567890'));
	});

	it('accepts the current code and one step of drift, never a used step', () => {
		const secret = generateTotpSecret();
		const now = Date.UTC(2026, 10, 1, 9, 0, 0);
		const step = timeStep(now);
		expect(matchTotp(secret, totpCode(secret, step), now)).toBe(step);
		expect(matchTotp(secret, totpCode(secret, step - 1), now)).toBe(step - 1);
		expect(matchTotp(secret, totpCode(secret, step + 1), now)).toBe(step + 1);
		expect(matchTotp(secret, totpCode(secret, step - 2), now)).toBeNull();
		// Already used to sign in: refused.
		expect(matchTotp(secret, totpCode(secret, step), now, step)).toBeNull();
		expect(matchTotp(secret, '12345', now)).toBeNull();
		expect(matchTotp(secret, 'abcdef', now)).toBeNull();
	});

	it('builds an otpauth link and a QR code for it', () => {
		const uri = otpauthUri('JBSWY3DPEHPK3PXP', 'me@example.test');
		expect(uri).toBe(
			'otpauth://totp/Zajel%20Mail%3Ame%40example.test?secret=JBSWY3DPEHPK3PXP&issuer=Zajel+Mail&algorithm=SHA1&digits=6&period=30'
		);
		expect(otpauthQrSvg(uri)).toMatch(/^<svg[^>]*>.*<\/svg>$/s);
	});
});
