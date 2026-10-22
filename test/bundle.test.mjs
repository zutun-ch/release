// Deterministic packing and the bundle rules of PROTOCOL §6.5.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { ReleaseError } from '../scripts/lib/actions.mjs';
import { MAX_ENTRIES, packBundle, pathProblem } from '../scripts/lib/bundle.mjs';
import { GZIP_HEADER, splitPath, tar } from '../scripts/lib/tar.mjs';
import { scratch } from './helpers.mjs';

/**
 * The sha256 of the archive in the golden test below. It changes only if the tar format written
 * changes, which changes every bundle's sha256: a change worth noticing.
 */
const GOLDEN_TAR_SHA256 = '79049afeca1dbc368564bf84045321bc43c6e4c3970ca2cc34ca988b6b15c2af';

const MANIFEST = `schema: 1
kind: stack
name: mail
version: 1
title: Mail
requirements: { arch: [amd64, arm64], memory_mb: 512, disk_gb: 5 }
scripts:
  - { name: users/list, target: { service: app }, interpreter: sh, entrypoint: scripts/users/list.sh, timeout_s: 60, audience: operator }
`;

const FILES = {
	'manifest.yaml': MANIFEST,
	'compose.yaml': 'services:\n  app:\n    image: ghcr.io/o/mail@sha256:' + '1'.repeat(64) + '\n',
	'scripts/users/list.sh': '#!/bin/sh\necho "[]"\n',
	'scripts/lib/common.sh': 'set -eu\n',
	'scripts/z.sh': 'true\n',
	'README.md': 'not part of the bundle\n',
	'image/Dockerfile': 'FROM scratch\n',
	'.github/workflows/release.yml': 'not part of the bundle\n',
};

/** A minimal ustar reader for checking what was written, header by header. */
function readTar(bytes) {
	const entries = [];
	let offset = 0;
	for (;;) {
		const h = bytes.subarray(offset, offset + 512);
		if (h.every((b) => b === 0)) break;
		const str = (start, len) => h.subarray(start, start + len).toString('utf8').replace(/\0.*$/s, '');
		const num = (start, len) => parseInt(str(start, len).trim() || '0', 8);
		const stored = num(148, 8);
		const check = Buffer.from(h);
		check.fill(' ', 148, 156);
		assert.equal(check.reduce((a, b) => a + b, 0), stored, 'header checksum');
		const prefix = str(345, 155);
		const size = num(124, 12);
		entries.push({
			path: (prefix ? `${prefix}/` : '') + str(0, 100),
			type: str(156, 1),
			mode: num(100, 8),
			uid: num(108, 8),
			gid: num(116, 8),
			mtime: num(136, 12),
			uname: str(265, 32),
			gname: str(297, 32),
			magic: h.subarray(257, 265).toString('latin1'),
			data: bytes.subarray(offset + 512, offset + 512 + size),
		});
		offset += 512 + Math.ceil(size / 512) * 512;
	}
	// The end-of-archive marker (two zero blocks) and nothing after it.
	assert.equal(bytes.length, offset + 1024, 'no data after the end-of-archive marker');
	assert.ok(bytes.subarray(offset).every((b) => b === 0));
	return entries;
}

test('the bundle holds manifest.yaml, compose.yaml and scripts/ only, sorted, directories first', () => {
	const bundle = packBundle(scratch(FILES), { name: 'mail', version: 1 });
	const entries = readTar(gunzipSync(bundle.bytes));
	assert.deepEqual(
		entries.map((e) => e.path),
		['compose.yaml', 'manifest.yaml', 'scripts/', 'scripts/lib/', 'scripts/lib/common.sh', 'scripts/users/', 'scripts/users/list.sh', 'scripts/z.sh'],
	);
	assert.deepEqual(bundle.entries, entries.map((e) => e.path.replace(/\/$/, '')));
	assert.equal(entries.find((e) => e.path === 'manifest.yaml').data.toString(), MANIFEST);
});

