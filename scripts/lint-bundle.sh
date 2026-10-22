#!/bin/sh
# Runs the agent's own checks on an unpacked stack bundle, so the pipeline and the agent share
# one implementation of the manifest schema and the compose policy (MANIFEST §9):
#
#   lint-bundle.sh <zutun-agent binary> <stack name> <bundle dir>
#
# The contract with the agent is platform/test-vectors/README.md, "zutun-agent lint":
# `zutun-agent lint --kind stack --name <name> <dir>` exits 0 when the bundle is clean, 1 with
# one finding per line on stdout ("<reason>: <detail>"), and 2 on a usage error (its message on
# stderr, which reaches the log as is). The agent checks the layout, then the manifest, its
# references and the compose file; the layout and compose checks stop at their first finding,
# the manifest checks report all of theirs.
#
# Each finding becomes an error annotation titled with what it checks, so whoever reads a
# failed run knows where to look. A reason this script doesn't know (a newer agent) is still
# annotated, under the plain title. A usage error means the pinned agent doesn't offer lint as
# called.
set -u

agent=${1:?usage: lint-bundle.sh <agent> <name> <dir>}
name=${2:?usage: lint-bundle.sh <agent> <name> <dir>}
dir=${3:?usage: lint-bundle.sh <agent> <name> <dir>}

findings=$(mktemp)
trap 'rm -f "$findings"' EXIT

"$agent" lint --kind stack --name "$name" "$dir" >"$findings"
status=$?

# The title of a finding's annotation, from its reason (the reasons of the contract). Titles
# are annotation properties: no ':' or ','.
title() {
	case $1 in
	bundle_invalid) echo 'zutun-agent lint - bundle layout (PROTOCOL §6.5)' ;;
	yaml_invalid) echo 'zutun-agent lint - YAML' ;;
	schema_invalid | name_mismatch) echo 'zutun-agent lint - manifest (MANIFEST §2)' ;;
	reference_invalid) echo 'zutun-agent lint - manifest cross-checks (MANIFEST §2)' ;;
	key_not_allowed | variable_not_allowed | image_digest | bind_outside | mount_not_readonly | \
		mount_not_allowed | port_undeclared | cap_not_allowed | security_opt_not_allowed | \
		user_not_numeric | healthcheck_required | network_not_allowed | label_reserved | \
		restart_not_allowed | sysctl_not_allowed | secrets_user_mismatch | certs_user_mismatch)
		echo 'zutun-agent lint - compose policy (MANIFEST §9)'
		;;
	*) echo 'zutun-agent lint' ;;
	esac
}

case $status in
0)
	echo "zutun-agent lint: $name is clean"
	exit 0
	;;
1)
	count=0
	first_only=
	while IFS= read -r line || [ -n "$line" ]; do
		[ -n "$line" ] || continue
		count=$((count + 1))
		reason=${line%%:*}
		t=$(title "$reason")
		case $t in *layout* | *compose*) first_only=yes ;; esac
		# Workflow-command escaping, so a finding can't end the annotation early.
		escaped=$(printf '%s' "$line" | sed -e 's/%/%25/g')
		printf '::error title=%s::%s\n' "$t" "$escaped"
	done <"$findings"
	if [ "$count" -eq 0 ]; then
		printf '::error title=zutun-agent lint::%s\n' "zutun-agent lint exited 1 without a finding on stdout, which breaks its contract; nothing is signed"
		exit 1
	fi
	echo "zutun-agent lint: $count finding(s) in $name; nothing is signed" >&2
	if [ -n "$first_only" ]; then
		echo "zutun-agent lint: the layout and compose checks report their first finding only, so the next run may show another" >&2
	fi
	exit 1
	;;
2)
	printf '::error title=zutun-agent lint::%s\n' "zutun-agent refused the call as a usage error (exit 2). The agent at the pinned commit may not offer 'lint --kind stack --name <name> <dir>' yet: raise the release repo's pinned agent commit to one that does (its README, 'The agent commit for lint')."
	exit 1
	;;
*)
	printf '::error title=zutun-agent lint::%s\n' "zutun-agent lint ended with exit code $status (expected 0, 1 or 2)"
	exit 1
	;;
esac
