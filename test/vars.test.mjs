// The organisation variables are checked for their shape before anything is signed.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkVars } from '../scripts/lib/vars.mjs';

const GOOD = {
	ZUTUN_CONTROL_PLANE_ORIGIN: 'https://admin.example.test',
	ZUTUN_WORKLOAD_IDENTITY_PROVIDER: 'projects/123456789/locations/global/workloadIdentityPools/github-release/providers/github',
	ZUTUN_KMS_RELEASE_CORE: 'projects/example-signing/locations/europe-west6/keyRings/zutun-release/cryptoKeys/release-core/cryptoKeyVersions/1',
};

test('well-formed variables pass', () => {
	assert.deepEqual(checkVars(Object.keys(GOOD), GOOD), []);
});

test('a provider whose project number was an empty shell variable is refused, naming the variable', () => {
	const env = { ...GOOD, ZUTUN_WORKLOAD_IDENTITY_PROVIDER: 'projects//locations/global/workloadIdentityPools/github-release/providers/github' };
	const [problem] = checkVars(['ZUTUN_WORKLOAD_IDENTITY_PROVIDER'], env);
	assert.match(problem, /ZUTUN_WORKLOAD_IDENTITY_PROVIDER is "projects\/\/locations/);
	assert.match(problem, /<project number>/);
});

test('an origin with a trailing slash or a path, and a key without its version, are refused', () => {
	assert.equal(checkVars(['ZUTUN_CONTROL_PLANE_ORIGIN'], { ZUTUN_CONTROL_PLANE_ORIGIN: 'https://admin.example.test/' }).length, 1);
	assert.equal(checkVars(['ZUTUN_CONTROL_PLANE_ORIGIN'], { ZUTUN_CONTROL_PLANE_ORIGIN: 'http://admin.example.test' }).length, 1);
	const key = GOOD.ZUTUN_KMS_RELEASE_CORE.replace(/\/cryptoKeyVersions\/1$/, '');
	assert.equal(checkVars(['ZUTUN_KMS_RELEASE_CORE'], { ZUTUN_KMS_RELEASE_CORE: key }).length, 1);
});

test('a missing variable is named; one without a known shape only has to be set', () => {
	assert.deepEqual(checkVars(['ZUTUN_KMS_RELEASE_MODULES'], {}), ['The GitHub organisation variable ZUTUN_KMS_RELEASE_MODULES is not set.']);
	assert.deepEqual(checkVars(['SOMETHING_ELSE'], { SOMETHING_ELSE: 'x' }), []);
});
