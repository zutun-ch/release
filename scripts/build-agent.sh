#!/bin/sh
# Builds the production agent for linux/amd64 and linux/arm64 from the agent repo in the
# working directory (architecture §9: -tags prod embeds the release keys, never the staging key).
#
#   build-agent.sh <out dir> <build number or empty>
#
# Writes <out dir>/zutun-agent-linux-<arch>. The build number is the artifact version
# (PROTOCOL §6.2), from the tag v<N>; without one (pushes to main) it is 0 and the build is only
# checked. Static (no cgo), -trimpath and an empty build id, so the same commit and Go version
# give the same binary.
set -eu

out=${1:?usage: build-agent.sh <out dir> <build number or empty>}
build=${2:-}

if [ -n "$build" ]; then
	version="v$build"
else
	build=0
	version="dev-$(git rev-parse --short=12 HEAD)"
fi

mkdir -p "$out"
for arch in amd64 arm64; do
	CGO_ENABLED=0 GOOS=linux GOARCH="$arch" go build -trimpath -tags prod \
		-ldflags "-buildid= -X main.version=$version -X main.build=$build" \
		-o "$out/zutun-agent-linux-$arch" ./cmd/zutun-agent
	echo "built $out/zutun-agent-linux-$arch ($version, build $build)"
done
