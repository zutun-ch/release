#!/usr/bin/env node
// Packs the stack bundle of the repo in the working directory:
//   node stack-bundle.mjs --name <stack> --version <N or empty> --digests '<JSON>' --out <dir>
// For a release it writes the version into manifest.yaml and pins the pushed digests into
// compose.yaml, in the bundle only (the checkout is never edited); otherwise it checks that the
// placeholders match the images. It writes <dir>/<name>.tar.gz and <dir>/release.json, and sets
// the step outputs sha256 and size.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs, run, setOutput, summary } from './lib/actions.mjs';
import { packBundle } from './lib/bundle.mjs';
import { pinDigests } from './lib/compose.mjs';
import { setVersion } from './lib/manifest.mjs';
import { tagNotes } from './lib/notes.mjs';
import { summaryTable, writeRelease } from './lib/release.mjs';

run(async () => {
	const args = parseArgs(process.argv.slice(2), ['name', 'version', 'digests', 'out']);
	const version = args.version ? Number(args.version) : null;
	const digests = JSON.parse(args.digests || '{}');

	const overrides = {};
	if (version !== null && existsSync('manifest.yaml')) {
		overrides['manifest.yaml'] = setVersion(readFileSync('manifest.yaml', 'utf8'), version);
	}
	const compose = existsSync('compose.yaml') ? readFileSync('compose.yaml', 'utf8') : '';
	const pinned = pinDigests(compose, digests);
	if (existsSync('compose.yaml')) overrides['compose.yaml'] = pinned;

	const bundle = packBundle('.', { name: args.name, version, overrides });
	mkdirSync(args.out, { recursive: true });
	const file = `${args.name}.tar.gz`;
	writeFileSync(path.join(args.out, file), bundle.bytes);
	const release = writeRelease(args.out, {
		commit: process.env.GITHUB_SHA,
		notes: version === null ? null : tagNotes(`v${version}`),
		artifacts: [{ kind: 'stack', name: args.name, version, file }],
	});

	console.log(`${file}: ${bundle.size} bytes, sha256 ${bundle.sha256}`);
	for (const entry of bundle.entries) console.log(`  ${entry}`);
	setOutput('sha256', bundle.sha256);
	setOutput('size', String(bundle.size));
	const images = Object.entries(digests)
		.filter(([, d]) => d)
		.map(([repo, d]) => `- \`${repo}@${d}\``);
	summary(`### Stack bundle\n\n${summaryTable(release, images.length ? ['', 'Images:', ...images] : [])}\n`);
});
