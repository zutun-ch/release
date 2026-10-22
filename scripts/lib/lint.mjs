// The agent whose `zutun-agent lint` checks a stack bundle (architecture §8, step 3). The check
// only means something if every release is held to the same rules: an older agent's lint
// predates the compose rules added since, so a caller that pinned one would pass a bundle the
// current rules refuse (review rev 22, B-74). The pin therefore belongs to this repo, and a
// release refuses any other.

import { ReleaseError } from './actions.mjs';

/**
 * The agent commit every release is linted with: the `agent-commit` default of module.yml and
 * core.yml, which a test keeps equal to this. Raise all three together when an agent release
 * changes `zutun-agent lint` (README, "The agent commit for lint").
 */
export const AGENT_COMMIT = 'f0a1db1d7e63ee8670a36262001628a65503bca9';

/**
 * Checks the `agent-commit` a run was called with. A release (a v<N> tag, which signs and
 * uploads) takes the pinned commit only. A build-and-check run may try another agent's lint,
 * say a newer one before the pin is raised, and is told it couldn't release that way.
 * Returns a notice for such a run, or null.
 */
export function checkAgentCommit(commit, release) {
	if (commit === AGENT_COMMIT) return null;
	if (release) {
		throw new ReleaseError(
			`agent-commit is "${commit ?? ''}", but a release is linted by the agent this workflow pins (${AGENT_COMMIT}), so that every release is held to the same compose rules. Remove agent-commit from the caller's release.yml.`,
		);
	}
	return `lint uses the agent at ${commit}, not the pinned ${AGENT_COMMIT}: fine for a check, but a release would refuse it`;
}
