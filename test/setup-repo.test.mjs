// scripts/setup-repo.sh against a stand-in `gh` that records its calls: what it sets, and that a
// second run changes nothing it already set.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { repo, scratch } from './helpers.mjs';

/** A fake gh: answers the reads from env, logs every call (and stdin of --input -) to a file. */
function fakeGh(policies) {
	const dir = scratch({
		gh: `#!/bin/sh
log="$(dirname "$0")/calls"
printf '%s\\n' "$*" >> "$log"
case "$*" in
  *"--input -"*) cat >> "$log"; printf '\\n' >> "$log" ;;
esac
case "$*" in
  "api repos/acme/module-mail --jq .full_name") echo acme/module-mail ;;
  "api orgs/acme/teams/platform-core --jq .id") echo 42 ;;
  "api repos/acme/module-mail/environments/release/deployment-branch-policies --jq"*) printf '%s' "$FAKE_POLICIES" ;;
  "api repos/acme/module-mail/contents/.github/CODEOWNERS --jq .path") echo .github/CODEOWNERS ;;
  "api repos/acme/module-mail/contents/"*) exit 1 ;;
esac
`,
	});
	chmodSync(path.join(dir, 'gh'), 0o755);
	return {
		run: (args) =>
			spawnSync('sh', [path.join(repo, 'scripts/setup-repo.sh'), ...args], {
				encoding: 'utf8',
				env: { PATH: `${dir}:${process.env.PATH}`, FAKE_POLICIES: policies },
			}),
		calls: () => readFileSync(path.join(dir, 'calls'), 'utf8'),
	};
}

test('a new repo: teams, read-only workflow token, the release environment for v* tags', () => {
	const gh = fakeGh('');
	const r = gh.run(['acme/module-mail', '--partner-team', 'mail-team']);
	assert.equal(r.status, 0, r.stderr);
	const calls = gh.calls();
	assert.match(calls, /^api -X PUT orgs\/acme\/teams\/platform-core\/repos\/acme\/module-mail -f permission=maintain$/m);
	assert.match(calls, /^api -X PUT orgs\/acme\/teams\/mail-team\/repos\/acme\/module-mail -f permission=push$/m);
	assert.match(calls, /default_workflow_permissions=read -F can_approve_pull_request_reviews=false/);
	assert.match(calls, /^api -X PUT repos\/acme\/module-mail\/environments\/release --input -\n(.+)$/m);
	const body = JSON.parse(/environments\/release --input -\n(.+)$/m.exec(calls)[1]);
	assert.deepEqual(body, {
		wait_timer: 0,
		prevent_self_review: false,
		reviewers: [{ type: 'Team', id: 42 }],
		deployment_branch_policy: { protected_branches: false, custom_branch_policies: true },
	});
	assert.match(calls, /deployment-branch-policies -f name=v\* -f type=tag/);
	assert.match(r.stdout, /ok: \.github\/CODEOWNERS/);
	assert.match(r.stdout, /missing: \.github\/workflows\/release\.yml/);
});

test('run again: the v* tag rule stays, other rules go, nothing is added twice', () => {
	const gh = fakeGh('7 branch main\n8 tag v*\n9 tag release-*');
	const r = gh.run(['acme/module-mail', '--prevent-self-review']);
	assert.equal(r.status, 0, r.stderr);
	const calls = gh.calls();
	assert.match(calls, /-X DELETE repos\/acme\/module-mail\/environments\/release\/deployment-branch-policies\/7$/m);
	assert.match(calls, /-X DELETE .*deployment-branch-policies\/9$/m);
	assert.doesNotMatch(calls, /deployment-branch-policies\/8/);
	assert.doesNotMatch(calls, /-X POST/);
	assert.match(calls, /"prevent_self_review":true/);
});

test('usage errors', () => {
	const gh = fakeGh('');
	assert.equal(gh.run([]).status, 2);
	assert.equal(gh.run(['module-mail']).status, 2);
	assert.equal(gh.run(['acme/module-mail', '--partner-team']).status, 2);
	assert.equal(gh.run(['acme/module-mail', '--bogus']).status, 2);
});
