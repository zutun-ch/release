// GitHub Actions OIDC tokens for the control plane (CONTROL-PLANE §7): a fresh one for each upload
// step, since the control plane accepts a token's `jti` once. The runner hands a job with
// `permissions: id-token: write` a URL and a bearer token to request them with.

import { ReleaseError } from './actions.mjs';
import { jsonBody, Retryable, transient, withRetries } from './http.mjs';

/**
 * A function that returns a new token for `audience` (the control plane's origin) on each call.
 * `env` and `fetch` are for tests.
 */
export function githubTokens(audience, { env = process.env, fetch = globalThis.fetch, retry = {} } = {}) {
	const url = env.ACTIONS_ID_TOKEN_REQUEST_URL;
	const bearer = env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
	if (!url || !bearer) {
		throw new ReleaseError('no GitHub OIDC token available: the job needs "permissions: id-token: write"');
	}
	return () =>
		withRetries(async () => {
			const request = new URL(url);
			request.searchParams.set('audience', audience);
			const response = await fetch(request, { headers: { authorization: `bearer ${bearer}` } });
			const body = await jsonBody(response);
			if (response.ok && typeof body?.value === 'string') return body.value;
			if (transient(response.status)) throw new Retryable(`GitHub's token service answered ${response.status}`);
			throw new ReleaseError(`GitHub refused an OIDC token (${response.status})`);
		}, retry);
}
