// Signing and uploading a built release (architecture §8, steps 5 and 6):
// 1. read release.json and check every file against it;
// 2. derive the key id from the KMS key version and check the key may sign these artifacts;
// 3. fetch the key's public key and sign every artifact's reference through Cloud KMS;
// 4. verify every signature locally against that public key;
// 5. only then upload each artifact in the three steps of CONTROL-PLANE §7.
// Nothing is uploaded unless every artifact of the release is signed and verified, so the two
// agent architectures go out together or not at all.

import { ReleaseError } from './actions.mjs';
import { checkScope, keyIdOf, rawPublicKey, signedString, verifyRef } from './artifact.mjs';
import { readRelease } from './release.mjs';
import { uploadRelease } from './upload.mjs';

/**
 * `kms` is a client from kms.mjs, `nextToken` returns fresh GitHub OIDC tokens for `origin`.
 * Returns the uploaded references.
 */
export async function publish({ dir, commit, origin, kmsKeyVersion, family, kms, nextToken, fetch, retry, log = console.log }) {
	const release = readRelease(dir, { commit });
	const { keyId, family: keyFamily } = keyIdOf(kmsKeyVersion);
	checkScope(keyFamily, family, release.artifacts);

	const publicKey = await kms.publicKey(kmsKeyVersion);
	log(`signing with ${keyId}, public key ${rawPublicKey(publicKey)}`);

	const refs = [];
	for (const a of release.artifacts) {
		const ref = { kind: a.kind, name: a.name, version: a.version, sha256: a.sha256, size: a.size };
		const signature = await kms.sign(kmsKeyVersion, Buffer.from(signedString(ref)));
		const sig = signature.toString('base64');
		if (!verifyRef(publicKey, ref, sig)) {
			throw new ReleaseError(`the signature Cloud KMS returned for ${a.name} v${a.version} doesn't verify against ${keyId}'s public key`);
		}
		refs.push({ ref: { ...ref, sig, key_id: keyId }, bytes: a.bytes });
	}

	for (const { ref, bytes } of refs) {
		await uploadRelease({ origin, ref, commit, notes: release.notes, bytes, nextToken, fetch, retry, log });
	}
	return refs.map((r) => r.ref);
}
