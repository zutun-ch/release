#!/usr/bin/env node
// Describes the agent builds in a directory as one release (PROTOCOL §6.2: the artifact name is
// zutun-agent-linux-<arch>, the version is the build number):
//   node agent-release.mjs --dir <dir> --version <N or empty>
// Expects <dir>/zutun-agent-linux-amd64 and -arm64 (build-agent.sh) and writes release.json.

import { parseArgs, run, summary } from './lib/actions.mjs';
import { agentArtifactName, ARCHES } from './lib/identity.mjs';
import { tagNotes } from './lib/notes.mjs';
import { summaryTable, writeRelease } from './lib/release.mjs';

run(async () => {
	const args = parseArgs(process.argv.slice(2), ['dir', 'version']);
	const version = args.version ? Number(args.version) : null;
	const release = writeRelease(args.dir, {
		commit: process.env.GITHUB_SHA,
		notes: version === null ? null : tagNotes(`v${version}`),
		artifacts: ARCHES.map((arch) => ({ kind: 'agent', name: agentArtifactName(arch), version, file: agentArtifactName(arch) })),
	});
	for (const a of release.artifacts) console.log(`${a.file}: ${a.size} bytes, sha256 ${a.sha256}`);
	summary(`### Agent builds\n\n${summaryTable(release)}\n`);
});
