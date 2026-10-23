// Whether a release tag points at reviewed code. Only the core team can create a v<N> tag (the
// organisation's tag ruleset), but nothing in GitHub stops one on a commit of an unreviewed
// branch, and whoever creates it sees only the tag. So a release must be a commit on main,
// which takes changes only through reviewed pull requests (architecture §8, "Repos and review").

import { spawnSync } from 'node:child_process';
import { ReleaseError } from './actions.mjs';

/** The main branch as actions/checkout leaves it with fetch-depth: 0. */
export const MAIN = 'refs/remotes/origin/main';
const COMMIT = /^[0-9a-f]{40}$/;

/** Throws unless `commit` is on main in the repo checked out at `cwd`. */
export function requireOnMain(commit, cwd = process.cwd()) {
	const git = (...args) => spawnSync('git', args, { cwd, encoding: 'utf8' });
	if (!COMMIT.test(commit ?? '')) throw new ReleaseError(`"${commit}" isn't a commit id`);
	if (git('rev-parse', '--verify', '--quiet', `${MAIN}^{commit}`).status !== 0) {
		throw new ReleaseError("origin/main isn't in the checkout; the plan job checks the repository out with fetch-depth: 0");
	}
	const ancestor = git('merge-base', '--is-ancestor', commit, MAIN);
	if (ancestor.status === 1) {
		throw new ReleaseError(
			`the release tag points at ${commit}, which isn't on main. Releases are commits on main, which only takes reviewed changes: merge first, then tag the merged commit on main with a new version (release tags can't be moved or deleted, so this version stays unused).`,
		);
	}
	if (ancestor.status !== 0) {
		throw new ReleaseError(`git can't tell whether ${commit} is on main: ${(ancestor.stderr || ancestor.error?.message || '').trim()}`);
	}
}
