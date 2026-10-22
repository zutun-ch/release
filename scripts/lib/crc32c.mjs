// CRC32C (Castagnoli), which Cloud KMS uses to check requests and responses end to end
// (https://cloud.google.com/kms/docs/data-integrity-guidelines). zlib only has plain CRC-32.

const TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
	let c = n;
	for (let k = 0; k < 8; k++) c = c & 1 ? 0x82f63b78 ^ (c >>> 1) : c >>> 1;
	TABLE[n] = c >>> 0;
}

/** CRC32C of the bytes, as an unsigned 32-bit number. */
export function crc32c(bytes) {
	let crc = 0xffffffff;
	for (const byte of bytes) crc = TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
	return (crc ^ 0xffffffff) >>> 0;
}
