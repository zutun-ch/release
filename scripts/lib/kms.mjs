// Signing with a Cloud KMS Ed25519 key over its REST API (cloudkms.googleapis.com/v1). The key
// never leaves KMS. The token is the federated token google-github-actions/auth mints through
// Workload Identity Federation; IAM grants it the key directly, without a service account.
// Ed25519 signs the data itself, not a digest (PureEdDSA), so `data` carries the signed string.
// Requests and answers are checked with CRC32C as Google's integrity guidelines describe.

import { createPublicKey } from 'node:crypto';
import { ReleaseError } from './actions.mjs';
import { crc32c } from './crc32c.mjs';
import { jsonBody, Retryable, transient, withRetries } from './http.mjs';

export const KMS_ENDPOINT = 'https://cloudkms.googleapis.com/v1';
const GUIDE = 'see docs/google-cloud-kms.md in the release repo';

/** A KMS client for one token. `endpoint` and `fetch` are for tests. */
export function kmsClient({ token, endpoint = KMS_ENDPOINT, fetch = globalThis.fetch, retry = {} }) {
	if (!token) throw new ReleaseError('no Google Cloud token: the Workload Identity Federation step produced none');

	async function call(method, url, body) {
		return withRetries(async () => {
			const response = await fetch(url, {
				method,
				headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
				body: body === undefined ? undefined : JSON.stringify(body),
			});
			const answer = await jsonBody(response);
			if (response.ok && answer) return answer;
			const message = answer?.error?.message ?? `HTTP ${response.status}`;
			if (transient(response.status)) throw new Retryable(`Cloud KMS answered ${response.status}: ${message}`);
			const hint =
				response.status === 401 || response.status === 403
					? ` The workflow's federated identity may not use this key: check the key's IAM binding and the provider's attribute condition (${GUIDE}).`
					: '';
			throw new ReleaseError(`Cloud KMS refused ${method} ${url} (${response.status}): ${message}.${hint}`);
		}, retry);
	}

	return {
		/** The key version's public key, checked to be Ed25519 and intact. */
		async publicKey(name) {
			const answer = await call('GET', `${endpoint}/${name}/publicKey`);
			if (answer.algorithm !== 'EC_SIGN_ED25519') {
				throw new ReleaseError(`${name} is a ${answer.algorithm} key; releases are signed with EC_SIGN_ED25519 (${GUIDE})`);
			}
			if (typeof answer.pem !== 'string' || String(crc32c(Buffer.from(answer.pem))) !== String(answer.pemCrc32c)) {
				throw new ReleaseError(`the public key of ${name} arrived damaged (CRC32C mismatch)`);
			}
			return createPublicKey(answer.pem);
		},

		/** The Ed25519 signature of `data` (a Buffer) by the key version `name`. */
		async sign(name, data) {
			const answer = await call('POST', `${endpoint}/${name}:asymmetricSign`, {
				data: data.toString('base64'),
				dataCrc32c: String(crc32c(data)),
			});
			if (answer.verifiedDataCrc32c !== true) {
				throw new ReleaseError(`Cloud KMS didn't confirm the CRC32C of the data it signed with ${name}`);
			}
			if (answer.name !== name) {
				throw new ReleaseError(`Cloud KMS signed with ${answer.name}, not ${name}`);
			}
			const signature = Buffer.from(answer.signature ?? '', 'base64');
			if (String(crc32c(signature)) !== String(answer.signatureCrc32c)) {
				throw new ReleaseError(`the signature from ${name} arrived damaged (CRC32C mismatch)`);
			}
			return signature;
		},
	};
}
