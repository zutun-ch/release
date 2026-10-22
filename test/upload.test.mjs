// The upload client against a local fake of the three steps of CONTROL-PLANE §7: fresh tokens,
// retries of what may pass, and refusals explained.
import assert from 'node:assert/strict';
import { createHash, sign } from 'node:crypto';
import { after, test } from 'node:test';
import { ReleaseError } from '../scripts/lib/actions.mjs';
import { signedString } from '../scripts/lib/artifact.mjs';
import { githubTokens } from '../scripts/lib/oidc.mjs';
import { checkOrigin, truncateUtf8, uploadRelease } from '../scripts/lib/upload.mjs';
import { fakeControlPlane, fakeGithubOidc } from './fakes.mjs';
import { keyFromSeed, noWait } from './helpers.mjs';

const key = keyFromSeed('6d0e6253fc5085dd6c9811479f9d4a2ae666d0ea2d8ab92a010b962b787ed5e3');
const COMMIT = 'c0ffee'.padEnd(40, '0');
const bytes = Buffer.from('a bundle, as far as this test is concerned\n');

function signedRef(overrides = {}) {
	const ref = { kind: 'stack', name: 'mail', version: 12, sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length, ...overrides };
	const sig = sign(null, Buffer.from(signedString(ref)), key.privateKey).toString('base64');
	return { ...ref, sig, key_id: 'release-modules-1' };
}

const oidc = await fakeGithubOidc();
after(() => oidc.close());

async function attempt(script, options = {}) {
	const cp = await fakeControlPlane({ publicKey: key.publicKey, commit: COMMIT, script });
	const lines = [];
	try {
		const result = await uploadRelease({
			origin: cp.url,
			ref: options.ref ?? signedRef(),
			commit: COMMIT,
			notes: 'First release.',
			bytes,
			nextToken: githubTokens(cp.url, { env: oidc.env, retry: noWait }),
			retry: noWait,
			log: (line) => lines.push(line),
			...options.upload,
		});
		return { cp, result, lines };
	} catch (error) {
		return { cp, error, lines };
	} finally {
		await cp.close();
	}
}

test('three steps: reference, bytes, complete; each POST with its own token for the origin', async () => {
	const { cp, result, error } = await attempt();
	assert.equal(error, undefined);
	assert.equal(result.state, 'available');
	const [begin, put, complete] = cp.requests;
	assert.equal(begin.method, 'POST');
	assert.equal(begin.url, '/api/releases');
	const body = JSON.parse(begin.body);
	assert.deepEqual(body, { ...signedRef(), commit: COMMIT, notes: 'First release.' });
	assert.equal(put.method, 'PUT');
	assert.deepEqual(put.body, bytes);
	assert.equal(put.headers.authorization, undefined, 'the presigned URL carries its own authorization');
	assert.equal(complete.url, `/api/releases/${result.id}/complete`);
	assert.notEqual(begin.headers.authorization, complete.headers.authorization);
	assert.match(begin.headers.authorization, new RegExp(`^Bearer oidc-\\d+-${cp.url.replace(/[.:/]/g, '\\$&')}$`));
	assert.equal(cp.releases.get(result.id).state, 'available');
});

test('step 1: a 503 is retried with a fresh token', async () => {
	const { cp, error } = await attempt({ begin: [{ status: 503, json: { code: 'storage_unavailable' } }] });
	assert.equal(error, undefined);
	const posts = cp.requests.filter((r) => r.url === '/api/releases');
	assert.equal(posts.length, 2);
	assert.notEqual(posts[0].headers.authorization, posts[1].headers.authorization);
});

