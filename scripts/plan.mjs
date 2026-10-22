#!/usr/bin/env node
// What this run releases, from the repository, the ref and the repo's layout only:
//   node plan.mjs --workflow module|core
// Step outputs: kind, name, version (empty unless the ref is a v<N> tag), publish
// ("true" for a v<N> tag), images (JSON: [{ name, context, repository }]).

import { notice, parseArgs, run, setOutput } from './lib/actions.mjs';
import { releaseTarget, versionFromRef } from './lib/identity.mjs';
import { findImages, imageRepository } from './lib/layout.mjs';

run(async () => {
	const { workflow } = parseArgs(process.argv.slice(2), ['workflow']);
	const target = releaseTarget(process.env.GITHUB_REPOSITORY, workflow);
	const version = versionFromRef(process.env.GITHUB_REF);
	const images =
		target.kind === 'stack'
			? findImages(process.cwd(), target.imageBase).map((i) => ({ ...i, repository: imageRepository(target.owner, i.name) }))
			: [];

	setOutput('kind', target.kind);
	setOutput('name', target.name);
	setOutput('version', version === null ? '' : String(version));
	setOutput('publish', String(version !== null));
	setOutput('images', JSON.stringify(images));
	notice(
		version === null
			? `${target.kind} ${target.name}: build and check only (not a v<N> tag)`
			: `${target.kind} ${target.name} v${version}: build, sign and upload`,
	);
	for (const i of images) console.log(`image ${i.repository} from ${i.context}/Dockerfile`);
});
