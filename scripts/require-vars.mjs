#!/usr/bin/env node
// Fails, naming each one, when GitHub variables the job needs are empty or malformed:
//   node require-vars.mjs ZUTUN_CONTROL_PLANE_ORIGIN ZUTUN_KMS_RELEASE_MODULES …
// The job maps each variable into its environment under the same name. An unset variable is an
// empty string in a workflow, so without this check signing would fail somewhere less clear.

import { error } from './lib/actions.mjs';
import { checkVars } from './lib/vars.mjs';

const problems = checkVars(process.argv.slice(2), process.env);
for (const problem of problems) error(`${problem} See docs/google-cloud-kms.md in the release repo for its value.`);
process.exit(problems.length ? 1 : 0);
