// A deterministic ustar writer and gzip wrapper for stack bundles (PROTOCOL §6.5): entries in the
// order given, mtime 0, uid and gid 0, no user or group names, the modes the caller normalized,
// the two-block end-of-archive marker and nothing after it. The gzip member has a fixed header
// (no name, mtime 0, OS "unknown"), so the same entries give the same bytes with the same zlib.

import { crc32, deflateRawSync, constants } from 'node:zlib';

const BLOCK = 512;

function writeString(header, offset, length, value) {
	const bytes = Buffer.from(value, 'utf8');
	if (bytes.length > length) throw new Error(`tar field too long: ${value}`);
	bytes.copy(header, offset);
}

/** An octal field: zero-padded digits and a terminating NUL, as ustar writers emit. */
function writeOctal(header, offset, length, value) {
	const digits = value.toString(8).padStart(length - 1, '0');
	if (digits.length > length - 1) throw new Error(`tar number too large: ${value}`);
	writeString(header, offset, length, `${digits}\0`);
}

/** Splits a path into ustar's prefix (155 bytes) and name (100 bytes) at a slash. */
export function splitPath(path) {
	if (Buffer.byteLength(path) <= 100) return { prefix: '', name: path };
	for (let i = path.indexOf('/'); i !== -1; i = path.indexOf('/', i + 1)) {
		const prefix = path.slice(0, i);
		const name = path.slice(i + 1);
		if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100 && name !== '') {
			return { prefix, name };
		}
	}
	throw new Error(`path too long for the bundle format (ustar, 255 bytes): ${path}`);
}

/** One ustar header block. `path` of a directory ends in a slash. */
export function header({ path, type, mode, size }) {
	const h = Buffer.alloc(BLOCK);
	const { prefix, name } = splitPath(path);
	writeString(h, 0, 100, name);
	writeOctal(h, 100, 8, mode);
	writeOctal(h, 108, 8, 0); // uid
	writeOctal(h, 116, 8, 0); // gid
	writeOctal(h, 124, 12, size);
	writeOctal(h, 136, 12, 0); // mtime
	h.fill(' ', 148, 156); // checksum, counted as spaces
	writeString(h, 156, 1, type === 'dir' ? '5' : '0');
	writeString(h, 257, 6, 'ustar\0');
	writeString(h, 263, 2, '00');
	writeOctal(h, 329, 8, 0); // devmajor
	writeOctal(h, 337, 8, 0); // devminor
	writeString(h, 345, 155, prefix);
	let sum = 0;
	for (const byte of h) sum += byte;
	writeString(h, 148, 8, `${sum.toString(8).padStart(6, '0')}\0 `);
	return h;
}

/** The archive: each entry's header and content padded to a block, then two zero blocks. */
export function tar(entries) {
	const parts = [];
	for (const e of entries) {
		const data = e.type === 'dir' ? Buffer.alloc(0) : e.data;
		parts.push(header({ path: e.type === 'dir' ? `${e.path}/` : e.path, type: e.type, mode: e.mode, size: data.length }));
		parts.push(data);
		const pad = (BLOCK - (data.length % BLOCK)) % BLOCK;
		if (pad) parts.push(Buffer.alloc(pad));
	}
	parts.push(Buffer.alloc(2 * BLOCK));
	return Buffer.concat(parts);
}

/** gzip header: magic, deflate, no flags, mtime 0, "max compression", OS unknown (RFC 1952). */
export const GZIP_HEADER = Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0, 0, 0, 0, 0x02, 0xff]);

export function gzip(data) {
	const trailer = Buffer.alloc(8);
	trailer.writeUInt32LE(crc32(data), 0);
	trailer.writeUInt32LE(data.length % 2 ** 32, 4);
	const body = deflateRawSync(data, { level: constants.Z_BEST_COMPRESSION });
	return Buffer.concat([GZIP_HEADER, body, trailer]);
}
