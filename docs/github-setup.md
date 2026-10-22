# GitHub setup for releases

What the organisation and each release repo need so that only reviewed code is released, by the pinned workflows, after approval (architecture §8, "Repos and review"). The organisation-level parts are done once, by hand, with the commands below; the repo-level parts are applied to each repo by [`scripts/setup-repo.sh`](../scripts/setup-repo.sh), which can be run again at any time. The signing side is in [google-cloud-kms.md](google-cloud-kms.md).

The commands use zutun's organisation, `zutun-ch`, as the example. Run them as an organisation owner with the GitHub CLI (`gh auth login`).

```sh
export GITHUB_ORG=zutun-ch
```

Some of this needs a paid plan for private repositories: organisation rulesets, required reviewers on environments, and organisation secrets and variables for private repos are GitHub Team features.

## Organisation

### The team platform-core

zutun staff who review releases. It owns the release-relevant files of every repo (CODEOWNERS) and is the required reviewer of every `release` environment.

```sh
gh api -X POST "orgs/$GITHUB_ORG/teams" -f name=platform-core -f privacy=closed \
  -f description="Reviews and approves releases"
gh api -X PUT "orgs/$GITHUB_ORG/teams/platform-core/memberships/<github user>" -f role=maintainer
```

Partner teams get one team each, with write access to their own module repos only (`setup-repo.sh --partner-team`). Only zutun staff are organisation owners or repo admins.

### Member privileges: only staff administer repos

The KMS trust policy accepts a token from any repo of the organisation whose job ran in an environment called `release` (google-cloud-kms.md, step 4), and the reviewers of that environment are the only approval a release gets. Whoever administers a repo decides whether its `release` environment has reviewers, and its repo variables take precedence over the organisation's `ZUTUN_*` variables, so a repo admin also decides which control plane a release goes to. GitHub lets every member create repositories by default, and the creator administers the new repo: a partner could then create `module-anything`, give it a `release` environment without reviewers and have any bundle signed with release-modules.

So members can't create repositories, and their base permission is read; zutun staff create the repos and run `setup-repo.sh` on each:

```sh
gh api -X PATCH "orgs/$GITHUB_ORG" \
  -F members_can_create_repositories=false \
  -F members_can_create_public_repositories=false \
  -F members_can_create_private_repositories=false \
  -F members_can_create_internal_repositories=false \
  -f default_repository_permission=read
gh api "orgs/$GITHUB_ORG" --jq '{members_can_create_repositories, default_repository_permission}'
```

`setup-repo.sh` refuses a repo whose own or whose `release` environment's variables include a `ZUTUN_*` name.

### The release repo is public

Every module and platform repo calls the workflows in `<owner>/release` and checks out its scripts with its own `GITHUB_TOKEN`, which can read public repos but no other private one. The repo holds no secrets and nothing deployment-specific.

```sh
gh repo edit "$GITHUB_ORG/release" --visibility public --accept-visibility-change-consequences
```

### Actions policy

