// The shapes of the organisation variables the workflows read (docs/google-cloud-kms.md, step 8).
// A value that is set but malformed (an origin with a path, a provider name whose project number
// was an empty shell variable) would otherwise fail only at signing or upload, with Google's or
// the control plane's error instead of one that names the variable.

const ORIGIN = /^https:\/\/[A-Za-z0-9.-]+(:\d+)?$/;
const PROVIDER = /^projects\/\d+\/locations\/global\/workloadIdentityPools\/[a-z0-9-]+\/providers\/[a-z0-9-]+$/;
const KEY_VERSION =
	/^projects\/[a-z][a-z0-9-]+\/locations\/[a-z0-9-]+\/keyRings\/[A-Za-z0-9_-]+\/cryptoKeys\/[A-Za-z0-9_-]+\/cryptoKeyVersions\/\d+$/;

const origin = { pattern: ORIGIN, expected: 'https://<host>, without a path or a trailing slash' };
const provider = {
	pattern: PROVIDER,
	expected: 'projects/<project number>/locations/global/workloadIdentityPools/<pool>/providers/<provider>',
};
const keyVersion = {
	pattern: KEY_VERSION,
	expected: 'projects/<project id>/locations/<location>/keyRings/<ring>/cryptoKeys/<key>/cryptoKeyVersions/<n>',
};

const SHAPES = {
	ZUTUN_CONTROL_PLANE_ORIGIN: origin,
	ZUTUN_STAGING_CONTROL_PLANE_ORIGIN: origin,
	ZUTUN_WORKLOAD_IDENTITY_PROVIDER: provider,
	ZUTUN_STAGING_WORKLOAD_IDENTITY_PROVIDER: provider,
	ZUTUN_KMS_RELEASE_CORE: keyVersion,
	ZUTUN_KMS_RELEASE_MODULES: keyVersion,
	ZUTUN_KMS_STAGING: keyVersion,
};

/**
 * What is wrong with the variables `names` in `env`: one message per missing or malformed one.
 * A name without a known shape is only required to be set.
 */
export function checkVars(names, env) {
	const problems = [];
	for (const name of names) {
		const value = env[name];
		if (!value) {
			problems.push(`The GitHub organisation variable ${name} is not set.`);
			continue;
		}
		const shape = SHAPES[name];
		if (shape && !shape.pattern.test(value)) {
			problems.push(`The GitHub organisation variable ${name} is "${value}", expected ${shape.expected}.`);
		}
	}
	return problems;
}
