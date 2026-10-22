#!/usr/bin/env node
// Signs the release built earlier in this run with a Cloud KMS key and uploads it to a control
// plane (lib/publish.mjs). Configured by the environment only, never by arguments, so nothing
// ends up in a command line:
//   RELEASE_DIR            the downloaded build (release.json and the files it lists)
//   CONTROL_PLANE_ORIGIN   https://<host> of the admin app, the OIDC token's audience
//   KMS_KEY_VERSION        projects/…/cryptoKeys/<key>/cryptoKeyVersions/<n>
//   KEY_FAMILY             release-modules, release-core or staging: the key this workflow may use
//   GOOGLE_TOKEN           the federated token from google-github-actions/auth
//   GITHUB_SHA             the commit of this run (set by the runner)

import { ReleaseError, run, summary } from './lib/actions.mjs';
import { kmsClient } from './lib/kms.mjs';
import { githubTokens } from './lib/oidc.mjs';
import { publish } from './lib/publish.mjs';
import { checkOrigin } from './lib/upload.mjs';

run(async () => {
	const env = process.env;
	for (const name of ['RELEASE_DIR', 'CONTROL_PLANE_ORIGIN', 'KMS_KEY_VERSION', 'KEY_FAMILY', 'GOOGLE_TOKEN', 'GITHUB_SHA']) {
		if (!env[name]) throw new ReleaseError(`${name} is not set`);
	}
	const origin = checkOrigin(env.CONTROL_PLANE_ORIGIN);
	const refs = await publish({
		dir: env.RELEASE_DIR,
		commit: env.GITHUB_SHA,
		origin,
		kmsKeyVersion: env.KMS_KEY_VERSION,
		family: env.KEY_FAMILY,
		kms: kmsClient({ token: env.GOOGLE_TOKEN }),
		nextToken: githubTokens(origin),
	});
	summary(
		[
			`### Published to ${origin}`,
			'',
			'| name | version | key | sha256 |',
			'|---|---|---|---|',
			...refs.map((r) => `| \`${r.name}\` | ${r.version} | \`${r.key_id}\` | \`${r.sha256}\` |`),
			'',
		].join('\n'),
	);
});
