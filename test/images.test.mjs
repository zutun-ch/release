// Image builds (the docker arguments) and the public-package check against a fake registry.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildArgs, digestFrom, PLATFORMS } from '../scripts/build-images.mjs';
import { ReleaseError } from '../scripts/lib/actions.mjs';
import { isPublic, requirePublic } from '../scripts/lib/registry.mjs';
import { fakeServer, noWait } from './helpers.mjs';

const image = { name: 'mail-worker', context: 'images/worker', repository: 'ghcr.io/zutun-ch/mail-worker' };
const DIGEST = `sha256:${'ab'.repeat(32)}`;

test('a release pushes both architectures, tagged v<N>, with the source label and a metadata file', () => {
	const args = buildArgs(image, { version: '12', source: 'https://github.com/zutun-ch/module-mail', revision: 'abc', metadataFile: '/tmp/m.json' });
	assert.deepEqual(args, [
		'buildx', 'build', '--pull', '--platform', 'linux/amd64,linux/arm64', '--file', 'images/worker/Dockerfile',
		'--label', 'org.opencontainers.image.source=https://github.com/zutun-ch/module-mail',
		'--label', 'org.opencontainers.image.revision=abc',
		'--annotation', 'index:org.opencontainers.image.source=https://github.com/zutun-ch/module-mail',
		'--tag', 'ghcr.io/zutun-ch/mail-worker:v12', '--push', '--metadata-file', '/tmp/m.json',
		'images/worker',
	]);
	assert.equal(PLATFORMS, 'linux/amd64,linux/arm64');
});

test('a push to main builds both architectures and pushes nothing', () => {
	const args = buildArgs(image, { version: '', source: 's', revision: 'r', metadataFile: '/tmp/m.json' });
	assert.ok(args.includes('linux/amd64,linux/arm64'));
	for (const flag of ['--push', '--tag', '--metadata-file', '--annotation']) assert.ok(!args.includes(flag), flag);
});

test('the pushed digest comes from the metadata file', () => {
	assert.equal(digestFrom({ 'containerimage.digest': DIGEST }), DIGEST);
	assert.throws(() => digestFrom({}), ReleaseError);
});

/** A registry that serves anonymous tokens and only the packages in `publicRepos`. */
async function fakeRegistry(publicRepos, { flaky = 0 } = {}) {
	let failures = flaky;
	return fakeServer((req) => {
		const url = new URL(req.url, 'http://x');
		if (failures > 0) {
			failures -= 1;
			return { status: 502, text: '' };
		}
		if (url.pathname === '/token') {
			const repo = /^repository:(.+):pull$/.exec(url.searchParams.get('scope'))?.[1];
			return { json: { token: `anon-${repo}` } };
		}
		const m = /^\/v2\/(.+)\/manifests\/(sha256:[0-9a-f]{64})$/.exec(url.pathname);
		if (m && req.method === 'HEAD' && publicRepos.includes(m[1]) && req.headers.authorization === `Bearer anon-${m[1]}`) {
			return { status: 200, text: '' };
		}
		return { status: 401, json: { errors: [{ code: 'UNAUTHORIZED' }] } };
	});
}

test('public packages pass; a private one stops the release with how to fix it', async () => {
	const registry = await fakeRegistry(['zutun-ch/mail']);
	try {
		const options = { registry: registry.url, retry: noWait };
		assert.equal(await isPublic('ghcr.io/zutun-ch/mail', DIGEST, options), true);
		assert.equal(await isPublic('ghcr.io/zutun-ch/mail-worker', DIGEST, options), false);
		await requirePublic({ 'ghcr.io/zutun-ch/mail': DIGEST }, options);
		await assert.rejects(
			requirePublic({ 'ghcr.io/zutun-ch/mail': DIGEST, 'ghcr.io/zutun-ch/mail-worker': DIGEST }, options),
			(err) => err instanceof ReleaseError && /^ghcr.io\/zutun-ch\/mail-worker isn't public\..*Change visibility > Public/.test(err.message),
		);
		// The check asks without credentials of its own.
		assert.ok(registry.requests.every((r) => !r.headers.authorization || r.headers.authorization.startsWith('Bearer anon-')));
	} finally {
		await registry.close();
	}
});

test('a registry hiccup is retried, not taken for a private package', async () => {
	const registry = await fakeRegistry(['zutun-ch/mail'], { flaky: 1 });
	try {
		assert.equal(await isPublic('ghcr.io/zutun-ch/mail', DIGEST, { registry: registry.url, retry: noWait }), true);
	} finally {
		await registry.close();
	}
});
