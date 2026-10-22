#!/bin/sh
# Applies the repo-level GitHub settings a release repo needs (docs/github-setup.md), and checks
# the parts that live in the repo itself. Safe to run again: it sets the same state each time.
#
#   scripts/setup-repo.sh <owner>/<repo> [--partner-team <slug>] [--core-team <slug>]
#                         [--prevent-self-review]
#
# It needs the GitHub CLI, signed in as an organisation owner (gh auth login), and:
# - gives the core team (default platform-core) maintain access, and a partner team write access;
# - sets the default GITHUB_TOKEN of workflows to read-only, unable to approve pull requests;
# - creates or updates the environment "release": the core team as required reviewers,
#   deployments from v* tags only, and "prevent self-review" when asked (once two people can
#   approve);
# - reports whether CODEOWNERS and the release caller workflow are in place.
# The organisation-level parts (rulesets, package settings, variables) are in the guide.
set -eu

usage() {
	echo "usage: $0 <owner>/<repo> [--partner-team <slug>] [--core-team <slug>] [--prevent-self-review]" >&2
	exit 2
}

[ $# -ge 1 ] || usage
repo=$1
shift
case $repo in
*/*) ;;
*) usage ;;
esac
owner=${repo%%/*}
core_team=platform-core
partner_team=
prevent_self_review=false
while [ $# -gt 0 ]; do
	case $1 in
	--partner-team) [ $# -ge 2 ] || usage; partner_team=$2; shift 2 ;;
	--core-team) [ $# -ge 2 ] || usage; core_team=$2; shift 2 ;;
	--prevent-self-review) prevent_self_review=true; shift ;;
	*) usage ;;
	esac
done

say() { printf '%s\n' "$*"; }

gh api "repos/$repo" --jq .full_name >/dev/null || { say "can't read $repo: does it exist, and is gh signed in as an owner?" >&2; exit 1; }

# Teams.
team_id=$(gh api "orgs/$owner/teams/$core_team" --jq .id)
gh api -X PUT "orgs/$owner/teams/$core_team/repos/$repo" -f permission=maintain >/dev/null
say "team $core_team: maintain"
if [ -n "$partner_team" ]; then
	gh api -X PUT "orgs/$owner/teams/$partner_team/repos/$repo" -f permission=push >/dev/null
	say "team $partner_team: write"
fi

# Workflows get a read-only token unless a job asks for more.
gh api -X PUT "repos/$repo/actions/permissions/workflow" \
	-f default_workflow_permissions=read -F can_approve_pull_request_reviews=false >/dev/null
say "workflow token: read-only by default"

# The release environment: required reviewers, v* tags only.
printf '{"wait_timer":0,"prevent_self_review":%s,"reviewers":[{"type":"Team","id":%s}],"deployment_branch_policy":{"protected_branches":false,"custom_branch_policies":true}}' \
	"$prevent_self_review" "$team_id" |
	gh api -X PUT "repos/$repo/environments/release" --input - >/dev/null
policies=$(gh api "repos/$repo/environments/release/deployment-branch-policies" \
	--jq '.branch_policies[] | "\(.id) \(.type // "branch") \(.name)"')
printf '%s\n' "$policies" | while read -r id type name; do
	[ -n "$id" ] || continue
	if [ "$type" = tag ] && [ "$name" = 'v*' ]; then continue; fi
	gh api -X DELETE "repos/$repo/environments/release/deployment-branch-policies/$id" >/dev/null
	say "environment release: removed the $type rule $name"
done
case $policies in
*' tag v*'*) ;;
*)
	gh api -X POST "repos/$repo/environments/release/deployment-branch-policies" -f name='v*' -f type=tag >/dev/null
	;;
esac
say "environment release: reviewers $core_team, v* tags only, prevent self-review $prevent_self_review"

# What lives in the repo itself: reported, not written (main takes changes through pull requests).
check_file() {
	if gh api "repos/$repo/contents/$1" --jq .path >/dev/null 2>&1; then
		say "ok: $1"
	else
		say "missing: $1 ($2)"
	fi
}
check_file .github/CODEOWNERS 'see docs/github-setup.md, "CODEOWNERS"'
check_file .github/workflows/release.yml 'the caller of the release workflow, see the release README'
