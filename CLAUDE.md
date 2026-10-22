# zutun release

The release pipeline: the reusable workflows `module.yml` (module repos `<owner>/module-<name>`, key `release-modules`) and `core.yml` (`agent`, `host`, `caddy` whose stack is `ingress`, key `release-core`), the composite actions their jobs use, and the Node and sh tooling behind them. It builds images and bundles, checks them, signs through Cloud KMS and uploads to the control plane.

## Read first

- [../platform/docs/architecture.md](../platform/docs/architecture.md) §8: repos and review, "build once, sign per environment", the KMS trust policy, keys. **This repo implements the pipeline described there.**
- [../platform/spec/PROTOCOL.md](../platform/spec/PROTOCOL.md) §6: the artifact reference, the signed string `zutun-artifact-v1`, versions, key ids and scopes, §6.5 bundle rules
- [../platform/spec/CONTROL-PLANE.md](../platform/spec/CONTROL-PLANE.md) §7: the three-step upload and the OIDC token checks; §9: no deployment values in code
- [../platform/spec/MANIFEST.md](../platform/spec/MANIFEST.md) §8 to §10: scripts, compose policy, container images
- `../control-plane/apps/admin/src/lib/server/releases/` (`upload.ts`, `github.ts`, `registry.ts`): the other side of the upload; answers and codes must keep matching
- `../platform/test-vectors/artifact-signatures.json`: the tests check the signed string and signatures against it

## Contracts

- **Name from the repository, never an input.** `module-<name>` → stack `<name>`; `agent` → agent builds `zutun-agent-linux-{amd64,arm64}`; `caddy` → stack `ingress`; `host` → stack `host` (`scripts/lib/identity.mjs`, mirroring the control plane's `registry.ts`). The reference module `example` is staging-only (architecture §9): the plan's `production` output is false and module.yml's production publish job doesn't run.
- **Version from the tag** `v<N>`, N a positive integer without leading zeros (the control plane compares `ref` with `refs/tags/v<version>` exactly). Other refs build and check only; a malformed `v…` tag fails.
- **Key id = `<KMS crypto key>-<version>`**, derived from the `ZUTUN_KMS_*` variable; the workflow fixes the family (`release-modules`, `release-core`, `staging`) and the scope check of PROTOCOL §6.3 runs before KMS is asked.
- **Same bytes signed everywhere:** the bundle is built once, handed on as the artifact `release-build` with `release.json`, re-hashed before signing, signed for staging and production.
- **Lint contract with the agent:** `zutun-agent lint --kind stack --name <name> <dir>`, exit 0 clean, 1 with `<reason>: <detail>` lines on stdout, 2 usage. Built from the agent repo at the `agent-commit` default (equal in both workflows) with `-tags staging`. No second compose linter here.
- **Upload:** CONTROL-PLANE §7 step 1 body is the reference plus `commit` (= `GITHUB_SHA`) and `notes` (the tag message, ≤ 2000 bytes); a fresh GitHub OIDC token (audience = the control-plane origin) for steps 1 and 3 and every retry.
- **The publish jobs live in `module.yml` and `core.yml` themselves** (not a nested workflow), because the token's `job_workflow_ref` names the file that defines the job and the trust policy tells module from core by it.

## Settled details

- **Tooling checkout:** each job checks out this repo at `job.workflow_repository`@`job.workflow_sha` into `.release`, then a step checks `HEAD` equals `job.workflow_sha` before anything from `.release` runs, so a caller's own files can never stand in for the tooling. actionlint 1.7.12 doesn't know those two properties yet; `.github/actionlint.yaml` ignores exactly that message.
- **This repo is public:** callers check it out with their own `GITHUB_TOKEN`.
- **Images:** `image/Dockerfile` → `<base>`, `images/<suffix>/Dockerfile` → `<base>-<suffix>`, base = repo name without `module-`. Built with QEMU and buildx in one job for both architectures; pushed only for a release, tagged `v<N>`, with `org.opencontainers.image.source` linking the package to its repo. The public check asks GHCR anonymously, like a server.
- **Placeholders:** `image: ghcr.io/<owner>/<image>@sha256:` + 64 zeros, on its own line, exactly the pushed repository. Pinning edits the bundle's copy only.
- **Determinism:** ustar, entries sorted bytewise, mtime 0, uid/gid 0, no names, modes 0755/0644, two zero blocks and nothing after, gzip header fixed (mtime 0, OS 255), deflate level 9 from Node's zlib. The same commit and Node version give the same sha256; a golden test pins the tar bytes.
- **KMS:** REST with the federated `auth_token` of `google-github-actions/auth` (no credentials file, no service account); Ed25519 signs the data itself; CRC32C on request, signature and public key; the signature is verified locally before any upload; every artifact of a release is signed and verified before the first upload.
- **Retries:** network errors, 429 and 5xx, three tries (four for step 3), each with a new token. A refusal stops at once with an explanation. After a lost answer, a `version` or `state` refusal says the earlier attempt may have gone through.
- **Variables, not secrets:** `ZUTUN_CONTROL_PLANE_ORIGIN`, `ZUTUN_WORKLOAD_IDENTITY_PROVIDER`, `ZUTUN_KMS_RELEASE_CORE`, `ZUTUN_KMS_RELEASE_MODULES`; staging `ZUTUN_STAGING_*` and `ZUTUN_KMS_STAGING`, and the staging jobs run only when `ZUTUN_STAGING_CONTROL_PLANE_ORIGIN` is set. `require-vars.mjs` names any that is missing.
- **Agent builds:** `CGO_ENABLED=0 go build -trimpath -tags prod -ldflags "-buildid= -X main.version=v<N> -X main.build=<N>"`; Go module cache off in release jobs.

## Testing

- `node --test 'test/*.test.mjs'`. No npm dependencies. The platform repo is `../platform` or `PLATFORM_DIR`.
- Everything is tested locally against fakes (`test/fakes.mjs`: GitHub OIDC, Cloud KMS, the control plane's three steps; a fake registry; a stand-in `gh` and `zutun-agent`). `test/workflows.test.mjs` checks the workflow files with a small YAML subset parser (`test/lib/yaml.mjs`).
- CI (`.github/workflows/ci.yml`): the tests with the platform repo checked out through the organisation's GitHub App, actionlint (official image by digest), ShellCheck. Dependabot updates the pinned actions, also inside `.github/actions/*`.
- Never call the real control plane, GHCR or Google Cloud from tests.

## Conventions

- Conventional Commits.
- Third-party actions pinned by full commit SHA with `# vX.Y.Z`; one version per action across all files (a test checks both).
- No `${{ }}` inside `run:`: values go through `env`. `permissions` on every job, `id-token: write` only in the publish jobs, `packages: write` only in the images job.
- No deployment values (domains, regions, project or key names, the organisation) in workflows or scripts; they come from variables or `github.repository_owner`. The docs name zutun's values as examples.
