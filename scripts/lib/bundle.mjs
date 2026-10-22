// Packing a stack bundle from a checked-out repo (PROTOCOL §6.5): manifest.yaml, compose.yaml
// (optional for `host` only) and scripts/, nothing else, deterministically:
// - entries sorted by path (bytewise), directories before what they hold;
// - mtime 0, uid and gid 0, no owner names;
// - modes normalized: directories 0755, files 0755 if any execute bit is set, else 0644, so the
//   result doesn't depend on the checkout's umask;
// - a fixed gzip header (tar.mjs).
// The same commit therefore yields the same sha256. The rules the agent and the control plane
// enforce are checked here first, so a bundle that would be refused is never signed.

import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { ReleaseError } from './actions.mjs';
import { checkIdentity, entrypoints } from './manifest.mjs';
import { gzip, tar } from './tar.mjs';

/** PROTOCOL §6.1 and §6.5: the agent's limits, which the control plane checks too. */
export const MAX_ENTRIES = 1000;
export const MAX_UNPACKED_BYTES = 256 * 1024 * 1024;
export const MAX_BUNDLE_BYTES = 64 * 1024 * 1024;

/** A path the agent unpacks: relative, no `.` or `..` or empty segment, no backslash or control character. */
export function pathProblem(p) {
	if (p === '' || p.startsWith('/')) return 'not a relative path';
	if (/[\\\x00-\x1f\x7f]/.test(p)) return 'a backslash or a control character';
	if (p.split('/').some((s) => s === '' || s === '.' || s === '..')) return 'an empty, "." or ".." segment';
	return null;
}

const byPath = (a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path));

function fileEntry(root, rel, overrides) {
	const st = lstatSync(path.join(root, rel));
	if (!st.isFile()) throw new ReleaseError(`${rel}: bundles hold regular files and directories only`);
	const data = overrides[rel] ?? readFileSync(path.join(root, rel));
	return { path: rel, type: 'file', mode: st.mode & 0o111 ? 0o755 : 0o644, data: Buffer.from(data) };
}

/** scripts/ and everything below it, refusing symlinks and special files. */
function walk(root, rel, out, overrides) {
	const st = lstatSync(path.join(root, rel));
	if (st.isSymbolicLink()) throw new ReleaseError(`${rel}: symlinks can't be part of a bundle`);
	if (st.isDirectory()) {
		out.push({ path: rel, type: 'dir', mode: 0o755 });
		for (const name of readdirSync(path.join(root, rel))) walk(root, `${rel}/${name}`, out, overrides);
	} else {
		out.push(fileEntry(root, rel, overrides));
	}
}

/**
 * The bundle's entries from the repo at `root`. `overrides` replaces the content of
 * manifest.yaml or compose.yaml (the version and the pinned digests), so the checkout itself is
 * never edited.
 */
export function collectEntries(root, { name, overrides = {} }) {
	const entries = [];
	if (!existsSync(path.join(root, 'manifest.yaml'))) throw new ReleaseError('manifest.yaml is missing');
	entries.push(fileEntry(root, 'manifest.yaml', overrides));
	if (existsSync(path.join(root, 'compose.yaml'))) {
		entries.push(fileEntry(root, 'compose.yaml', overrides));
	} else if (name !== 'host') {
		throw new ReleaseError('compose.yaml is missing (only the host stack may go without)');
	}
	if (existsSync(path.join(root, 'scripts'))) {
		const st = lstatSync(path.join(root, 'scripts'));
		if (!st.isDirectory() || st.isSymbolicLink()) throw new ReleaseError('scripts must be a directory');
		walk(root, 'scripts', entries, overrides);
	}
	return entries.sort(byPath);
}

/** The PROTOCOL §6.5 rules a set of entries must meet, plus the manifest's identity. */
export function checkEntries(entries, { name, version }) {
	if (entries.length > MAX_ENTRIES) {
		throw new ReleaseError(`the bundle has ${entries.length} entries; at most ${MAX_ENTRIES} are allowed`);
	}
	let unpacked = 0;
	const files = new Set();
	for (const e of entries) {
		const problem = pathProblem(e.path);
		if (problem) throw new ReleaseError(`${JSON.stringify(e.path)}: ${problem}`);
		if (e.type === 'file') {
			files.add(e.path);
			unpacked += e.data.length;
		}
	}
	if (unpacked > MAX_UNPACKED_BYTES) {
		throw new ReleaseError(`the bundle unpacks to ${unpacked} bytes; at most ${MAX_UNPACKED_BYTES} are allowed`);
	}
	const manifest = entries.find((e) => e.path === 'manifest.yaml').data.toString('utf8');
	checkIdentity(manifest, { name, version });
	for (const entry of entrypoints(manifest)) {
		if (!files.has(entry)) throw new ReleaseError(`manifest.yaml: entrypoint ${entry} isn't in the bundle`);
	}
}

/** Packs and checks the bundle: its bytes, sha256 (lowercase hex) and size. */
export function packBundle(root, { name, version, overrides = {} }) {
	const entries = collectEntries(root, { name, overrides });
	checkEntries(entries, { name, version });
	const bytes = gzip(tar(entries));
	if (bytes.length > MAX_BUNDLE_BYTES) {
		throw new ReleaseError(`the bundle is ${bytes.length} bytes; at most ${MAX_BUNDLE_BYTES} are allowed`);
	}
	return {
		bytes,
		sha256: createHash('sha256').update(bytes).digest('hex'),
		size: bytes.length,
		entries: entries.map((e) => e.path),
	};
}
