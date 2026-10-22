// The few things the pipeline reads from and writes to manifest.yaml, line by line so the file
// keeps its comments and layout: top-level scalars (`kind`, `name`, `version`) and the script
// entrypoints. The full validation (strict YAML, the JSON Schema) is `zutun-agent lint`'s, and
// the control plane repeats it on upload (CONTROL-PLANE §7); these reads only stop an obviously
// wrong bundle before it is signed.

import { ReleaseError } from './actions.mjs';

/** `key: value  # comment` at column 0, the value plain or quoted. */
function topLevelLine(key) {
	return new RegExp(`^${key}:[ \\t]*(?:"([^"]*)"|'([^']*)'|([^\\s#'"][^#]*?))?[ \\t]*(#.*)?\\r?$`, 'gm');
}

/** The value of a top-level scalar, or undefined; throws if the key appears twice. */
export function topLevelScalar(text, key) {
	const matches = [...text.matchAll(topLevelLine(key))];
	if (matches.length > 1) throw new ReleaseError(`manifest.yaml: "${key}" appears more than once`);
	const m = matches[0];
	return m ? (m[1] ?? m[2] ?? m[3]) : undefined;
}

/**
 * The manifest with `version` set to `version` (the pipeline writes it from the tag, MANIFEST §2).
 * A comment after the value is kept.
 */
export function setVersion(text, version) {
	const matches = [...text.matchAll(topLevelLine('version'))];
	if (matches.length !== 1) {
		throw new ReleaseError(
			matches.length === 0
				? 'manifest.yaml has no top-level "version:" line for the pipeline to set'
				: 'manifest.yaml: "version" appears more than once',
		);
	}
	const comment = matches[0][4];
	const line = `version: ${version}${comment ? `  ${comment}` : ''}`;
	return text.replace(topLevelLine('version'), (all) => (all.endsWith('\r') ? `${line}\r` : line));
}

/**
 * Every script's `entrypoint` (MANIFEST §8), in block or flow style. A value this reader can't
 * see is still caught by the control plane's bundle check; one it sees but the bundle lacks
 * stops the release here.
 */
export function entrypoints(text) {
	const found = [];
	for (const m of text.matchAll(/(?:^|[\s{,])entrypoint:[ \t]*(?:"([^"]*)"|'([^']*)'|([^\s,}#]+))/gm)) {
		found.push(m[1] ?? m[2] ?? m[3]);
	}
	return found;
}

/**
 * Checks that the manifest describes this release: `kind: stack`, the derived name, and the
 * version when one is released (PROTOCOL §6.5: they must equal the artifact reference).
 */
export function checkIdentity(text, { name, version }) {
	const kind = topLevelScalar(text, 'kind');
	if (kind !== 'stack') throw new ReleaseError(`manifest.yaml: kind is "${kind ?? ''}", expected "stack"`);
	const declared = topLevelScalar(text, 'name');
	if (declared !== name) {
		throw new ReleaseError(
			`manifest.yaml: name is "${declared ?? ''}", but this repository releases "${name}"`,
		);
	}
	if (version !== null && topLevelScalar(text, 'version') !== String(version)) {
		throw new ReleaseError(`manifest.yaml: version isn't ${version}`);
	}
}
