// The signed string and signatures against platform/test-vectors/artifact-signatures.json, key ids
// from KMS key versions, key scopes, and CRC32C.
import assert from 'node:assert/strict';
import { sign } from 'node:crypto';
import { test } from 'node:test';
import { ReleaseError } from '../scripts/lib/actions.mjs';
import { checkScope, keyIdOf, rawPublicKey, signedString, verifyRef } from '../scripts/lib/artifact.mjs';
import { crc32c } from '../scripts/lib/crc32c.mjs';
import { keyFromSeed, platformFile, readJson } from './helpers.mjs';

const vectors = readJson(platformFile('test-vectors/artifact-signatures.json'));
const keys = new Map(vectors.keys.map((k) => [k.key_id, { ...k, ...keyFromSeed(k.seed_hex) }]));

test('the vectors are the ones this test expects', () => {
	assert.equal(vectors.spec, 'PROTOCOL.md §6');
	assert.ok(vectors.cases.length >= 5);
});

test('signedString matches every vector byte for byte', () => {
	for (const c of vectors.cases) {
		// A reference changed after signing keeps the string that was signed.
		if (c.expect === 'reject:signature') assert.notEqual(signedString(c.ref), c.signed_string, c.description);
		else assert.equal(signedString(c.ref), c.signed_string, c.description);
	}
});

test("our Ed25519 signatures of each signed string equal the vectors' (Ed25519 is deterministic)", () => {
	for (const c of vectors.cases) {
		const key = keys.get(c.ref.key_id);
		if (!key) continue;
		const sig = sign(null, Buffer.from(c.signed_string), key.privateKey).toString('base64');
		assert.equal(sig, c.ref.sig, c.description);
	}
});

test('a signature verifies exactly when the vector says the signature check passes', () => {
	const order = vectors.check_order;
	for (const c of vectors.cases) {
		const key = keys.get(c.ref.key_id);
		if (!key) continue; // unknown_key: nothing to verify against
		const reason = c.expect.startsWith('reject:') ? c.expect.slice('reject:'.length) : null;
		// Checks before `signature` may reject a well-signed reference (scope, revocation); a
		// rejection at `signature` means the signature itself is bad.
		const signatureFails = reason === 'signature';
		const reachedSignature = reason === null || order.indexOf(reason) > order.indexOf('signature');
		const ok = verifyRef(key.publicKey, c.ref, c.ref.sig);
		if (signatureFails) assert.equal(ok, false, c.description);
		else if (reachedSignature) assert.equal(ok, true, c.description);
	}
});

test("rawPublicKey gives the vectors' base64 public keys", () => {
	for (const k of keys.values()) assert.equal(rawPublicKey(k.publicKey), k.public_key, k.key_id);
});

test('key ids come from the KMS key version: <crypto key>-<version>', () => {
	const ring = 'projects/zutun-release/locations/europe-west6/keyRings/zutun-release';
	assert.deepEqual(keyIdOf(`${ring}/cryptoKeys/release-modules/cryptoKeyVersions/1`), { keyId: 'release-modules-1', family: 'release-modules' });
	assert.deepEqual(keyIdOf(`${ring}/cryptoKeys/release-core/cryptoKeyVersions/12`), { keyId: 'release-core-12', family: 'release-core' });
	for (const bad of ['', 'release-core-1', `${ring}/cryptoKeys/release-core`, `${ring}/cryptoKeys/release-core/cryptoKeyVersions/0`,
		`${ring}/cryptoKeys/release-core/cryptoKeyVersions/1/extra`, `https://x/${ring}/cryptoKeys/a/cryptoKeyVersions/1`]) {
		assert.throws(() => keyIdOf(bad), ReleaseError, bad);
	}
});

test('scopes: module keys sign module stacks, core keys the agent and the platform stacks, staging anything', () => {
	const mail = { kind: 'stack', name: 'mail' };
	const host = { kind: 'stack', name: 'host' };
	const ingress = { kind: 'stack', name: 'ingress' };
	const agent = { kind: 'agent', name: 'zutun-agent-linux-amd64' };
	checkScope('release-modules', 'release-modules', [mail]);
	checkScope('release-core', 'release-core', [agent, host, ingress]);
	checkScope('staging', 'staging', [mail, agent, host]);
	assert.throws(() => checkScope('release-modules', 'release-modules', [ingress]), /may not sign stack ingress/);
	assert.throws(() => checkScope('release-modules', 'release-modules', [agent]), /may not sign agent/);
	assert.throws(() => checkScope('release-core', 'release-core', [mail]), /may not sign stack mail/);
	// The workflow decides which family it uses; a variable pointing at another key is refused.
	assert.throws(() => checkScope('release-core', 'release-modules', [mail]), /signs with a release-modules key/);
	assert.throws(() => checkScope('staging', 'release-modules', [mail]), ReleaseError);
});

test('CRC32C: the standard check value and an empty input', () => {
	assert.equal(crc32c(Buffer.from('123456789')), 0xe3069283);
	assert.equal(crc32c(Buffer.alloc(0)), 0);
	assert.equal(crc32c(Buffer.alloc(32)), 0x8a9136aa);
});