test('no owner data, fixed mtimes, normalized modes, ustar headers', () => {
	const dir = scratch(FILES);
	chmodSync(path.join(dir, 'scripts/users/list.sh'), 0o700);
	chmodSync(path.join(dir, 'manifest.yaml'), 0o600);
	const entries = readTar(gunzipSync(packBundle(dir, { name: 'mail', version: 1 }).bytes));
	for (const e of entries) {
		assert.equal(e.uid, 0);
		assert.equal(e.gid, 0);
		assert.equal(e.uname, '');
		assert.equal(e.gname, '');
		assert.equal(e.mtime, 0);
		assert.equal(e.magic, 'ustar\x0000');
		assert.equal(e.mode, e.type === '5' || e.path === 'scripts/users/list.sh' ? 0o755 : 0o644, e.path);
		assert.ok(e.type === '0' || e.type === '5');
	}
});

test('deterministic: the same content packs to the same sha256, whatever the mtimes, modes and creation order', () => {
	const a = scratch(FILES);
	const reversed = Object.fromEntries(Object.entries(FILES).reverse());
	const b = scratch(reversed);
	utimesSync(path.join(b, 'manifest.yaml'), new Date('2001-02-03'), new Date('2001-02-03'));
	utimesSync(path.join(b, 'scripts'), new Date('2030-01-01'), new Date('2030-01-01'));
	chmodSync(path.join(b, 'compose.yaml'), 0o664);
	chmodSync(path.join(a, 'scripts/users/list.sh'), 0o755);
	chmodSync(path.join(b, 'scripts/users/list.sh'), 0o711);
	writeFileSync(path.join(b, 'README.md'), 'files outside the bundle do not matter\n');
	const one = packBundle(a, { name: 'mail', version: 1 });
	const two = packBundle(b, { name: 'mail', version: 1 });
	assert.equal(one.sha256, two.sha256);
	assert.deepEqual(one.bytes, two.bytes);
	assert.equal(one.sha256, createHash('sha256').update(one.bytes).digest('hex'));
	assert.equal(one.size, one.bytes.length);
	// And content does matter.
	writeFileSync(path.join(b, 'scripts/z.sh'), 'false\n');
	assert.notEqual(packBundle(b, { name: 'mail', version: 1 }).sha256, one.sha256);
});

test('the gzip header is fixed: no name, mtime 0, OS unknown', () => {
	const bytes = packBundle(scratch(FILES), { name: 'mail', version: 1 }).bytes;
	assert.deepEqual(bytes.subarray(0, 10), GZIP_HEADER);
	assert.deepEqual([...GZIP_HEADER], [0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 2, 0xff]);
});

test('the uncompressed archive of fixed entries is byte for byte the expected one', () => {
	const archive = tar([
		{ path: 'compose.yaml', type: 'file', mode: 0o644, data: Buffer.from('services: {}\n') },
		{ path: 'manifest.yaml', type: 'file', mode: 0o644, data: Buffer.from('name: x\n') },
		{ path: 'scripts', type: 'dir', mode: 0o755 },
		{ path: 'scripts/a.sh', type: 'file', mode: 0o755, data: Buffer.from('true\n') },
	]);
	assert.equal(archive.length, 512 * 4 + 512 * 3 + 1024);
	assert.equal(createHash('sha256').update(archive).digest('hex'), GOLDEN_TAR_SHA256);
});

test('the system tar reads the bundle and lists the same entries', () => {
	const dir = scratch(FILES);
	const file = path.join(dir, 'bundle.tar.gz');
	writeFileSync(file, packBundle(dir, { name: 'mail', version: 1 }).bytes);
	const listed = execFileSync('tar', ['-tzf', file], { encoding: 'utf8' }).trim().split('\n');
	assert.deepEqual(listed, ['compose.yaml', 'manifest.yaml', 'scripts/', 'scripts/lib/', 'scripts/lib/common.sh', 'scripts/users/', 'scripts/users/list.sh', 'scripts/z.sh']);
	const out = scratch();
	execFileSync('tar', ['-xzf', file, '-C', out]);
	assert.equal(execFileSync('cat', [path.join(out, 'scripts/users/list.sh')], { encoding: 'utf8' }), FILES['scripts/users/list.sh']);
});

