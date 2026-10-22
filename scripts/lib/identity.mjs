// What a workflow run releases, worked out from the repository and the ref alone, never from an
// input (architecture §8): the registration a release belongs to (CONTROL-PLANE §7) and its
// version (PROTOCOL §6.2).

import { ReleaseError } from './actions.mjs';

/** Stack and module names (MANIFEST §2, the schema's `name`). */
export const NAME = /^[a-z][a-z0-9-]{1,30}$/;
/** Paths of the platform, which no module can take (the schema), and the platform stacks. */
const RESERVED = new Set(['admin', 'api', 'agent', 'auth', 'well-known', 'static', 'zutun', 'host', 'ingress']);

/** The architectures every release supports (MANIFEST §10, PROTOCOL §6.2). */
export const ARCHES = ['amd64', 'arm64'];

/**
 * The platform's own repositories and what they release through core.yml (CONTROL-PLANE §7).
 * These names are the software's own, the same in every deployment (CONTROL-PLANE §9).
 */
const CORE_REPOS = {
	agent: { kind: 'agent', name: 'agent' },
	caddy: { kind: 'stack', name: 'ingress' },
	host: { kind: 'stack', name: 'host' },
};

/**
 * Modules released to staging only, never signed with a release key (architecture §9): the
 * reference module `example` carries demo and anti-pattern scripts that must never reach a
 * production server. Software's own, like CORE_REPOS.
 */
const STAGING_ONLY = new Set(['example']);

/**
 * The release target of `<owner>/<repo>` under a workflow:
 * - module.yml: `module-<name>` releases the stack `<name>`;
 * - core.yml: `agent`, `caddy` (the stack `ingress`) and `host`.
 * `imageBase` names the repo's images (README, "Image layout"): the repo's name without
 * `module-`, so `module-mail` pushes `mail` and `caddy` pushes `caddy`. `production` is false
 * for a module that is released to staging only.
 */
export function releaseTarget(repository, workflow) {
	const match = /^([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)$/.exec(repository ?? '');
	if (!match) throw new ReleaseError(`unexpected repository "${repository}"`);
	const [, owner, repo] = match;
	if (workflow === 'module') {
		const name = /^module-(.+)$/.exec(repo)?.[1];
		if (!name) {
			throw new ReleaseError(
				`module.yml releases repositories named module-<name>; ${repository} isn't one`,
			);
		}
		if (!NAME.test(name)) {
			throw new ReleaseError(`"${name}" isn't a module name: ^[a-z][a-z0-9-]{1,30}$ (MANIFEST §2)`);
		}
		if (RESERVED.has(name)) {
			throw new ReleaseError(`"${name}" is reserved for the platform and can't be a module name`);
		}
		return { owner, kind: 'stack', name, imageBase: name, production: !STAGING_ONLY.has(name) };
	}
	if (workflow === 'core') {
		const core = CORE_REPOS[repo];
		if (!core) {
			throw new ReleaseError(
				`core.yml releases the repositories ${Object.keys(CORE_REPOS).join(', ')}; ${repository} isn't one of them`,
			);
		}
		return { owner, ...core, imageBase: repo, production: true };
	}
	throw new ReleaseError(`unknown workflow "${workflow}" (module or core)`);
}

/**
 * The version a ref releases: `refs/tags/v<N>` → N, a positive integer without leading zeros
 * (the control plane compares the token's ref with `refs/tags/v<version>` exactly). Any other ref
 * builds and checks without releasing: null. A tag starting with `v` that isn't `v<N>` is a
 * mistake worth stopping for.
 */
export function versionFromRef(ref) {
	const tag = /^refs\/tags\/(.*)$/.exec(ref ?? '')?.[1];
	if (tag === undefined || !tag.startsWith('v')) return null;
	const digits = /^v([1-9][0-9]{0,15})$/.exec(tag)?.[1];
	const version = digits === undefined ? NaN : Number(digits);
	if (!Number.isSafeInteger(version)) {
		throw new ReleaseError(
			`tag "${tag}" isn't a release tag: releases are tagged v<N>, N a whole number from 1 without leading zeros (v12, not v1.2.0 or v012)`,
		);
	}
	return version;
}

/** The artifact name of an agent build (PROTOCOL §6.2). */
export function agentArtifactName(arch) {
	return `zutun-agent-linux-${arch}`;
}
