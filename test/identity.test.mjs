// The release target from the repository (never an input) and the version from the tag.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ReleaseError } from '../scripts/lib/actions.mjs';
import { agentArtifactName, releaseTarget, versionFromRef } from '../scripts/lib/identity.mjs';

test('module.yml: module-<name> releases the stack <name>, images named after it', () => {
	assert.deepEqual(releaseTarget('zutun-ch/module-mail', 'module'), {
		owner: 'zutun-ch',
		kind: 'stack',
		name: 'mail',
		imageBase: 'mail',
		production: true,
	});
	assert.equal(releaseTarget('acme/module-cloud-files', 'module').name, 'cloud-files');
});

test('module.yml: the reference module example goes to staging only (architecture §9)', () => {
	assert.deepEqual(releaseTarget('zutun-ch/module-example', 'module'), {
		owner: 'zutun-ch',
		kind: 'stack',
		name: 'example',
		imageBase: 'example',
		production: false,
	});
});

test('module.yml refuses repos that are not module-<name>, bad names and reserved names', () => {
	for (const repo of ['zutun-ch/example', 'zutun-ch/ingress', 'zutun-ch/module-', 'zutun-ch/module-x', 'zutun-ch/module-Mail',
		'zutun-ch/module-1st', 'zutun-ch/module-host', 'zutun-ch/module-ingress', 'zutun-ch/module-agent',
		'zutun-ch/module-admin', 'zutun-ch/module-well-known', `zutun-ch/module-${'a'.repeat(32)}`]) {
		assert.throws(() => releaseTarget(repo, 'module'), ReleaseError, repo);
	}
});

test('core.yml: agent, host and ingress, nothing else', () => {
	assert.deepEqual(releaseTarget('zutun-ch/agent', 'core'), { owner: 'zutun-ch', kind: 'agent', name: 'agent', imageBase: 'agent', production: true });
	assert.deepEqual(releaseTarget('zutun-ch/host', 'core'), { owner: 'zutun-ch', kind: 'stack', name: 'host', imageBase: 'host', production: true });
	assert.deepEqual(releaseTarget('zutun-ch/ingress', 'core'), { owner: 'zutun-ch', kind: 'stack', name: 'ingress', imageBase: 'ingress', production: true });
	for (const repo of ['zutun-ch/module-mail', 'zutun-ch/module-ingress', 'zutun-ch/platform', 'zutun-ch/release']) {
		assert.throws(() => releaseTarget(repo, 'core'), ReleaseError, repo);
	}
});

test("core.yml: the ingress stack's former repo name caddy releases nothing (review rev 30)", () => {
	assert.throws(() => releaseTarget('zutun-ch/caddy', 'core'), /core.yml releases the repositories agent, host, ingress; zutun-ch\/caddy isn't one of them/);
});

test('an unknown workflow or a malformed repository is refused', () => {
	assert.throws(() => releaseTarget('zutun-ch/module-mail', 'staging'), ReleaseError);
	assert.throws(() => releaseTarget('module-mail', 'module'), ReleaseError);
	assert.throws(() => releaseTarget(undefined, 'module'), ReleaseError);
});

test('version: refs/tags/v<N> releases N', () => {
	assert.equal(versionFromRef('refs/tags/v1'), 1);
	assert.equal(versionFromRef('refs/tags/v12'), 12);
	assert.equal(versionFromRef('refs/tags/v9007199254740991'), Number.MAX_SAFE_INTEGER);
});

test('version: branches, pull requests and other tags build and check only', () => {
	for (const ref of ['refs/heads/main', 'refs/heads/v12', 'refs/pull/3/merge', 'refs/tags/release-3', '', undefined]) {
		assert.equal(versionFromRef(ref), null, String(ref));
	}
});

test('version: a v tag that is not v<N> stops the run', () => {
	for (const tag of ['v0', 'v012', 'v1.2.0', 'v12-rc1', 'v', 'v-1', 'v9007199254740992', 'v99999999999999999']) {
		assert.throws(() => versionFromRef(`refs/tags/${tag}`), ReleaseError, tag);
	}
});

test('agent artifact names', () => {
	assert.equal(agentArtifactName('arm64'), 'zutun-agent-linux-arm64');
});
