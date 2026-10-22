// Whether an image can be pulled without credentials (MANIFEST §10: servers pull public images
// and hold no registry credentials). Asked the way an anonymous client asks: an anonymous pull
// token from the registry, then the manifest by digest.

import { ReleaseError } from './actions.mjs';
import { Retryable, transient, withRetries } from './http.mjs';

const ACCEPT = [
	'application/vnd.oci.image.index.v1+json',
	'application/vnd.docker.distribution.manifest.list.v2+json',
	'application/vnd.oci.image.manifest.v1+json',
	'application/vnd.docker.distribution.manifest.v2+json',
].join(', ');

/**
 * True if `ghcr.io/<path>@<digest>` is publicly pullable, false if the registry refuses an
 * anonymous client. `registry` and `fetch` are for tests.
 */
export async function isPublic(repository, digest, { registry = 'https://ghcr.io', fetch = globalThis.fetch, retry = {} } = {}) {
	const path = repository.replace(/^ghcr\.io\//, '');
	return withRetries(async () => {
		const tokenUrl = new URL('/token', registry);
		tokenUrl.searchParams.set('scope', `repository:${path}:pull`);
		tokenUrl.searchParams.set('service', new URL(registry).host);
		const tokenResponse = await fetch(tokenUrl);
		if (transient(tokenResponse.status)) throw new Retryable(`token request answered ${tokenResponse.status}`);
		if (!tokenResponse.ok) return false;
		const { token } = await tokenResponse.json().catch(() => ({}));
		if (typeof token !== 'string') return false;
		const response = await fetch(new URL(`/v2/${path}/manifests/${digest}`, registry), {
			method: 'HEAD',
			headers: { authorization: `Bearer ${token}`, accept: ACCEPT },
		});
		if (transient(response.status)) throw new Retryable(`manifest request answered ${response.status}`);
		return response.ok;
	}, retry);
}

/** Throws a ReleaseError naming every pushed image that isn't public. */
export async function requirePublic(digests, options) {
	const hidden = [];
	for (const [repository, digest] of Object.entries(digests)) {
		if (!(await isPublic(repository, digest, options))) hidden.push(repository);
	}
	if (hidden.length) {
		throw new ReleaseError(
			`${hidden.join(', ')} ${hidden.length === 1 ? "isn't" : "aren't"} public. Servers pull without credentials (MANIFEST §10), so nothing is signed. ` +
				'On GitHub: the package > Package settings > Danger Zone > Change visibility > Public (a new package starts private). Then re-run this workflow.',
		);
	}
}
