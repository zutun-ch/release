#!/usr/bin/env node
// Stops the release unless every pushed image can be pulled without credentials:
//   node check-public.mjs --digests '<{"ghcr.io/owner/name": "sha256:…"}>'

import { parseArgs, run } from './lib/actions.mjs';
import { requirePublic } from './lib/registry.mjs';

run(async () => {
	const { digests } = parseArgs(process.argv.slice(2), ['digests']);
	const pushed = JSON.parse(digests);
	await requirePublic(pushed);
	for (const repository of Object.keys(pushed)) console.log(`${repository} is public`);
});
