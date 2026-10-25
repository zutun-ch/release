# zutun release

The release pipeline of zutun: two reusable GitHub workflows that build, check, sign and upload every module and every platform component (architecture §8, "build once, sign per environment").

- [`module.yml`](.github/workflows/module.yml) releases a module from its repo `<owner>/module-<name>`, signed with `release-modules`.
- [`core.yml`](.github/workflows/core.yml) releases the platform's own: the agent (`<owner>/agent`), the `host` stack (`<owner>/host`) and the `ingress` stack (`<owner>/ingress`), signed with `release-core`.

Signing keys live in Google Cloud KMS and never leave it; the workflows reach them through GitHub OIDC and Workload Identity Federation, with no stored Google credential. Setting that up: [docs/google-cloud-kms.md](docs/google-cloud-kms.md). The GitHub side (teams, rulesets, the `release` environment, CODEOWNERS): [docs/github-setup.md](docs/github-setup.md).

## What a run does

A push to `main` builds and checks everything and stops there. A tag `v<N>` releases version N:

| Job | Does | Permissions |
|---|---|---|
| Plan | the name from the repository (never from an input), the version from the tag, the images from the repo's layout; a release refuses an `agent-commit` other than the pinned one | read |
| Images | builds each image for `linux/amd64` and `linux/arm64`; for a release pushes it to `ghcr.io/<owner>/<image>:v<N>` and stops unless every package is public | read, packages write |
| Bundle | writes the version into `manifest.yaml` and the pushed digests into `compose.yaml` (in the bundle only), checks PROTOCOL §6.5, packs the bundle deterministically | read |
| zutun-agent lint | checks the bundle is the one the bundle job packed, unpacks it and runs `zutun-agent lint`, built from the agent repo at a pinned commit; for `host` a second time with the floor agent ("The floor lint") | read |
| Agent builds (core, agent only) | `go build -tags prod` for both architectures, version = build number = N; records the build's manifest reader, the sha256 of the schema it embeds, for the upload | read |
| Publish to staging | only when the staging variables exist: signs with the staging key, uploads to the staging control plane | read, id-token |
| Publish | in the environment `release`, on a `v<N>` tag only `platform-core` can create (and after a required reviewer approves, where the environment has them): signs the **same** bytes with the release key through Cloud KMS, verifies the signature against the key's public key, uploads in the three steps of CONTROL-PLANE §7 with a fresh OIDC token for each | read, id-token |

Nothing from the repo being released runs in the publish jobs: they check out only this repo's tooling (at the workflow's own commit) and the build artifact. Any job of the caller's workflow could upload an artifact, so it is trusted only through job outputs, which no other job can change: lint checks the bundle's sha256 against the bundle job's, and publish checks `release.json` against the build job's sha256, its artifacts against the plan's name, kind and version, and every file against `release.json`, all before signing. Each run's summary shows name, version, sha256, size, commit and image digests, for the reviewer who approves.

## Calling the pipeline

A module repo has `.github/workflows/release.yml`:

```yaml
name: Release

on:
  push:
    branches: [main]
    tags: ["v*"]
  # "Run workflow" in the Actions tab: on main it builds and checks, on a tag v<N> it releases.
  workflow_dispatch:

permissions: {}

jobs:
  release:
    # @main on purpose: the KMS trust policy and the control plane accept only
    # the release workflow on the protected main branch.
    uses: zutun-ch/release/.github/workflows/module.yml@main
    # What the called jobs declare, no more: a caller can't grant less.
    permissions:
      contents: read
      packages: write
      id-token: write
    # Only the GitHub App that may read the agent repo, never `secrets: inherit`.
    secrets:
      PLATFORM_APP_CLIENT_ID: ${{ secrets.PLATFORM_APP_CLIENT_ID }}
      PLATFORM_APP_PRIVATE_KEY: ${{ secrets.PLATFORM_APP_PRIVATE_KEY }}
```

`ingress` and `host` use the same caller with `core.yml`, and so will `agent`, without the `secrets:` block: its release builds no stack and runs no lint. The reference module `example`, from `module-example`, is released to staging only (architecture §9): its run stops before the production publish job. To release, tag a commit on `main` (a tag on any other branch is refused at Plan): `git tag -a v12 -m "What changed" && git push origin v12`. The tag's message becomes the release notes.

