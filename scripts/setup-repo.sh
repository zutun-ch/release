#!/bin/sh
# Applies the repo-level GitHub settings a release repo needs (docs/github-setup.md), and checks
# the parts that live in the repo itself. Safe to run again: it sets the same state each time.
#
#   scripts/setup-repo.sh <owner>/<repo> [--partner-team <slug>] [--core-team <slug>]
#                         [--required-reviewers [--prevent-self-review]]
#
# It needs the GitHub CLI, signed in as an organisation owner (gh auth login), and:
# - refuses to change anything unless the organisation's tag ruleset lets only the core team
#   (default platform-core) create v* tags and nobody move or delete one: creating the tag is
#   the approval of a release;
# - gives the core team maintain access, and a partner team write access;
# - sets the default GITHUB_TOKEN of workflows to read-only, unable to approve pull requests;
# - creates or updates the environment "release": deployments from v* tags only and, when asked,
#   the core team as required reviewers on top, with "prevent self-review" once two people can
#   approve (GitHub offers required reviewers for public repos, and for private ones on
#   Enterprise only);
# - refuses ZUTUN_* variables of the repo or its release environment, which would override the
#   organisation's (another control plane, another key) for this repo's releases;
# - reports whether CODEOWNERS and the release caller workflow are in place.
# The organisation-level parts (rulesets, package settings, variables) are in the guide.
set -eu

usage() {
	echo "usage: $0 <owner>/<repo> [--partner-team <slug>] [--core-team <slug>] [--required-reviewers [--prevent-self-review]]" >&2
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
required_reviewers=false
prevent_self_review=false
while [ $# -gt 0 ]; do
	case $1 in
	--partner-team) [ $# -ge 2 ] || usage; partner_team=$2; shift 2 ;;
	--core-team) [ $# -ge 2 ] || usage; core_team=$2; shift 2 ;;
	--required-reviewers) required_reviewers=true; shift ;;
	--prevent-self-review) prevent_self_review=true; shift ;;
	*) usage ;;
	esac
done
# Self-review is a rule about reviewers: without them there is nothing to prevent.
[ "$prevent_self_review" = false ] || [ "$required_reviewers" = true ] || usage

say() { printf '%s\n' "$*"; }

gh api "repos/$repo" --jq .full_name >/dev/null || { say "can't read $repo: does it exist, and is gh signed in as an owner?" >&2; exit 1; }

team_id=$(gh api "orgs/$owner/teams/$core_team" --jq .id)

# Who may release: an active tag ruleset of the organisation (docs/github-setup.md, "Rulesets")
# on v* tags, restricting creation, update and deletion, which only the core team may bypass.
# Without required reviewers it is the only approval a release gets, so nothing is set up
# without it.
release_tags_rule='(.conditions.ref_name.include | any(. == "refs/tags/v*" or . == "~ALL"))
	and .conditions.ref_name.exclude == []
	and ([.rules[].type] | contains(["creation", "update", "deletion"]))
	and ([.bypass_actors[]? | {actor_id, actor_type}] == [{actor_id: '"$team_id"', actor_type: "Team"}])'
release_tags=
for id in $(gh api "repos/$repo/rulesets?includes_parents=true&targets=tag" --paginate \
	--jq '.[] | select(.source_type == "Organization" and .enforcement == "active") | .id'); do
	if [ "$(gh api "repos/$repo/rulesets/$id" --jq "$release_tags_rule")" = true ]; then
		release_tags=$id
		break
	fi
done
if [ -z "$release_tags" ]; then
	say "no active organisation ruleset lets only $core_team create v* tags and nobody move or delete one: see docs/github-setup.md, \"Rulesets\"" >&2
	exit 1
fi
say "release tags: only $core_team creates v* tags (organisation ruleset $release_tags)"

# Teams.
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

# The release environment: v* tags only, and the core team as required reviewers when asked.
# Without them the body names no protection rule, which GitHub refuses where it doesn't offer one.
tags_only='"deployment_branch_policy":{"protected_branches":false,"custom_branch_policies":true}'
if [ "$required_reviewers" = true ]; then
	printf '{"wait_timer":0,"prevent_self_review":%s,"reviewers":[{"type":"Team","id":%s}],%s}' \
		"$prevent_self_review" "$team_id" "$tags_only"
else
	printf '{%s}' "$tags_only"
fi | gh api -X PUT "repos/$repo/environments/release" --input - >/dev/null
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
if [ "$required_reviewers" = true ]; then
	say "environment release: v* tags only, reviewers $core_team, prevent self-review $prevent_self_review"
else
	say "environment release: v* tags only, no required reviewers"
fi

# The release reads the organisation's ZUTUN_* variables, but a repo or environment variable of
# the same name takes precedence for this repo: it could send a signed release to another
# control plane. None may exist; deleting one is left to a person, who should ask how it got there.
repo_vars=$(gh api "repos/$repo/actions/variables" --paginate --jq '.variables[].name | "repo variable \(.)"')
env_vars=$(gh api "repos/$repo/environments/release/variables" --paginate --jq '.variables[].name | "release environment variable \(.)"')
overrides=$(printf '%s\n%s\n' "$repo_vars" "$env_vars" | grep ' ZUTUN_' || true)
if [ -n "$overrides" ]; then
	printf '%s\n' "$overrides" | while read -r line; do
		say "override: $line takes precedence over the organisation's; delete it" >&2
	done
	exit 1
fi
say "variables: the organisation's ZUTUN_* apply"

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
