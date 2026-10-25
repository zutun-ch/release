// Signing through (a fake) Cloud KMS, checking the signature locally, and uploading: the whole
// publish step against local fakes of KMS, GitHub's token endpoint and the control plane.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { after, test } from 'node:test';
import { verifyRef } from '../scripts/lib/artifact.mjs';
import { kmsClient } from '../scripts/lib/kms.mjs';
import { githubTokens } from '../scripts/lib/oidc.mjs';
import { publish } from '../scripts/lib/publish.mjs';
import { releaseFileSha256, writeRelease } from '../scripts/lib/release.mjs';
import { fakeControlPlane, fakeGithubOidc, fakeKms } from './fakes.mjs';
import { keyFromSeed, lockedReaders, noWait, scratch } from './helpers.mjs';

const core = keyFromSeed('c3604e89883933a9ad5c91e88080622bcff34f300d7f612535d9cdb58cf8d9a0');
const other = keyFromSeed('d41b6f45986507a1986737215acdbd82b93e1c4ecd65876c51a03411efc36abe');
const COMMIT = '1234567890abcdef1234567890abcdef12345678';
const RING = 'projects/release-test/locations/europe-west6/keyRings/zutun-release';
const CORE_KEY = `${RING}/cryptoKeys/release-core/cryptoKeyVersions/1`;
const MODULES_KEY = `${RING}/cryptoKeys/release-modules/cryptoKeyVersions/1`;
// The agent builds' manifest reader, as agent-release.mjs records it: a reader of the lock.
const READER = lockedReaders().r30;

const oidc = await fakeGithubOidc();
after(() => oidc.close());

/** A built agent release in a scratch directory, as the agent job leaves it. */
function agentBuild() {
	const dir = scratch({ 'zutun-agent-linux-amd64': 'amd64 binary', 'zutun-agent-linux-arm64': 'arm64 binary' });
	writeRelease(dir, {
		commit: COMMIT,
		notes: 'Build 42.',
		artifacts: ['amd64', 'arm64'].map((arch) => ({ kind: 'agent', name: `zutun-agent-linux-${arch}`, version: 42, file: `zutun-agent-linux-${arch}`, manifest_reader: READER })),
	});
	return dir;
}

/** What the plan and the agent job said this run releases. */
const agentPlan = (dir) => ({ kind: 'agent', name: 'agent', version: 42, releaseSha256: releaseFileSha256(dir) });

async function run({ dir = agentBuild(), key = CORE_KEY, family = 'release-core', expected, kms: kmsOptions = {}, cp: cpOptions = {} } = {}) {
	const kms = await fakeKms(key, core, kmsOptions);
	const cp = await fakeControlPlane({ publicKey: core.publicKey, commit: COMMIT, ...cpOptions });
	const lines = [];
	try {
		const refs = await publish({
			dir,
			commit: COMMIT,
			origin: cp.url,
			kmsKeyVersion: key,
			family,
			expected: expected ?? agentPlan(dir),
			kms: kmsClient({ token: 'google-token', endpoint: `${kms.url}/v1`, retry: noWait }),
			nextToken: githubTokens(cp.url, { env: oidc.env, retry: noWait }),
			retry: noWait,
			log: (line) => lines.push(line),
		});
		return { refs, kms, cp, lines };
	} catch (error) {
		return { error, kms, cp, lines };
	} finally {
		await kms.close();
		await cp.close();
	}
}

test('both agent builds are signed with release-core-1, verified and uploaded', async () => {
	const { refs, error, cp, lines } = await run();
	assert.equal(error, undefined);
	assert.deepEqual(refs.map((r) => [r.name, r.version, r.key_id]), [
		['zutun-agent-linux-amd64', 42, 'release-core-1'],
		['zutun-agent-linux-arm64', 42, 'release-core-1'],
	]);
	for (const r of refs) assert.ok(verifyRef(core.publicKey, r, r.sig));
	assert.equal([...cp.releases.values()].filter((r) => r.state === 'available').length, 2);
	assert.ok(lines.some((l) => l === 'signing with release-core-1, public key D/kyP7cKfQ81Gghg6hr2+zC6exEhkNMSe4cdqMs7sts='));
});

