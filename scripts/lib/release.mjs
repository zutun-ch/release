// release.json: what a run built, handed from the build jobs to the publish jobs as a workflow
// artifact next to the files it describes. The publish jobs recompute every file's sha256 and
// size before they sign, so they sign the bytes that were built, nothing that changed on the way.
// The build job also reports release.json's own sha256 as a job output, which no other job can
// change: any job of the caller's workflow can upload a workflow artifact (and replace one), so
// the artifact alone doesn't prove which job wrote it.
//
//   { "commit": "<40 hex>", "notes": "…",
//     "artifacts": [{ "kind": "stack", "name": "mail", "version": 12, "file": "mail.tar.gz",
//                     "sha256": "<hex>", "size": 1234 }] }
//
// An agent artifact also carries "manifest_reader": the sha256 of the manifest schema the build
// embeds (MANIFEST §2.2), which the upload sends with it (CONTROL-PLANE §7, step 1). A stack
// artifact never does.

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ReleaseError } from './actions.mjs';
import { MAX_SIZE } from './artifact.mjs';

export const RELEASE_FILE = 'release.json';
const COMMIT = /^[0-9a-f]{40}$/;
const FILE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const READER = /^[0-9a-f]{64}$/;

/** The manifest reader of an agent artifact, required; a stack artifact has none. */
function checkReader(a, where) {
	if (a.kind === 'agent' && !READER.test(a.manifest_reader ?? '')) {
		throw new ReleaseError(`${where}: the agent build ${a.file} has no manifest reader (the sha256 of the schema it embeds, MANIFEST §2.2), "${a.manifest_reader ?? ''}"`);
	}
	if (a.kind !== 'agent' && a.manifest_reader !== undefined) {
		throw new ReleaseError(`${where}: ${a.file} is a ${a.kind}, and only an agent build has a manifest reader`);
	}
}

export function sha256(bytes) {
	return createHash('sha256').update(bytes).digest('hex');
}

/**
 * The manifest reader of an agent build: the sha256 of the schema file it compiles in
 * (`internal/manifest/manifest.v1.schema.json` of the agent's checkout, MANIFEST §2.2).
 */
export function manifestReaderOf(file) {
	let bytes;
	try {
		bytes = readFileSync(file);
	} catch (err) {
		throw new ReleaseError(`can't read ${file}, the manifest schema the agent build embeds (MANIFEST §2.2): ${err.code ?? err.message}`);
	}
	if (bytes.length === 0) throw new ReleaseError(`${file}, the manifest schema the agent build embeds, is empty`);
	return sha256(bytes);
}

/**
 * Describes `files` (in `dir`) as artifacts of one release and writes release.json. An agent
 * artifact names its build's `manifest_reader`.
 */
export function writeRelease(dir, { commit, notes, artifacts }) {
	const described = artifacts.map(({ kind, name, version, file, manifest_reader }) => {
		checkReader({ kind, file, manifest_reader }, 'writing release.json');
		const bytes = readFileSync(path.join(dir, file));
		if (bytes.length > MAX_SIZE[kind]) {
			throw new ReleaseError(`${file} is ${bytes.length} bytes; a ${kind} artifact may be at most ${MAX_SIZE[kind]}`);
		}
		return { kind, name, version, file, sha256: sha256(bytes), size: bytes.length, ...(kind === 'agent' ? { manifest_reader } : {}) };
	});
	const release = { commit, notes: notes || null, artifacts: described };
	writeFileSync(path.join(dir, RELEASE_FILE), `${JSON.stringify(release, null, 2)}\n`);
	return release;
}

/** The sha256 of release.json in `dir`, which the build job reports as its output. */
export function releaseFileSha256(dir) {
	return sha256(readFileSync(path.join(dir, RELEASE_FILE)));
}

/**
 * Reads release.json from `dir` and checks that it is the file the build job reported (`sha256`),
 * that it describes a release of `commit`, and that every file still has the sha256 and size
 * recorded. Returns the release with each artifact's bytes.
 */
export function readRelease(dir, { commit, sha256: expected }) {
	if (!/^[0-9a-f]{64}$/.test(expected ?? '')) {
		throw new ReleaseError(`the build job reported no sha256 of ${RELEASE_FILE} ("${expected ?? ''}")`);
	}
	let release;
	try {
		const bytes = readFileSync(path.join(dir, RELEASE_FILE));
		if (sha256(bytes) !== expected) {
			throw new ReleaseError(
				`${RELEASE_FILE} isn't the one the build job of this run wrote (sha256 ${sha256(bytes)}, reported ${expected}); nothing is signed`,
			);
		}
		release = JSON.parse(bytes.toString('utf8'));
	} catch (err) {
		if (err instanceof ReleaseError) throw err;
		throw new ReleaseError(`can't read ${RELEASE_FILE} from the build job: ${err.message}`);
	}
	if (!COMMIT.test(release.commit ?? '') || release.commit !== commit) {
		throw new ReleaseError(`${RELEASE_FILE} describes commit ${release.commit}, but this run is ${commit}`);
	}
	if (!Array.isArray(release.artifacts) || release.artifacts.length === 0) {
		throw new ReleaseError(`${RELEASE_FILE} lists no artifacts`);
	}
	const artifacts = release.artifacts.map((a) => {
		if (!FILE.test(a.file ?? '') || !Number.isSafeInteger(a.version) || a.version < 1) {
			throw new ReleaseError(`${RELEASE_FILE}: malformed artifact ${JSON.stringify(a)}`);
		}
		checkReader(a, RELEASE_FILE);
		const bytes = readFileSync(path.join(dir, a.file));
		if (bytes.length !== a.size || sha256(bytes) !== a.sha256) {
			throw new ReleaseError(`${a.file} isn't the file the build job described (size or sha256 differ)`);
		}
		return { ...a, bytes };
	});
	return { commit: release.commit, notes: release.notes ?? null, artifacts };
}

/** The job summary table of a release: what was signed and uploaded, on the run page. */
export function summaryTable(release, extra = []) {
	const rows = release.artifacts.map(
		(a) => `| ${a.kind} | \`${a.name}\` | ${a.version ?? '–'} | \`${a.sha256}\` | ${a.size} |`,
	);
	return [
		'| kind | name | version | sha256 | size |',
		'|---|---|---|---|---|',
		...rows,
		'',
		`Commit \`${release.commit}\``,
		...extra,
	].join('\n');
}
