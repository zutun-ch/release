#!/usr/bin/env node
// Describes the agent builds in a directory as one release (PROTOCOL §6.2: the artifact name is
// zutun-agent-linux-<arch>, the version is the build number):
//   node agent-release.mjs --dir <dir> --version <N or empty> --manifest-schema <file>
// Expects <dir>/zutun-agent-linux-amd64 and -arm64 (build-agent.sh), writes release.json and
// sets the step output release-sha256 (its sha256, which the publish jobs check). The manifest
// schema is the file the build compiles in (internal/manifest/manifest.v1.schema.json); its
// sha256 is the build's manifest reader (MANIFEST §2.2), recorded with both artifacts and sent
// with their upload (CONTROL-PLANE §7, step 1).

import { parseArgs, ReleaseError, run, setOutput, summary } from './lib/actions.mjs';
import { agentArtifactName, ARCHES } from './lib/identity.mjs';
import { tagNotes } from './lib/notes.mjs';
import { manifestReaderOf, releaseFileSha256, summaryTable, writeRelease } from './lib/release.mjs';

run(async () => {
	const args = parseArgs(process.argv.slice(2), ['dir', 'version', 'manifest-schema']);
	if (!args['manifest-schema']) throw new ReleaseError('usage: --manifest-schema <the manifest schema file the build embeds>');
	const version = args.version ? Number(args.version) : null;
	const reader = manifestReaderOf(args['manifest-schema']);
	const release = writeRelease(args.dir, {
		commit: process.env.GITHUB_SHA,
		notes: version === null ? null : tagNotes(`v${version}`),
		artifacts: ARCHES.map((arch) => ({ kind: 'agent', name: agentArtifactName(arch), version, file: agentArtifactName(arch), manifest_reader: reader })),
	});
	for (const a of release.artifacts) console.log(`${a.file}: ${a.size} bytes, sha256 ${a.sha256}`);
	console.log(`manifest reader ${reader} (sha256 of ${args['manifest-schema']})`);
	setOutput('release-sha256', releaseFileSha256(args.dir));
	summary(`### Agent builds\n\n${summaryTable(release, ['', `Manifest reader \`${reader}\` (MANIFEST §2.2)`])}\n`);
});
