// Local stand-ins for the services the publish step talks to: GitHub's OIDC token endpoint, Cloud
// KMS and the control plane's three upload steps (CONTROL-PLANE §7), close enough to their real
// answers that the clients are exercised as they will be in a workflow run.

import { createHash, sign } from 'node:crypto';
import { crc32c } from '../scripts/lib/crc32c.mjs';
import { verifyRef } from '../scripts/lib/artifact.mjs';
import { fakeServer } from './helpers.mjs';

/** GitHub's token endpoint: a new token for each request, recording the audience asked for. */
export async function fakeGithubOidc() {
	let n = 0;
	const server = await fakeServer((req) => {
		const audience = new URL(req.url, 'http://x').searchParams.get('audience');
		if (req.headers.authorization !== 'bearer runner-token') return { status: 401, json: {} };
		n += 1;
		return { json: { value: `oidc-${n}-${audience}` } };
	});
	return {
		...server,
		env: { ACTIONS_ID_TOKEN_REQUEST_URL: `${server.url}/token?api-version=2.0`, ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'runner-token' },
	};
}

/**
 * Cloud KMS for one key version. `options.signWith` signs with another key (a wrong signature),
 * `options.algorithm` reports another algorithm, `options.refuse` answers every request with
 * that status.
 */
export async function fakeKms(name, key, options = {}) {
	const pem = key.publicKey.export({ type: 'spki', format: 'pem' });
	return fakeServer((req) => {
		if (req.headers.authorization !== 'Bearer google-token') return { status: 401, json: { error: { message: 'no token' } } };
		if (options.refuse) return { status: options.refuse, json: { error: { message: 'Permission denied' } } };
		const url = decodeURIComponent(req.url);
		if (req.method === 'GET' && url === `/v1/${name}/publicKey`) {
			return { json: { pem, pemCrc32c: String(crc32c(Buffer.from(pem))), algorithm: options.algorithm ?? 'EC_SIGN_ED25519', name } };
		}
		if (req.method === 'POST' && url === `/v1/${name}:asymmetricSign`) {
			const body = JSON.parse(req.body);
			const data = Buffer.from(body.data, 'base64');
			const signature = sign(null, data, (options.signWith ?? key).privateKey);
			return {
				json: {
					signature: signature.toString('base64'),
					signatureCrc32c: String(crc32c(signature)),
					verifiedDataCrc32c: options.verifiedDataCrc32c ?? body.dataCrc32c === String(crc32c(data)),
					name,
					protectionLevel: 'SOFTWARE',
				},
			};
		}
		return { status: 404, json: { error: { message: `no route ${req.method} ${url}` } } };
	});
}

/**
 * The control plane's release upload: checks fresh tokens, the commit, versions, the signature
 * against `publicKey` and the uploaded bytes. `script` overrides answers per step and attempt:
 * { begin: [answer…], put: [...], complete: [...] }, where an answer is an HTTP answer or 'drop'
 * (the connection closes without one), or a function of { releases, id } returning one; once a
 * list is used up the fake answers for real.
 */
export async function fakeControlPlane({ publicKey, commit, script = {} }) {
	const seen = new Set();
	const releases = new Map();
	const attempts = { begin: 0, put: 0, complete: 0 };
	let n = 0;
	const scripted = (step, context) => {
		const answer = script[step]?.[attempts[step]++];
		return typeof answer === 'function' ? answer(context) : answer;
	};
	const tokenOk = (req) => {
		const token = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];
		if (!token || seen.has(token)) return false;
		seen.add(token);
		return true;
	};
	const server = await fakeServer((req) => {
		const url = new URL(req.url, 'http://x');
		if (req.method === 'POST' && url.pathname === '/api/releases') {
			const override = scripted('begin');
			if (!tokenOk(req)) return { status: 409, json: { code: 'token_replayed' } };
			if (override) return override;
			const body = JSON.parse(req.body);
			const { kind, name, version, sha256, size, sig, key_id } = body;
			if (body.commit !== commit) return { status: 403, json: { code: 'commit' } };
			if ([...releases.values()].some((r) => r.ref.name === name && r.ref.version >= version)) {
				return { status: 409, json: { code: 'version' } };
			}
			if (!verifyRef(publicKey, { kind, name, version, sha256, size }, sig)) {
				return { status: 422, json: { code: 'signature', reason: 'signature' } };
			}
			n += 1;
			const id = `rel_01JZ${String(n).padStart(22, '0')}`;
			releases.set(id, { ref: { kind, name, version, sha256, size, sig, key_id }, body, state: 'uploading', bytes: null });
			return { status: 201, json: { id, upload_url: `${server.url}/upload/${id}`, expires: new Date(Date.now() + 600_000).toISOString() } };
		}
		if (req.method === 'PUT' && url.pathname.startsWith('/upload/')) {
			const override = scripted('put');
			if (override) return override;
			const release = releases.get(url.pathname.slice('/upload/'.length));
			if (!release || Number(req.headers['content-length']) !== release.ref.size) return { status: 403, text: 'SignatureDoesNotMatch' };
			release.bytes = req.body;
			return { status: 200, text: '' };
		}
		const complete = /^\/api\/releases\/([^/]+)\/complete$/.exec(url.pathname);
		if (req.method === 'POST' && complete) {
			const override = scripted('complete', { releases, id: complete[1] });
			if (!tokenOk(req)) return { status: 409, json: { code: 'token_replayed' } };
			if (override) return override;
			const release = releases.get(complete[1]);
			if (!release) return { status: 404, json: { code: 'not_found' } };
			if (release.state !== 'uploading') return { status: 409, json: { code: 'state' } };
			const ok = release.bytes && createHash('sha256').update(release.bytes).digest('hex') === release.ref.sha256;
			if (!ok) {
				release.state = 'rejected';
				return { status: 422, json: { code: 'rejected', reason: release.bytes ? 'hash' : 'missing' } };
			}
			release.state = 'available';
			return { status: 200, json: { id: complete[1], state: 'available' } };
		}
		return { status: 404, json: { code: 'not_found' } };
	});
	return { ...server, releases, attempts };
}