## What a release repo looks like

```
manifest.yaml        version: written by the pipeline from the tag; name: the module's name
compose.yaml         every image the repo builds as ghcr.io/<owner>/<image>@sha256:000…0 (64 zeros)
scripts/             the manifest's scripts (optional)
image/Dockerfile     the image <name>: build context image/
images/<x>/Dockerfile further images, named <name>-<x>: build context images/<x>/
```

Only `manifest.yaml`, `compose.yaml` and `scripts/` go into the bundle. `compose.yaml` is required except in `host`.

### Image layout

- `image/Dockerfile` builds the repo's image, named after the repo without `module-`: `module-mail` builds `ghcr.io/<owner>/mail`, `ingress` builds `ghcr.io/<owner>/ingress`. The directory is the build context.
- `images/<suffix>/Dockerfile` builds further images, `ghcr.io/<owner>/<name>-<suffix>`, with `<suffix>` matching `^[a-z0-9][a-z0-9-]{0,30}$`.
- A repo with neither builds no image (`host`, or a module made of third-party images only).

### Digests

`compose.yaml` names each image the repo builds with the all-zero placeholder digest, exactly the repository the pipeline pushes:

```yaml
services:
  app:
    image: ghcr.io/zutun-ch/mail@sha256:0000000000000000000000000000000000000000000000000000000000000000
  db:
    image: docker.io/library/postgres:17@sha256:<real digest>   # not built here: left alone
```

The placeholder passes the compose policy's syntax check, and a bundle that still has it can't be pulled. The pipeline replaces each one with the pushed digest, on its own line of the form `image: <repository>[:<tag>]@sha256:0…0`, and stops if a placeholder has no image, an image has no placeholder, or a placeholder sits anywhere else. Images are always referenced by digest (MANIFEST §10).

## The tooling

```
.github/workflows/module.yml, core.yml   the reusable workflows; jobs only, steps in the actions
.github/workflows/ci.yml                 this repo's CI: tests, actionlint, ShellCheck
.github/actions/images/                  build, push, check public
.github/actions/stack-bundle/            version, digests, pack, hand on
.github/actions/lint/                    build zutun-agent at a commit (pinned, or the floor), lint
.github/actions/publish/                 Google token, sign, verify, upload
scripts/*.mjs, *.sh                      what the actions run (Node 24, no npm dependencies; POSIX sh)
scripts/lib/                             the logic, one module per concern
scripts/setup-repo.sh                    applies a repo's GitHub settings (docs/github-setup.md)
test/                                    node --test, with local fakes of KMS, GHCR, GitHub OIDC and the control plane
docs/                                    the Google Cloud and GitHub setup guides
```

### Tests

No npm dependencies: Node's built-in test runner, Node 24.

```sh
node --test 'test/*.test.mjs'
```

They read the platform's test vectors from `../platform`, or from `PLATFORM_DIR`. They cover the name and version rules, image layout, digest pinning, deterministic packing and the bundle rules (checked byte by byte, with the system `tar`), the signed string and signatures against `platform/test-vectors/artifact-signatures.json`, key ids and scopes, the KMS client, the upload client against a fake control plane (refusals, retries with fresh tokens, a lost answer), the public-package check, the lint wrapper (also at the floor), the manifest reader of agent builds, `setup-repo.sh` against a stand-in `gh`, and the workflow files themselves (pinned actions, permissions per job, no expression in a shell script, the tooling commit check, inputs of the composite actions, the floor lint of `host`).

CI also runs actionlint (the official image, pinned by digest) and ShellCheck.

### The agent commit for lint

The lint job builds `zutun-agent` from the agent repo at the commit this repo pins: `AGENT_COMMIT` in `scripts/lib/lint.mjs`, which is also the `agent-commit` default of `module.yml` and `core.yml` (a test keeps the three equal). When an agent release changes `zutun-agent lint`, raise all three to that release's commit; a change of the manifest schema is such a change, since an agent with an older copy refuses every manifest that uses the new fields. With the agent repo next to this one (or `AGENT_DIR`), a test compares the pinned commit's schema copy with the platform's and fails until the pin is raised (CI has no agent checkout and skips it). If the pinned agent doesn't offer `lint` as the pipeline calls it, the lint job fails and says so.