test("each agent build's upload carries its manifest reader; a stack's carries none (CONTROL-PLANE §7, step 1)", async () => {
	const { error, cp } = await run();
	assert.equal(error, undefined);
	const begins = cp.requests.filter((r) => r.url === '/api/releases').map((r) => JSON.parse(r.body));
	assert.deepEqual(begins.map((b) => [b.name, b.manifest_reader]), [
		['zutun-agent-linux-amd64', READER],
		['zutun-agent-linux-arm64', READER],
	]);

	const dir = scratch({ 'mail.tar.gz': 'bundle' });
	writeRelease(dir, { commit: COMMIT, notes: null, artifacts: [{ kind: 'stack', name: 'mail', version: 3, file: 'mail.tar.gz' }] });
	const stack = await run({ dir, key: MODULES_KEY, family: 'release-modules', expected: { kind: 'stack', name: 'mail', version: 3, releaseSha256: releaseFileSha256(dir) } });
	assert.equal(stack.error, undefined);
	const [begin] = stack.cp.requests.filter((r) => r.url === '/api/releases').map((r) => JSON.parse(r.body));
	assert.equal(begin.name, 'mail');
	assert.ok(!('manifest_reader' in begin), 'a stack upload has no manifest_reader');
});

test('an agent build without a manifest reader in release.json is refused before anything is signed', async () => {
	const dir = agentBuild();
	const file = path.join(dir, 'release.json');
	const release = JSON.parse(readFileSync(file, 'utf8'));
	delete release.artifacts[1].manifest_reader;
	writeFileSync(file, JSON.stringify(release));
	const { error, kms, cp } = await run({ dir, expected: agentPlan(dir) });
	assert.match(error.message, /release\.json: the agent build zutun-agent-linux-arm64 has no manifest reader/);
	assert.equal(kms.requests.length, 0);
	assert.equal(cp.requests.length, 0);
});

test('a manifest reader the control plane does not know stops the upload and says what comes first', async () => {
	const { error, cp } = await run({ cp: { readers: [] } });
	assert.match(error.message, /refused \(422\): the control plane doesn't know this build's manifest reader [0-9a-f]{64}\. .*readers\.lock.*deploy that control plane first/);
	assert.equal(cp.requests.length, 1, 'no retry, no PUT, no second architecture');
});

test('the data signed is the signed string itself (Ed25519 signs data, not a digest), with its CRC32C', async () => {
	const { kms } = await run();
	const signs = kms.requests.filter((r) => r.url.endsWith(':asymmetricSign'));
	assert.equal(signs.length, 2);
	const body = JSON.parse(signs[0].body);
	assert.match(Buffer.from(body.data, 'base64').toString(), /^zutun-artifact-v1\nagent\nzutun-agent-linux-amd64\n42\n[0-9a-f]{64}\n12$/);
	assert.match(body.dataCrc32c, /^\d+$/);
	assert.equal(body.digest, undefined);
});

test('a signature that does not verify against the key stops everything before any upload', async () => {
	const { error, cp } = await run({ kms: { signWith: other } });
	assert.match(error.message, /doesn't verify against release-core-1's public key/);
	assert.equal(cp.requests.length, 0);
});

test('a key that is not Ed25519 is refused', async () => {
	const { error, cp } = await run({ kms: { algorithm: 'EC_SIGN_P256_SHA256' } });
	assert.match(error.message, /is a EC_SIGN_P256_SHA256 key/);
	assert.equal(cp.requests.length, 0);
});

test('KMS permission denied points at the IAM binding', async () => {
	const { error } = await run({ kms: { refuse: 403 } });
	assert.match(error.message, /Cloud KMS refused GET .* \(403\): Permission denied\. .*IAM binding/);
});

test('KMS errors that may pass are retried', async () => {
	let first = true;
	const kms = await fakeKms(CORE_KEY, core);
	const flaky = (url, init) => {
		if (first) {
			first = false;
			return Promise.resolve(new Response('{}', { status: 503 }));
		}
		return fetch(url, init);
	};
	try {
		const client = kmsClient({ token: 'google-token', endpoint: `${kms.url}/v1`, fetch: flaky, retry: noWait });
		await client.publicKey(CORE_KEY);
	} finally {
		await kms.close();
	}
});

