// Artifact references and their signatures (PROTOCOL §6.1 to §6.3).

import { createPublicKey, KeyObject, verify } from 'node:crypto';
import { ReleaseError } from './actions.mjs';

/** The size limit of each kind (PROTOCOL §6.1); the agent refuses anything larger. */
export const MAX_SIZE = { stack: 64 * 1024 * 1024, agent: 128 * 1024 * 1024 };

/** The string an artifact signature covers (PROTOCOL §6.1), without a trailing newline. */
export function signedString({ kind, name, version, sha256, size }) {
	return ['zutun-artifact-v1', kind, name, String(version), sha256, String(size)].join('\n');
}

/**
 * The key families the pipeline signs with and what each may sign (PROTOCOL §6.3). Standby keys
 * are offline and never used here.
 */
export const FAMILIES = {
	'release-modules': (a) => a.kind === 'stack' && a.name !== 'host' && a.name !== 'ingress',
	'release-core': (a) => a.kind === 'agent' || (a.kind === 'stack' && (a.name === 'host' || a.name === 'ingress')),
	staging: () => true,
};

const KMS_VERSION =
	/^projects\/[a-z0-9-]+\/locations\/[a-z0-9-]+\/keyRings\/[A-Za-z0-9_-]{1,63}\/cryptoKeys\/([A-Za-z0-9_-]{1,63})\/cryptoKeyVersions\/([1-9][0-9]*)$/;

/**
 * The `key_id` of a Cloud KMS key version: `<crypto key>-<version>`, so the version 1 of the key
 * `release-modules` signs as `release-modules-1` (docs/google-cloud-kms.md). One variable then
 * names the key and its id, and they can't disagree.
 */
export function keyIdOf(kmsKeyVersion) {
	const m = KMS_VERSION.exec(kmsKeyVersion ?? '');
	if (!m) {
		throw new ReleaseError(
			`"${kmsKeyVersion}" isn't a Cloud KMS key version: projects/<project>/locations/<location>/keyRings/<ring>/cryptoKeys/<key>/cryptoKeyVersions/<n>`,
		);
	}
	return { keyId: `${m[1]}-${m[2]}`, family: m[1] };
}

/** Throws unless `family` is the one expected and may sign every artifact. */
export function checkScope(family, expected, artifacts) {
	if (family !== expected) {
		throw new ReleaseError(`this workflow signs with a ${expected} key, but the key configured is a ${family} key`);
	}
	for (const a of artifacts) {
		if (!FAMILIES[family](a)) throw new ReleaseError(`a ${family} key may not sign ${a.kind} ${a.name} (PROTOCOL §6.3)`);
	}
}

/** A public KeyObject from a KeyObject or a PEM. */
const publicKeyOf = (key) => (key instanceof KeyObject && key.type === 'public' ? key : createPublicKey(key));

/** The raw 32-byte Ed25519 public key, base64: the form agents embed and RELEASE_KEYS lists. */
export function rawPublicKey(key) {
	const der = publicKeyOf(key).export({ type: 'spki', format: 'der' });
	return der.subarray(der.length - 32).toString('base64');
}

/** Whether `sig` (base64) is a valid Ed25519 signature of the reference by `key`. */
export function verifyRef(key, ref, sig) {
	return verify(null, Buffer.from(signedString(ref)), publicKeyOf(key), Buffer.from(sig, 'base64'));
}