**Settings → Actions → General**:
- *Policies*: "Allow `<owner>`, and select non-`<owner>`, actions and reusable workflows", with these allowed: `actions/checkout@*`, `actions/setup-node@*`, `actions/setup-go@*`, `actions/upload-artifact@*`, `actions/download-artifact@*`, `actions/create-github-app-token@*`, `docker/setup-qemu-action@*`, `docker/setup-buildx-action@*`, `google-github-actions/auth@*`, the image `docker://rhysd/actionlint` (this repo's CI), plus what the repos' own CI uses. Leave *Require actions to be pinned to a full-length commit SHA* off: the callers reference the release workflows by `@main` on purpose, because the trust policy names `main`. Third-party actions are pinned in the files themselves, and this repo's tests check it.
- *Workflow permissions*: "Read repository contents and packages permissions"; "Allow GitHub Actions to create and approve pull requests" off.

### Secrets for the agent checkout

The lint job builds `zutun-agent` from the private agent repo with the organisation's GitHub App, the same one the repos' CI uses to read the platform repo. Install the App on the `agent` repo too (contents: read), and make the organisation secrets `PLATFORM_APP_CLIENT_ID` and `PLATFORM_APP_PRIVATE_KEY` available to every module repo and to `caddy` and `host`. Callers pass exactly these two under `secrets:`, never `secrets: inherit`, so no other secret of the repo reaches the pipeline.

### Rulesets

Two organisation rulesets, for every repo:

- **main**: changes only through a pull request with one approval, including a code owner's; no force pushes, no deletion. Organisation admins may bypass it, so the owner can keep committing directly while the platform is before v1; remove the bypass once v1 is out.
- **release tags**: `v*` tags can't be moved or deleted. Creating one starts a release, which still waits for approval in the `release` environment.

```sh
gh api -X POST "orgs/$GITHUB_ORG/rulesets" --input - <<'EOF'
{
  "name": "main",
  "target": "branch",
  "enforcement": "active",
  "conditions": {
    "ref_name": { "include": ["~DEFAULT_BRANCH"], "exclude": [] },
    "repository_name": { "include": ["~ALL"], "exclude": [] }
  },
  "bypass_actors": [{ "actor_id": 1, "actor_type": "OrganizationAdmin", "bypass_mode": "always" }],
  "rules": [
    { "type": "deletion" },
    { "type": "non_fast_forward" },
    {
      "type": "pull_request",
      "parameters": {
        "required_approving_review_count": 1,
        "require_code_owner_review": true,
        "dismiss_stale_reviews_on_push": true,
        "require_last_push_approval": true,
        "required_review_thread_resolution": false
      }
    }
  ]
}
EOF

gh api -X POST "orgs/$GITHUB_ORG/rulesets" --input - <<'EOF'
{
  "name": "release tags",
  "target": "tag",
  "enforcement": "active",
  "conditions": {
    "ref_name": { "include": ["refs/tags/v*"], "exclude": [] },
    "repository_name": { "include": ["~ALL"], "exclude": [] }
  },
  "bypass_actors": [],
  "rules": [{ "type": "update" }, { "type": "deletion" }]
}
EOF

gh api "orgs/$GITHUB_ORG/rulesets" --jq '.[] | "\(.id) \(.name) \(.enforcement)"'
```

`main` of the release repo is what the KMS trust policy and the control plane trust (`job_workflow_ref …@refs/heads/main`), so this ruleset is part of the signing security: whoever can change `main` of `<owner>/release` can change what gets signed.

### Packages

Servers pull images without credentials, so every package must be public (MANIFEST §10).
- **Settings → Packages → Package creation**: allow public packages.
- A package starts private when a workflow first pushes it. The first release of a module therefore stops at "Check the packages are public", after the push, before anything is signed. Make the package public once (the package page → *Package settings* → *Danger Zone* → *Change visibility* → *Public*) and re-run the failed jobs. The package is linked to its repo by the `org.opencontainers.image.source` label, which gives that repo's workflows write access to it.

### Variables

The organisation variables of [google-cloud-kms.md](google-cloud-kms.md), step 8, with visibility "all repositories".

## Each release repo

### Settings: `scripts/setup-repo.sh`

```sh
# A module repo, with its partner team:
scripts/setup-repo.sh zutun-ch/module-mail --partner-team mail-team
# A platform repo:
scripts/setup-repo.sh zutun-ch/caddy
# Once two people can approve, on every repo:
scripts/setup-repo.sh zutun-ch/module-mail --prevent-self-review
```

It gives `platform-core` maintain access (and the partner team write access), makes the default workflow token read-only, and creates or updates the `release` environment: `platform-core` as required reviewers, deployments from `v*` tags only (any branch rule is removed), and "prevent self-review" when asked. It fails if the repo or its `release` environment has a `ZUTUN_*` variable of its own, which would override the organisation's. Then it reports whether `.github/CODEOWNERS` and the caller workflow `.github/workflows/release.yml` exist; those are files in the repo, added by pull request.

GitHub environments ask for one approval from the listed reviewers. Architecture §8 wants two people for the core releases "once possible"; until GitHub can require two approvals, "prevent self-review" makes sure the one approval comes from someone other than the person who pushed the tag.

### CODEOWNERS

`.github/CODEOWNERS` of a module repo: the files that decide what runs on a server belong to `platform-core`, everything else to the partner team (architecture §8).

```
*                @zutun-ch/<partner team>
/manifest.yaml   @zutun-ch/platform-core
/compose.yaml    @zutun-ch/platform-core
/scripts/        @zutun-ch/platform-core
/.github/        @zutun-ch/platform-core
```

In `agent`, `caddy`, `host` and `release`: `* @zutun-ch/platform-core`.

### The caller workflow

`.github/workflows/release.yml`, as in the [README](../README.md#calling-the-pipeline).
