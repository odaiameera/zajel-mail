/**
 * Identify an image by its magic bytes. We rely on this rather than the
 * server-declared Content-Type because favicon endpoints frequently return an
 * HTML error page with a 200 + `image/x-icon` header; sniffing the actual
 * bytes lets us reject those (returns null) and serve a trustworthy
 * Content-Type to the browser.
 */
export function sniffImage(bytes: Buffer): string | null {
	if (bytes.length < 4) return null;

	// PNG
	if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47)
		return 'image/png';
	// JPEG
	if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
	// GIF
	if (bytes.toString('ascii', 0, 3) === 'GIF') return 'image/gif';
	// WEBP: 'RIFF' .... 'WEBP'
	if (
		bytes.length >= 12 &&
		bytes.toString('ascii', 0, 4) === 'RIFF' &&
		bytes.toString('ascii', 8, 12) === 'WEBP'
	)
		return 'image/webp';
	// ICO (icon directory): 00 00 01 00
	if (bytes[0] === 0x00 && bytes[1] === 0x00 && bytes[2] === 0x01 && bytes[3] === 0x00)
		return 'image/x-icon';
	// BMP
	if (bytes[0] === 0x42 && bytes[1] === 0x4d) return 'image/bmp';

	// SVG / XML-wrapped SVG. Scan a generous prefix because the <svg> tag may
	// sit after an <?xml …?> declaration, a doctype, or comments.
	const head = bytes.toString('utf8', 0, Math.min(bytes.length, 1024)).toLowerCase();
	if (head.includes('<svg')) return 'image/svg+xml';

	return null;
}

export interface ImageDimensions {
	width: number;
	height: number;
}

/**
 * Pixel dimensions from a raster image's header, without decoding the image.
 * Null for an SVG (no fixed size) and for a header too short or too odd to
 * read, which callers treat as "unknown", never as a size.
 *
 * Needed because favicon quality is wildly inconsistent: a site may declare a
 * 16x16 .ico in its <head> and also ship a 180px apple-touch-icon, and the
 * only way to prefer the good one is to look at what actually arrived. The
 * same numbers bound what gets served at all: a 250 KB PNG can declare a
 * 40000x40000 canvas that a browser then has to allocate.
 */
export function imageDimensions(bytes: Buffer, mime: string): ImageDimensions | null {
	try {
		switch (mime) {
			case 'image/png': {
				// IHDR is the first chunk: 8-byte signature, 4 length, 4 type,
				// then width and height as big-endian uint32.
				if (bytes.length < 24) return null;
				return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
			}

			case 'image/gif':
				if (bytes.length < 10) return null;
				return { width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) };

			case 'image/bmp':
				if (bytes.length < 26) return null;
				return { width: Math.abs(bytes.readInt32LE(18)), height: Math.abs(bytes.readInt32LE(22)) };

			case 'image/x-icon': {
				// Icon directory: count at offset 4, then 16-byte entries whose
				// first two bytes are width and height. 0 encodes 256. The
				// largest entry is the one worth talking about.
				if (bytes.length < 22) return null;
				const count = bytes.readUInt16LE(4);
				let best: ImageDimensions | null = null;
				for (let i = 0; i < count; i++) {
					const off = 6 + i * 16;
					if (off + 1 >= bytes.length) break;
					const entry = {
						width: bytes[off] === 0 ? 256 : bytes[off],
						height: bytes[off + 1] === 0 ? 256 : bytes[off + 1]
					};
					if (!best || Math.min(entry.width, entry.height) > Math.min(best.width, best.height)) best = entry;
				}
				return best;
			}

			case 'image/webp': {
				if (bytes.length < 30) return null;
				const fourcc = bytes.toString('ascii', 12, 16);
				if (fourcc === 'VP8X') {
					// 24-bit little-endian, stored as (dimension - 1).
					return {
						width: 1 + (bytes[24] | (bytes[25] << 8) | (bytes[26] << 16)),
						height: 1 + (bytes[27] | (bytes[28] << 8) | (bytes[29] << 16))
					};
				}
				if (fourcc === 'VP8 ') {
					return { width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff };
				}
				if (fourcc === 'VP8L') {
					const b = bytes.readUInt32LE(21);
					return { width: 1 + (b & 0x3fff), height: 1 + ((b >> 14) & 0x3fff) };
				}
				return null;
			}

			case 'image/jpeg': {
				// Walk the marker chain to the first start-of-frame.
				let i = 2;
				while (i + 9 < bytes.length) {
					if (bytes[i] !== 0xff) {
						i++;
						continue;
					}
					const marker = bytes[i + 1];
					// SOF0-SOF15, excluding the non-frame markers in that range.
					if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
						return { width: bytes.readUInt16BE(i + 7), height: bytes.readUInt16BE(i + 5) };
					}
					i += 2 + bytes.readUInt16BE(i + 2);
				}
				return null;
			}

			default:
				return null;
		}
	} catch {
		// Truncated or malformed header — unknown rather than a throw.
		return null;
	}
}

/**
 * How big an image is for ranking: its shorter side, so a wide banner is not
 * mistaken for a big icon. `Infinity` for SVG, which is the honest answer for
 * a vector mark and makes it sort above every raster candidate; 0 when the
 * header cannot be read.
 */
export function imageSize(bytes: Buffer, mime: string): number {
	if (mime === 'image/svg+xml') return Infinity;
	const dims = imageDimensions(bytes, mime);
	return dims ? Math.min(dims.width, dims.height) : 0;
}