test('KMS must confirm the data it signed', async () => {
	const { error, cp } = await run({ kms: { verifiedDataCrc32c: false } });
	assert.match(error.message, /didn't confirm the CRC32C/);
	assert.equal(cp.requests.length, 0);
});

test('a module workflow refuses a core key, before asking KMS', async () => {
	const { error, kms } = await run({ family: 'release-modules' });
	assert.match(error.message, /signs with a release-modules key, but the key configured is a release-core key/);
	assert.equal(kms.requests.length, 0);
});

test('a modules key may not sign the agent', async () => {
	const { error, kms } = await run({ key: MODULES_KEY, family: 'release-modules' });
	assert.match(error.message, /release-modules key may not sign agent/);
	assert.equal(kms.requests.length, 0);
});

test('a file changed after the build is refused', async () => {
	const dir = agentBuild();
	const expected = agentPlan(dir);
	writeFileSync(path.join(dir, 'zutun-agent-linux-arm64'), 'something else');
	const { error, kms } = await run({ dir, expected });
	assert.match(error.message, /zutun-agent-linux-arm64 isn't the file the build job described/);
	assert.equal(kms.requests.length, 0);
});

test('a build of another commit is refused', async () => {
	const dir = scratch({ 'mail.tar.gz': 'bundle' });
	writeRelease(dir, { commit: 'f'.repeat(40), notes: null, artifacts: [{ kind: 'stack', name: 'mail', version: 3, file: 'mail.tar.gz' }] });
	const expected = { kind: 'stack', name: 'mail', version: 3, releaseSha256: releaseFileSha256(dir) };
	const { error } = await run({ dir, key: MODULES_KEY, family: 'release-modules', expected });
	assert.match(error.message, /describes commit f{40}, but this run is 1234/);
});

test('a release.json other than the one the build job wrote is refused, however consistent', async () => {
	// What another job of the caller's workflow could put in place of the artifact: files and
	// release.json that agree with each other, but aren't what the build job reported.
	const dir = agentBuild();
	const expected = agentPlan(dir);
	writeFileSync(path.join(dir, 'zutun-agent-linux-amd64'), 'another binary');
	writeRelease(dir, {
		commit: COMMIT,
		notes: 'Build 42.',
		artifacts: ['amd64', 'arm64'].map((arch) => ({ kind: 'agent', name: `zutun-agent-linux-${arch}`, version: 42, file: `zutun-agent-linux-${arch}`, manifest_reader: READER })),
	});
	const { error, kms, cp } = await run({ dir, expected });
	assert.match(error.message, /release\.json isn't the one the build job of this run wrote/);
	assert.equal(kms.requests.length, 0);
	assert.equal(cp.requests.length, 0);
});

test('only what the plan names is signed: another name, kind or version is refused', async () => {
	const stack = () => {
		const dir = scratch({ 'mail.tar.gz': 'bundle' });
		writeRelease(dir, { commit: COMMIT, notes: null, artifacts: [{ kind: 'stack', name: 'mail', version: 3, file: 'mail.tar.gz' }] });
		return dir;
	};
	for (const [plan, family, key] of [
		[{ kind: 'stack', name: 'cloud', version: 3 }, 'release-modules', MODULES_KEY],
		[{ kind: 'stack', name: 'mail', version: 4 }, 'release-modules', MODULES_KEY],
		[{ kind: 'agent', name: 'agent', version: 3 }, 'release-core', CORE_KEY],
	]) {
		const dir = stack();
		const { error, kms } = await run({ dir, key, family, expected: { ...plan, releaseSha256: releaseFileSha256(dir) } });
		assert.match(error?.message ?? '', /this run releases .* but release\.json lists stack mail v3/, JSON.stringify(plan));
		assert.equal(kms.requests.length, 0);
	}
	// The agent's plan wants both architectures, not one.
	const one = scratch({ 'zutun-agent-linux-amd64': 'amd64 binary' });
	writeRelease(one, { commit: COMMIT, notes: null, artifacts: [{ kind: 'agent', name: 'zutun-agent-linux-amd64', version: 42, file: 'zutun-agent-linux-amd64', manifest_reader: READER }] });
	const { error } = await run({ dir: one, expected: { ...agentPlan(one) } });
	assert.match(error.message, /this run releases agent zutun-agent-linux-amd64 v42, agent zutun-agent-linux-arm64 v42, but release\.json lists agent zutun-agent-linux-amd64 v42/);
});

test('an upload refusal of the second artifact is reported (the first stays uploaded)', async () => {
	const { error, cp } = await run({ cp: { script: { begin: [undefined, { status: 409, json: { code: 'version' } }] } } });
	assert.match(error.message, /zutun-agent-linux-arm64 v42: the control plane already has this version/);
	assert.equal([...cp.releases.values()].length, 1);
});