Callers don't pass `agent-commit`. The check only means something if every release is held to the same rules, and an older agent's lint predates the compose rules added since (architecture §8, review B-74). So a release (a `v<N>` tag) refuses any other value at Plan, before anything is built. A push to `main` may try another agent's lint, for instance a newer one before the pin is raised; the plan notes that a release would refuse it.

### The floor lint

`host` carries the recovery scripts (`agent/repair` among them), so it is written in floor form: every agent build from the platform's floor on must read it, the oldest included (platform MANIFEST §2.2, review D-134). `core.yml` therefore lints a `host` bundle twice, in the same job: with the pinned agent, as every stack, and then with the floor agent, `FLOOR_AGENT_COMMIT` in `scripts/lib/lint.mjs` (agent tag `v1`, build 1, reader `r22`). The real binary is used because a schema check alone can't see the agent's checks beyond the schema. The step runs whenever the plan's name is `host`, and its commit is written into `core.yml`, not taken from an input; a test keeps it equal to the constant and, with an agent checkout, checks that its embedded schema is the floor reader of the platform's `spec/manifest/readers/expect.json`. `checkAgentCommit` doesn't know the floor: a caller still can't choose any agent but the pinned one. Raising the floor is a review decision; the constant and `core.yml` follow it in one commit. A finding of the floor lint means the manifest isn't in floor form: keep `manifest.yaml` equal to the platform's `spec/manifest/examples/host.yaml`.

### The manifest reader of an agent build

An agent upload carries `manifest_reader` in step 1 (CONTROL-PLANE §7): the sha256 of `internal/manifest/manifest.v1.schema.json` in the agent's checkout, the file the build compiles in. The agent job's `agent-release.mjs --manifest-schema` hashes it into `release.json` for both architectures, so the publish jobs send what the build job recorded; a stack upload has none. The control plane refuses a reader that isn't in its copy of the platform's `readers.lock` (`reader_unknown`), so a build with a new reader waits until the control plane that knows it is deployed. A control plane from before rev 33 ignores the field; a build released to one gets its reader recorded by hand.

## When a release stops

| Message | Meaning |
|---|---|
| `module.yml releases repositories named module-<name>` | the caller's repository isn't a module repo, or calls the wrong workflow |
| `… to staging only (architecture §9)` | not an error: the reference module never gets a production signature |
| `tag "…" isn't a release tag` | tags are `v<N>`: `v12`, not `v1.2.0` or `v012` |
| `agent-commit is "…", but a release is linted by the agent this workflow pins` | remove `agent-commit` from the caller's `release.yml` ("The agent commit for lint") |
| `… carries the placeholder digest, but this repo builds …` / `… is built, but compose.yaml has no …` | `compose.yaml` and the image layout disagree |
| `… isn't public` | make the package public once (docs/github-setup.md, "Packages") and re-run |
| `zutun-agent lint - …` findings | one annotation per finding, titled with what it checks: the bundle layout (PROTOCOL §6.5), YAML, the manifest and its cross-checks (MANIFEST §2) or the compose policy (MANIFEST §9). The layout and compose checks report their first finding only, so a fixed bundle may show the next one |
| `The GitHub organisation variable … is not set` | docs/google-cloud-kms.md, step 8 |
| `Cloud KMS refused … (403)` | the key's IAM binding or the provider's condition (docs/google-cloud-kms.md, steps 4 and 5) |
| `… already has this version or a higher one` | tag a higher version |
| `the control plane rejected release …: <reason>` | the bundle failed a check in step 3 (CONTROL-PLANE §7) |
| `zutun-agent lint at the floor - …` findings | `host` isn't in floor form: the oldest agent build can't read it ("The floor lint") |
| `… doesn't know this build's manifest reader …` | the reader isn't in the deployed control plane's `readers.lock` yet: deploy the control plane that has it, then re-run ("The manifest reader of an agent build") |
| `… has no manifest reader …` | the agent job recorded none: `agent-release.mjs` runs with `--manifest-schema` in the agent's checkout |
