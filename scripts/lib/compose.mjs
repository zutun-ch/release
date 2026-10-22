// Pinning pushed image digests into compose.yaml (MANIFEST §10: images by digest only).
//
// A repo's compose.yaml names each image it builds with a placeholder, the all-zero digest:
//   image: ghcr.io/<owner>/<image>@sha256:000…0   (64 zeros)
// It passes the compose policy's syntax check, and a bundle that still carries it can't be
// pulled, so it never runs. The pipeline replaces each placeholder with the digest it pushed.
// Images the repo doesn't build (a database, say) carry their real digest and are left alone.
// The file is edited line by line, so comments and layout stay as they are.

import { ReleaseError } from './actions.mjs';

export const PLACEHOLDER_DIGEST = `sha256:${'0'.repeat(64)}`;
const DIGEST = /^sha256:[0-9a-f]{64}$/;

/** `image: <ref>` on its own line, plain or quoted, with an optional comment. */
const IMAGE_LINE = /^(\s*(?:-\s+)?image:[ \t]*)(["']?)([^\s"'#]+)\2([ \t]*(?:#.*)?)$/;

/** The repository of a reference: without `@digest` and without a `:tag` after the last `/`. */
export function repositoryOf(ref) {
	const name = ref.split('@')[0];
	const slash = name.lastIndexOf('/');
	const colon = name.lastIndexOf(':');
	return colon > slash ? name.slice(0, colon) : name;
}

/**
 * Pins `digests` (image repository → `sha256:<hex>`) into the compose file. A null digest only
 * checks: every placeholder belongs to an image the repo builds and every built image has a
 * placeholder (pushes to main build without pushing, so there is no digest yet).
 * Returns the new text; throws a ReleaseError naming the line or image otherwise.
 */
export function pinDigests(text, digests) {
	const built = new Map(Object.entries(digests));
	for (const [repo, digest] of built) {
		if (digest !== null && !DIGEST.test(digest)) {
			throw new ReleaseError(`pushed digest of ${repo} isn't sha256:<64 hex>: "${digest}"`);
		}
	}
	const used = new Set();
	const lines = text.split('\n').map((line, i) => {
		if (!line.includes(PLACEHOLDER_DIGEST)) return line;
		const m = IMAGE_LINE.exec(line.replace(/\r$/, ''));
		if (!m || !m[3].endsWith(`@${PLACEHOLDER_DIGEST}`)) {
			throw new ReleaseError(
				`compose.yaml line ${i + 1}: the placeholder digest can only be pinned in "image: <repository>@${PLACEHOLDER_DIGEST}" on a line of its own`,
			);
		}
		const repo = repositoryOf(m[3]);
		if (!built.has(repo)) {
			const names = [...built.keys()];
			throw new ReleaseError(
				`compose.yaml line ${i + 1}: ${repo} carries the placeholder digest, but this repo builds ${
					names.length ? names.join(', ') : 'no image'
				} (image/Dockerfile or images/<suffix>/Dockerfile, see the release README)`,
			);
		}
		used.add(repo);
		const digest = built.get(repo);
		return digest === null ? line : line.replace(PLACEHOLDER_DIGEST, digest);
	});
	for (const repo of built.keys()) {
		if (!used.has(repo)) {
			throw new ReleaseError(
				`${repo} is built, but compose.yaml has no "image: ${repo}@${PLACEHOLDER_DIGEST}" to pin its digest into`,
			);
		}
	}
	return lines.join('\n');
}
