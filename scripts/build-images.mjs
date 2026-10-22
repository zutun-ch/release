#!/usr/bin/env node
// Builds each image of the plan for linux/amd64 and linux/arm64 with docker buildx, and pushes it
// for a release:
//   node build-images.mjs --images '<plan JSON>' --version <N or empty>
// With a version the images are pushed, tagged v<N>, and the step output `digests` maps each
// repository to its pushed index digest. Without one (pushes to main) they are only built, and
// `digests` maps each repository to null, which pin-digests treats as "check only".

import { mkdtempSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs, ReleaseError, run, setOutput } from './lib/actions.mjs';

export const PLATFORMS = 'linux/amd64,linux/arm64';

/** The docker arguments for one image. Labels link the package to its repo on GitHub. */
export function buildArgs(image, { version, source, revision, metadataFile }) {
	const push = Boolean(version);
	const args = ['buildx', 'build', '--pull', '--platform', PLATFORMS, '--file', `${image.context}/Dockerfile`];
	args.push('--label', `org.opencontainers.image.source=${source}`);
	args.push('--label', `org.opencontainers.image.revision=${revision}`);
	if (push) {
		args.push('--annotation', `index:org.opencontainers.image.source=${source}`);
		args.push('--tag', `${image.repository}:v${version}`, '--push', '--metadata-file', metadataFile);
	}
	args.push(image.context);
	return args;
}

/** The pushed index digest from buildx's metadata file. */
export function digestFrom(metadata) {
	const digest = metadata['containerimage.digest'];
	if (!/^sha256:[0-9a-f]{64}$/.test(digest ?? '')) throw new ReleaseError('buildx reported no image digest');
	return digest;
}

// Run as a script; imported by the tests for buildArgs and digestFrom.
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
	run(async () => {
		const args = parseArgs(process.argv.slice(2), ['images', 'version']);
		const images = JSON.parse(args.images);
		const { GITHUB_SERVER_URL, GITHUB_REPOSITORY, GITHUB_SHA } = process.env;
		const temp = mkdtempSync(path.join(process.env.RUNNER_TEMP ?? tmpdir(), 'images-'));
		const digests = {};
		for (const image of images) {
			const metadataFile = path.join(temp, `${image.name}.json`);
			const docker = buildArgs(image, {
				version: args.version,
				source: `${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}`,
				revision: GITHUB_SHA,
				metadataFile,
			});
			console.log(`docker ${docker.join(' ')}`);
			const result = spawnSync('docker', docker, { stdio: 'inherit' });
			if (result.status !== 0) throw new ReleaseError(`building ${image.repository} from ${image.context}/ failed`);
			digests[image.repository] = args.version ? digestFrom(JSON.parse(readFileSync(metadataFile, 'utf8'))) : null;
			if (digests[image.repository]) console.log(`pushed ${image.repository}@${digests[image.repository]}`);
		}
		setOutput('digests', JSON.stringify(digests));
	});
}
