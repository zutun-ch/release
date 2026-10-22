// Shared test helpers: the platform repo's files, Ed25519 keys from the vectors' seeds, scratch
// repos on disk, and local HTTP servers standing in for GitHub, Cloud KMS, GHCR and the control
// plane.

import { createPrivateKey, createPublicKey } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** A file of the platform repo: PLATFORM_DIR, or ../platform next to this repo. */
export function platformFile(rel) {
	const dir = process.env.PLATFORM_DIR ? path.resolve(process.env.PLATFORM_DIR) : path.resolve(repo, '..', 'platform');
	const file = path.join(dir, rel);
	if (!existsSync(file)) throw new Error(`${file} not found: check out zutun-ch/platform next to this repo or set PLATFORM_DIR`);
	return file;
}

export const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));

/** An Ed25519 key pair from a 32-byte seed (hex), as the vectors define their keys. */
export function keyFromSeed(seedHex) {
	const der = Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.from(seedHex, 'hex')]);
	const privateKey = createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
	return { privateKey, publicKey: createPublicKey(privateKey) };
}

/** A scratch directory with `files` ({ relative path: content }) written into it. */
export function scratch(files = {}) {
	const dir = mkdtempSync(path.join(tmpdir(), 'zutun-release-test-'));
	for (const [rel, content] of Object.entries(files)) {
		mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
		writeFileSync(path.join(dir, rel), content);
	}
	return dir;
}

/**
 * A local HTTP server: `handler(req, body)` returns { status, json?, text?, headers? }. Every
 * request is recorded in `requests`. Close it with `await server.close()`.
 */
export async function fakeServer(handler) {
	const requests = [];
	const server = createServer(async (req, res) => {
		const chunks = [];
		for await (const c of req) chunks.push(c);
		const body = Buffer.concat(chunks);
		const record = { method: req.method, url: req.url, headers: req.headers, body };
		requests.push(record);
		const answer = await handler(record);
		if (answer === 'drop') {
			req.socket.destroy();
			return;
		}
		const payload = answer.json !== undefined ? JSON.stringify(answer.json) : (answer.text ?? '');
		res.writeHead(answer.status ?? 200, {
			'content-type': answer.json !== undefined ? 'application/json' : 'text/plain',
			...answer.headers,
		});
		res.end(payload);
	});
	await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
	const { port } = server.address();
	return {
		url: `http://127.0.0.1:${port}`,
		requests,
		close: () =>
			new Promise((resolve) => {
				server.closeAllConnections();
				server.close(resolve);
			}),
	};
}

/** Retry settings that don't wait. */
export const noWait = { delayMs: 0, wait: async () => {} };
