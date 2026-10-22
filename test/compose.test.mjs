// Pinning pushed digests into compose.yaml in place of the all-zero placeholder.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { ReleaseError } from '../scripts/lib/actions.mjs';
import { PLACEHOLDER_DIGEST, pinDigests, repositoryOf } from '../scripts/lib/compose.mjs';
import { repo } from './helpers.mjs';

const D1 = `sha256:${'a1'.repeat(32)}`;
const D2 = `sha256:${'b2'.repeat(32)}`;
const DB = `sha256:${'cc'.repeat(32)}`;

const compose = `services:
  app:
    # built from image/
    image: ghcr.io/zutun-ch/mail@${PLACEHOLDER_DIGEST}   # pinned by the pipeline
    user: "1000"
  worker:
    image: "ghcr.io/zutun-ch/mail-worker:latest@${PLACEHOLDER_DIGEST}"
  db:
    image: docker.io/library/postgres:17@${DB}
`;

test('repositoryOf strips tag and digest, not a registry port', () => {
	assert.equal(repositoryOf(`ghcr.io/a/b:v1@${D1}`), 'ghcr.io/a/b');
	assert.equal(repositoryOf(`ghcr.io/a/b@${D1}`), 'ghcr.io/a/b');
	assert.equal(repositoryOf('localhost:5000/a/b:1'), 'localhost:5000/a/b');
});

test('every placeholder gets its pushed digest; comments, quotes, tags and other images stay', () => {
	const out = pinDigests(compose, { 'ghcr.io/zutun-ch/mail': D1, 'ghcr.io/zutun-ch/mail-worker': D2 });
	assert.equal(
		out,
		compose
			.replace(`ghcr.io/zutun-ch/mail@${PLACEHOLDER_DIGEST}`, `ghcr.io/zutun-ch/mail@${D1}`)
			.replace(`mail-worker:latest@${PLACEHOLDER_DIGEST}`, `mail-worker:latest@${D2}`),
	);
	assert.ok(!out.includes(PLACEHOLDER_DIGEST));
	assert.ok(out.includes(`postgres:17@${DB}`));
	assert.ok(out.includes('# pinned by the pipeline'));
});

test('one image used by two services is pinned in both', () => {
	const two = `services:\n  a:\n    image: ghcr.io/o/x@${PLACEHOLDER_DIGEST}\n  b:\n    image: ghcr.io/o/x@${PLACEHOLDER_DIGEST}\n`;
	assert.equal(pinDigests(two, { 'ghcr.io/o/x': D1 }).split(D1).length, 3);
});

test('check only (null digests): the file is unchanged but the pairing is checked', () => {
	assert.equal(pinDigests(compose, { 'ghcr.io/zutun-ch/mail': null, 'ghcr.io/zutun-ch/mail-worker': null }), compose);
	assert.throws(() => pinDigests(compose, { 'ghcr.io/zutun-ch/mail': null }), /mail-worker carries the placeholder/);
});

test('a placeholder for an image the repo does not build is refused', () => {
	assert.throws(
		() => pinDigests(compose, { 'ghcr.io/zutun-ch/mail': D1 }),
		(err) => err instanceof ReleaseError && /line 7: ghcr.io\/zutun-ch\/mail-worker/.test(err.message),
	);
	assert.throws(() => pinDigests(compose, {}), /builds no image/);
});

test('the placeholder must name exactly the pushed repository (owner included)', () => {
	const other = `services:\n  a:\n    image: ghcr.io/someone-else/mail@${PLACEHOLDER_DIGEST}\n`;
	assert.throws(() => pinDigests(other, { 'ghcr.io/zutun-ch/mail': D1 }), ReleaseError);
});

test('a built image without a placeholder is refused', () => {
	const none = `services:\n  db:\n    image: postgres@${DB}\n`;
	assert.throws(() => pinDigests(none, { 'ghcr.io/zutun-ch/mail': D1 }), /no "image: ghcr.io\/zutun-ch\/mail@sha256:0+" to pin/);
	assert.throws(() => pinDigests('', { 'ghcr.io/zutun-ch/mail': D1 }), ReleaseError);
});

test('a placeholder outside a plain image line is refused rather than left behind', () => {
	const flow = `services:\n  a: { image: ghcr.io/o/x@${PLACEHOLDER_DIGEST} }\n`;
	assert.throws(() => pinDigests(flow, { 'ghcr.io/o/x': D1 }), /line 2: the placeholder digest can only be pinned/);
	const env = `services:\n  a:\n    image: ghcr.io/o/x@${PLACEHOLDER_DIGEST}\n    environment: { X: "${PLACEHOLDER_DIGEST}" }\n`;
	assert.throws(() => pinDigests(env, { 'ghcr.io/o/x': D1 }), /line 4/);
});

test('a malformed pushed digest is refused', () => {
	assert.throws(() => pinDigests(compose, { 'ghcr.io/zutun-ch/mail': 'sha256:abc', 'ghcr.io/zutun-ch/mail-worker': D2 }), /isn't sha256/);
});

test('CRLF files keep their line endings', () => {
	const crlf = `services:\r\n  a:\r\n    image: ghcr.io/o/x@${PLACEHOLDER_DIGEST}\r\n`;
	assert.equal(pinDigests(crlf, { 'ghcr.io/o/x': D1 }), crlf.replace(PLACEHOLDER_DIGEST, D1));
});

test("the caddy and module-example repos' compose files pin as they are", (t) => {
	for (const [dir, image] of [['caddy', 'ghcr.io/zutun-ch/caddy'], ['module-example', 'ghcr.io/zutun-ch/example']]) {
		let text;
		try {
			text = readFileSync(path.join(repo, '..', dir, 'compose.yaml'), 'utf8');
		} catch {
			t.diagnostic(`../${dir} not checked out; skipped`);
			continue;
		}
		const out = pinDigests(text, { [image]: D1 });
		assert.ok(out.includes(`${image}@${D1}`), dir);
		assert.ok(!out.includes(PLACEHOLDER_DIGEST), dir);
	}
});
