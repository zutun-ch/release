#!/bin/sh
# Runs the agent's own checks on an unpacked stack bundle, so the pipeline and the agent share
# one implementation of the manifest schema and the compose policy (MANIFEST §9):
#
#   lint-bundle.sh <zutun-agent binary> <stack name> <bundle dir>
#
# The contract with the agent: `zutun-agent lint --kind stack --name <name> <dir>` exits 0 when
# the bundle is clean, 1 with one finding per line on stdout ("<reason>: <detail>", reasons as in
# platform/test-vectors/README.md), and 2 on a usage error. Each finding becomes an error
# annotation; a usage error means the pinned agent doesn't offer lint as called.
set -u

agent=${1:?usage: lint-bundle.sh <agent> <name> <dir>}
name=${2:?usage: lint-bundle.sh <agent> <name> <dir>}
dir=${3:?usage: lint-bundle.sh <agent> <name> <dir>}

findings=$(mktemp)
trap 'rm -f "$findings"' EXIT

"$agent" lint --kind stack --name "$name" "$dir" >"$findings"
status=$?

case $status in
0)
	echo "zutun-agent lint: $name is clean"
	exit 0
	;;
1)
	count=0
	while IFS= read -r line || [ -n "$line" ]; do
		[ -n "$line" ] || continue
		count=$((count + 1))
		# Workflow-command escaping, so a finding can't end the annotation early.
		escaped=$(printf '%s' "$line" | sed -e 's/%/%25/g')
		printf '::error title=zutun-agent lint::%s\n' "$escaped"
	done <"$findings"
	echo "zutun-agent lint: $count finding(s) in $name; nothing is signed" >&2
	exit 1
	;;
2)
	printf '::error title=zutun-agent lint::%s\n' "zutun-agent refused the call as a usage error (exit 2). The agent at the pinned commit may not offer 'lint --kind stack --name <name> <dir>' yet: raise the agent-commit input of the release workflow to an agent commit that does."
	exit 1
	;;
*)
	printf '::error title=zutun-agent lint::%s\n' "zutun-agent lint ended with exit code $status (expected 0, 1 or 2)"
	exit 1
	;;
esac
