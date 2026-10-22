#!/usr/bin/env node
// Fails, naming each one, when GitHub variables the job needs are empty:
//   node require-vars.mjs ZUTUN_CONTROL_PLANE_ORIGIN ZUTUN_KMS_RELEASE_MODULES …
// The job maps each variable into its environment under the same name. An unset variable is an
// empty string in a workflow, so without this check signing would fail somewhere less clear.

import { error } from './lib/actions.mjs';

const missing = process.argv.slice(2).filter((name) => !process.env[name]);
for (const name of missing) {
	error(`The GitHub organisation variable ${name} is not set. See docs/google-cloud-kms.md in the release repo for its value.`);
}
process.exit(missing.length ? 1 : 0);
