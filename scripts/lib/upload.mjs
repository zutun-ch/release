// The release upload of CONTROL-PLANE §7, in its three steps, so the bundle never passes through
// the control plane's Worker:
//   1. POST <origin>/api/releases with the artifact reference, the commit and notes, and a fresh
//      GitHub OIDC token: answers 201 with a release id and a presigned PUT URL (10 minutes,
//      bound to the size);
//   2. PUT the bytes to that URL;
//   3. POST <origin>/api/releases/<id>/complete with another fresh token (a token's jti is
//      accepted once): the control plane checks the bytes and makes the release available.
// Answers that may pass (the network, 429, 5xx) are retried, each time with a new token. A
// refusal ends the upload with what the control plane said and what to do about it.

import { ReleaseError } from './actions.mjs';
import { jsonBody, Retryable, transient, withRetries } from './http.mjs';

const RELEASE_ID = /^rel_[0-9A-HJKMNP-TV-Z]{26}$/;
const NOTES_MAX_BYTES = 2000;

/** An origin as the control plane checks it (the token's audience): https, no path. */
export function checkOrigin(origin) {
	let url;
	try {
		url = new URL(origin);
	} catch {
		throw new ReleaseError(`"${origin}" isn't a URL; the control-plane origin looks like https://admin.example.test`);
	}
	const loopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost';
	if (url.origin !== origin || !(url.protocol === 'https:' || (loopback && url.protocol === 'http:'))) {
		throw new ReleaseError(`"${origin}" isn't an origin: https://<host>, without a path or a trailing slash`);
	}
	return origin;
}

/** Text cut to at most `max` UTF-8 bytes, never inside a character. */
export function truncateUtf8(text, max = NOTES_MAX_BYTES) {
	const bytes = Buffer.from(text, 'utf8');
	if (bytes.length <= max) return text;
	let end = max;
	while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
	return bytes.subarray(0, end).toString('utf8');
}

/** What a step 1 refusal means for the person running the release. */
function explainBegin(code, body, { ref, uncertain }) {
	const what = `${ref.kind} ${ref.name} v${ref.version}`;
	const earlier = uncertain
		? ' An earlier attempt of this step may have reached the control plane before failing; if so, its upload is given up after 20 minutes, and re-running the workflow then succeeds.'
		: '';
	switch (code) {
		case 'not_registered':
			return `${ref.name} isn't registered on the control plane. A platform admin registers it with this repository first.`;
		case 'repository':
			return `the control plane has ${ref.name} registered to another repository.`;
		case 'workflow':
			return 'the job is not the pinned release workflow on main: the caller must use <owner>/release/.github/workflows/<module|core>.yml@main.';
		case 'ref':
			return `the run's ref isn't refs/tags/v${ref.version}.`;
		case 'environment':
			return 'the upload job doesn\'t run in the GitHub environment "release".';
		case 'commit':
			return "the commit sent isn't the commit of the workflow run.";
		case 'version':
			return `${what}: the control plane already has this version or a higher one. Tag a higher version.${earlier}`;
		case 'sha256_in_use':
			return `another release already has this exact bundle (the same sha256).${earlier}`;
		case 'signature':
			return `the control plane doesn't accept the signature (${body?.reason ?? 'no reason given'}): is the key id in its RELEASE_KEYS setting, not revoked, and in scope for ${what}?`;
		default:
			return `the control plane refused the upload of ${what}: ${code}${body?.reason ? ` (${body.reason})` : ''}.`;
	}
}

/**
 * Uploads one artifact. `bytes` is the artifact, `ref` its signed reference (PROTOCOL §6.1),
 * `nextToken` returns a fresh OIDC token on each call. `fetch`, `retry` and `now` are for tests.
 */
export async function uploadRelease({
	origin,
	ref,
	commit,
	notes = null,
	bytes,
	nextToken,
	fetch = globalThis.fetch,
	retry = {},
	log = (line) => console.log(line),
	now = Date.now,
}) {
	checkOrigin(origin);
	const what = `${ref.kind} ${ref.name} v${ref.version}`;
	const post = async (url, body) => {
		const token = await nextToken();
		return fetch(url, {
			method: 'POST',
			headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
			body: JSON.stringify(body),
		});
	};

	// Step 1: the reference.
	let uncertain = false;
	const begun = await withRetries(
		async () => {
			const response = await post(`${origin}/api/releases`, {
				...ref,
				commit,
				notes: notes ? truncateUtf8(notes) : null,
			});
			const body = await jsonBody(response);
			if (response.status === 201 && RELEASE_ID.test(body?.id ?? '') && typeof body.upload_url === 'string') {
				return body;
			}
			if (response.status === 201) {
				throw new ReleaseError('the control plane answered 201 without a release id and an upload URL');
			}
			if (transient(response.status)) {
				throw new Retryable(`POST /api/releases answered ${response.status} ${body?.code ?? ''}`.trim());
			}
			throw new ReleaseError(`upload of ${what} refused (${response.status}): ${explainBegin(body?.code, body, { ref, uncertain })}`);
		},
		// A failed attempt may still have reached the control plane; the refusal says so.
		{ ...retry, log: (line) => ((uncertain = true), log(line)) },
	);
	log(`release ${begun.id} started for ${what}; uploading ${bytes.length} bytes`);

	// Step 2: the bytes, to object storage directly.
	const uploadUrl = new URL(begun.upload_url);
	if (uploadUrl.protocol !== 'https:' && !/^(127\.0\.0\.1|localhost)$/.test(uploadUrl.hostname)) {
		throw new ReleaseError('the control plane answered an upload URL that isn\'t https');
	}
	const expires = Date.parse(begun.expires ?? '');
	await withRetries(async () => {
		if (Number.isFinite(expires) && now() >= expires) {
			throw new ReleaseError(`the upload URL of release ${begun.id} expired before the upload went through; re-run the workflow`);
		}
		const response = await fetch(uploadUrl, { method: 'PUT', body: bytes });
		if (response.ok) return;
		const text = (await response.text().catch(() => '')).slice(0, 300);
		if (transient(response.status)) throw new Retryable(`PUT answered ${response.status}`);
		throw new ReleaseError(`object storage refused the upload of release ${begun.id} (${response.status}): ${text}`);
	}, retry);

	// Step 3: the control plane checks what arrived.
	let lostAnswer = false;
	const done = await withRetries(
		async () => {
			const response = await post(`${origin}/api/releases/${begun.id}/complete`, {});
			const body = await jsonBody(response);
			if (response.status === 200 && body?.state === 'available') return body;
			if (transient(response.status) || body?.code === 'claimed') {
				throw new Retryable(`POST /api/releases/${begun.id}/complete answered ${response.status} ${body?.code ?? ''}`.trim());
			}
			if (response.status === 422 && body?.code === 'rejected') {
				throw new ReleaseError(
					`the control plane rejected release ${begun.id} of ${what}: ${body.reason}${body.path ? ` (${body.path})` : ''}`,
				);
			}
			if (body?.code === 'state' && lostAnswer) {
				throw new ReleaseError(
					`release ${begun.id} is no longer uploading: an earlier attempt of this step may have completed it. Check the release in admin before running it again.`,
				);
			}
			throw new ReleaseError(`completing release ${begun.id} of ${what} refused (${response.status}): ${body?.code ?? 'no code'}`);
		},
		{ attempts: 4, delayMs: 5000, ...retry, log: (line) => ((lostAnswer = true), log(line)) },
	);
	log(`release ${done.id} of ${what} is available`);
	return done;
}