test('step 1: a refusal stops at once and says what to do', async () => {
	const cases = [
		[{ status: 409, json: { code: 'version' } }, /already has this version or a higher one\. Tag a higher version\.$/],
		[{ status: 403, json: { code: 'not_registered' } }, /isn't registered on the control plane/],
		[{ status: 403, json: { code: 'workflow' } }, /pinned release workflow on main/],
		[{ status: 403, json: { code: 'environment' } }, /environment "release"/],
		[{ status: 422, json: { code: 'signature', reason: 'unknown_key' } }, /\(unknown_key\): is the key id in its RELEASE_KEYS/],
		[{ status: 400, json: { code: 'invalid_request' } }, /refused the upload of stack mail v12: invalid_request/],
	];
	for (const [answer, message] of cases) {
		const { cp, error } = await attempt({ begin: [answer] });
		assert.ok(error instanceof ReleaseError, answer.json.code);
		assert.match(error.message, message);
		assert.equal(cp.requests.length, 1, `${answer.json.code}: no retry, no PUT`);
	}
});

test('step 1: a refusal after a failed attempt mentions that attempt', async () => {
	const { error } = await attempt({ begin: ['drop', { status: 409, json: { code: 'version' } }] });
	assert.match(error.message, /An earlier attempt of this step may have reached the control plane/);
});

test('step 1: the real check refuses a wrong commit and a bad signature', async () => {
	const wrongCommit = await attempt({}, { upload: { commit: 'f'.repeat(40) } });
	assert.match(wrongCommit.error.message, /commit sent isn't the commit of the workflow run/);
	const badSig = await attempt({}, { ref: { ...signedRef(), version: 13 } });
	assert.match(badSig.error.message, /doesn't accept the signature/);
});

test('step 2: a 5xx is retried, a 403 is not', async () => {
	const retried = await attempt({ put: [{ status: 500, text: 'oops' }] });
	assert.equal(retried.error, undefined);
	assert.equal(retried.cp.requests.filter((r) => r.method === 'PUT').length, 2);
	const refused = await attempt({ put: [{ status: 403, text: 'SignatureDoesNotMatch' }] });
	assert.match(refused.error.message, /object storage refused the upload of release rel_\w+ \(403\): SignatureDoesNotMatch/);
});

test('step 2: an expired upload URL is not used', async () => {
	const { error, cp } = await attempt({}, { upload: { now: () => Date.now() + 3600_000 } });
	assert.match(error.message, /expired/);
	assert.equal(cp.requests.filter((r) => r.method === 'PUT').length, 0);
});

test('step 3: storage_unavailable and a lost connection are retried with fresh tokens', async () => {
	const { cp, error } = await attempt({ complete: [{ status: 503, json: { code: 'storage_unavailable' } }, 'drop'] });
	assert.equal(error, undefined);
	const completes = cp.requests.filter((r) => r.url.endsWith('/complete'));
	assert.equal(completes.length, 3);
	assert.equal(new Set(completes.map((r) => r.headers.authorization)).size, 3);
});

test('step 3: a rejection names the reason and is final', async () => {
	const { cp, error } = await attempt({ complete: [{ status: 422, json: { code: 'rejected', reason: 'entrypoint_missing', path: 'scripts/x.sh' } }] });
	assert.match(error.message, /rejected release rel_\w+ of stack mail v12: entrypoint_missing \(scripts\/x.sh\)/);
	assert.equal(cp.requests.filter((r) => r.url.endsWith('/complete')).length, 1);
});

test('step 3: completed by an attempt whose answer was lost', async () => {
	const completedThenDropped = ({ releases, id }) => {
		releases.get(id).state = 'available';
		return 'drop';
	};
	const { error } = await attempt({ complete: [completedThenDropped] });
	assert.match(error.message, /may have completed it\. Check the release in admin/);
});

test('step 3: run_mismatch and other refusals are reported with their code', async () => {
	const { error } = await attempt({ complete: [{ status: 409, json: { code: 'run_mismatch' } }] });
	assert.match(error.message, /refused \(409\): run_mismatch/);
});

test('a non-https upload URL is refused', async () => {
	const { error } = await attempt({ begin: [{ status: 201, json: { id: 'rel_01JZ0000000000000000000099', upload_url: 'http://storage.example.test/x', expires: new Date(Date.now() + 60_000).toISOString() } }] });
	assert.match(error.message, /isn't https/);
});

test('origins: https without a path; http only on loopback', () => {
	assert.equal(checkOrigin('https://admin.example.test'), 'https://admin.example.test');
	assert.equal(checkOrigin('http://127.0.0.1:8787'), 'http://127.0.0.1:8787');
	for (const bad of ['', 'admin.example.test', 'https://admin.example.test/', 'https://admin.example.test/api', 'http://admin.example.test']) {
		assert.throws(() => checkOrigin(bad), ReleaseError, bad);
	}
});

test('notes are cut to 2000 UTF-8 bytes, never inside a character', () => {
	assert.equal(truncateUtf8('short'), 'short');
	const cut = truncateUtf8('ä'.repeat(1001));
	assert.equal(Buffer.byteLength(cut), 2000);
	const odd = truncateUtf8(`x${'ä'.repeat(1000)}`);
	assert.equal(Buffer.byteLength(odd), 1999);
	assert.ok(!odd.includes('�'));
});

test('GitHub OIDC: each call is a new token for the audience; missing permission is explained', async () => {
	const next = githubTokens('https://admin.example.test', { env: oidc.env });
	const [a, b] = [await next(), await next()];
	assert.notEqual(a, b);
	assert.match(a, /-https:\/\/admin\.example\.test$/);
	assert.throws(() => githubTokens('https://admin.example.test', { env: {} }), /id-token: write/);
	const refused = githubTokens('https://admin.example.test', { env: { ...oidc.env, ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'wrong' } });
	await assert.rejects(refused(), /GitHub refused an OIDC token \(401\)/);
});