test('long paths use the ustar prefix', () => {
	const deep = `scripts/${'d'.repeat(60)}/${'e'.repeat(60)}/run.sh`;
	assert.deepEqual(splitPath(deep), { prefix: `scripts/${'d'.repeat(60)}`, name: `${'e'.repeat(60)}/run.sh` });
	const entries = readTar(tar([{ path: deep, type: 'file', mode: 0o644, data: Buffer.from('x') }]));
	assert.equal(entries[0].path, deep);
	assert.throws(() => splitPath(`scripts/${'x'.repeat(300)}`), /too long/);
});

test('overrides replace manifest.yaml and compose.yaml in the bundle, not on disk', () => {
	const dir = scratch(FILES);
	const manifest = MANIFEST.replace('version: 1', 'version: 9');
	const entries = readTar(gunzipSync(packBundle(dir, { name: 'mail', version: 9, overrides: { 'manifest.yaml': manifest } }).bytes));
	assert.equal(entries.find((e) => e.path === 'manifest.yaml').data.toString(), manifest);
});

test('compose.yaml is required except for host; scripts/ is optional', () => {
	const files = { ...FILES };
	delete files['compose.yaml'];
	assert.throws(() => packBundle(scratch(files), { name: 'mail', version: 1 }), /compose.yaml is missing/);
	const host = MANIFEST.replace('name: mail', 'name: host').replace(/^scripts:[\s\S]*$/m, '');
	const bundle = packBundle(scratch({ 'manifest.yaml': host }), { name: 'host', version: 1 });
	assert.deepEqual(bundle.entries, ['manifest.yaml']);
	assert.throws(() => packBundle(scratch({}), { name: 'host', version: 1 }), /manifest.yaml is missing/);
});

test('symlinks and special files are refused, also below scripts/', () => {
	const dir = scratch(FILES);
	symlinkSync('/etc/passwd', path.join(dir, 'scripts/users/passwd'));
	assert.throws(() => packBundle(dir, { name: 'mail', version: 1 }), /symlinks/);
	const linkedRoot = scratch(FILES);
	symlinkSync(path.join(linkedRoot, 'manifest.yaml'), path.join(linkedRoot, 'manifest.link'));
	packBundle(linkedRoot, { name: 'mail', version: 1 }); // outside the bundle: ignored
	const linkedCompose = scratch({ ...FILES, 'compose.real': FILES['compose.yaml'] });
	execFileSync('rm', [path.join(linkedCompose, 'compose.yaml')]);
	symlinkSync('compose.real', path.join(linkedCompose, 'compose.yaml'));
	assert.throws(() => packBundle(linkedCompose, { name: 'mail', version: 1 }), /regular files/);
});

test('paths: relative, no dot segments, no backslash or control characters', () => {
	assert.equal(pathProblem('scripts/a.sh'), null);
	assert.equal(pathProblem('scripts/ünïcode.sh'), null);
	for (const p of ['', '/abs', 'scripts/../x', 'scripts/./x', 'scripts//x', 'scripts/a\\b', 'scripts/a\nb', 'scripts/\x7f']) {
		assert.ok(pathProblem(p), JSON.stringify(p));
	}
	const dir = scratch({ ...FILES, 'scripts/bad\\name.sh': 'x' });
	assert.throws(() => packBundle(dir, { name: 'mail', version: 1 }), /backslash/);
});

test(`at most ${MAX_ENTRIES} entries`, () => {
	const dir = scratch(FILES);
	mkdirSync(path.join(dir, 'scripts/many'));
	for (let i = 0; i < MAX_ENTRIES; i++) writeFileSync(path.join(dir, `scripts/many/${i}`), '');
	assert.throws(() => packBundle(dir, { name: 'mail', version: 1 }), /entries; at most 1000/);
});

test("every script's entrypoint must be in the bundle", () => {
	const files = { ...FILES };
	delete files['scripts/users/list.sh'];
	assert.throws(() => packBundle(scratch(files), { name: 'mail', version: 1 }), /entrypoint scripts\/users\/list.sh isn't in the bundle/);
});

test("the manifest's kind, name and version must be the release's", () => {
	const dir = scratch(FILES);
	assert.throws(() => packBundle(dir, { name: 'cloud', version: 1 }), ReleaseError);
	assert.throws(() => packBundle(dir, { name: 'mail', version: 2 }), /version isn't 2/);
	packBundle(dir, { name: 'mail', version: null });
});
