// The manifest edits and reads the pipeline makes, and the repo image layout.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { ReleaseError } from '../scripts/lib/actions.mjs';
import { findImages, imageRepository } from '../scripts/lib/layout.mjs';
import { checkIdentity, entrypoints, setVersion, topLevelScalar } from '../scripts/lib/manifest.mjs';
import { platformFile, scratch } from './helpers.mjs';

const manifest = `# A module.
schema: 1
kind: stack
name: mail
version: 1                            # written by the release pipeline from the tag
title: "Mail: inbox"
requirements: { arch: [amd64, arm64], memory_mb: 512, disk_gb: 5 }
scripts:
  - name: users/list
    entrypoint: scripts/users/list.sh
  - { name: users/upsert, target: { service: app }, entrypoint: "scripts/users/upsert.sh", timeout_s: 60 }
  - name: metrics/collect
    entrypoint: 'scripts/metrics/collect.sh'
`;

test('setVersion rewrites the top-level version only and keeps its comment', () => {
	const out = setVersion(manifest, 42);
	assert.match(out, /^version: 42 {2}# written by the release pipeline from the tag$/m);
	assert.equal(out.replace(/^version:.*$/m, ''), manifest.replace(/^version:.*$/m, ''));
	assert.equal(topLevelScalar(out, 'version'), '42');
});

test('setVersion without a comment, and with CRLF line endings', () => {
	assert.equal(setVersion('name: a\nversion: 3\n', 7), 'name: a\nversion: 7\n');
	assert.equal(setVersion('name: a\r\nversion: 3\r\n', 7), 'name: a\r\nversion: 7\r\n');
});

test('setVersion refuses a manifest without a version or with two', () => {
	assert.throws(() => setVersion('name: a\n', 2), /no top-level "version:"/);
	assert.throws(() => setVersion('version: 1\nversion: 2\n', 2), /more than once/);
	// An indented version (inside a mapping) isn't the manifest's version.
	assert.throws(() => setVersion('x:\n  version: 1\n', 2), ReleaseError);
});

test('top-level scalars: plain, quoted, commented', () => {
	assert.equal(topLevelScalar(manifest, 'kind'), 'stack');
	assert.equal(topLevelScalar(manifest, 'name'), 'mail');
	assert.equal(topLevelScalar(manifest, 'title'), 'Mail: inbox');
	assert.equal(topLevelScalar(manifest, 'description'), undefined);
});

test('entrypoints in block and flow style, quoted or not', () => {
	assert.deepEqual(entrypoints(manifest), ['scripts/users/list.sh', 'scripts/users/upsert.sh', 'scripts/metrics/collect.sh']);
});

test("the platform's host example: every entrypoint is found", () => {
	const host = readFileSync(platformFile('spec/manifest/examples/host.yaml'), 'utf8');
	assert.deepEqual(entrypoints(host), [
		'scripts/system/reboot.sh',
		'scripts/volume/grow.sh',
		'scripts/logs/collect.sh',
		'scripts/stacks/purge.sh',
		'scripts/diag/docker.sh',
	]);
	checkIdentity(host, { name: 'host', version: 4 });
});

test('checkIdentity: kind, name and (for a release) version must match', () => {
	checkIdentity(manifest, { name: 'mail', version: null });
	checkIdentity(manifest, { name: 'mail', version: 1 });
	assert.throws(() => checkIdentity(manifest, { name: 'cloud', version: null }), /releases "cloud"/);
	assert.throws(() => checkIdentity(manifest, { name: 'mail', version: 2 }), /version isn't 2/);
	assert.throws(() => checkIdentity(manifest.replace('kind: stack', 'kind: agent'), { name: 'mail', version: null }), /kind/);
});

test('image layout: image/ is <base>, images/<suffix>/ is <base>-<suffix>, sorted', () => {
	const dir = scratch({
		'image/Dockerfile': 'FROM scratch\n',
		'images/worker/Dockerfile': 'FROM scratch\n',
		'images/cron/Dockerfile': 'FROM scratch\n',
		'images/README.md': 'not a directory, ignored\n',
	});
	assert.deepEqual(findImages(dir, 'mail'), [
		{ name: 'mail', context: 'image' },
		{ name: 'mail-cron', context: 'images/cron' },
		{ name: 'mail-worker', context: 'images/worker' },
	]);
	assert.deepEqual(findImages(scratch({ 'manifest.yaml': '' }), 'host'), []);
});

test('image layout: a directory without a Dockerfile or with a bad name is refused', () => {
	assert.throws(() => findImages(scratch({ 'image/Containerfile': '' }), 'mail'), /image\/ has no Dockerfile/);
	assert.throws(() => findImages(scratch({ 'images/w/x': '' }), 'mail'), /images\/w has no Dockerfile/);
	assert.throws(() => findImages(scratch({ 'images/Worker/Dockerfile': '' }), 'mail'), /named/);
});

test('image repositories are lowercase under ghcr.io/<owner>', () => {
	assert.equal(imageRepository('Zutun-CH', 'mail'), 'ghcr.io/zutun-ch/mail');
});
