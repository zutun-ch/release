# Signing keys in Google Cloud KMS

The release workflows sign with Ed25519 keys that live in Cloud KMS and never leave it. A workflow gets to use a key through Workload Identity Federation: GitHub's OIDC token for the job is exchanged for a short-lived Google token, and IAM grants that federated identity the key directly. There is no service account and no key file, so no long-lived Google credential exists anywhere.

You do this once, as an owner of the GitHub organisation and of a Google Cloud billing account. It takes about half an hour. The commands use zutun's deployment as the example: the GitHub organisation `zutun-ch`, the region `europe-west6` (Zurich). Another deployment uses its own values; nothing in the workflows names them (CONTROL-PLANE §9).

What you end up with:

| Piece | zutun's value | Why |
|---|---|---|
| Project | `zutun-release-signing` (pick your own: project ids are global) | Holds only the keys, so few people have any role in it |
| Key ring | `zutun-release` in `europe-west6` | Key rings and keys can't be deleted or renamed, and stay in the region |
| Keys | `release-core`, `release-modules`: `EC_SIGN_ED25519`, protection level `SOFTWARE` | PROTOCOL §6.3; the key id is `<key>-<version>`, so version 1 signs as `release-core-1` |
| Workload identity pool | `github-release`, provider `github` | Accepts only tokens of the pinned release workflows, in the `release` environment, on `v*` tags |
| IAM | each key grants sign and public-key read to exactly one workflow | `release-modules` to `module.yml`, `release-core` to `core.yml` |
| Standby keys | `standby-core-1`, `standby-modules-1`, offline | Emergency rotation (PROTOCOL §6.3) |
| GitHub variables | `ZUTUN_CONTROL_PLANE_ORIGIN`, `ZUTUN_WORKLOAD_IDENTITY_PROVIDER`, `ZUTUN_KMS_RELEASE_CORE`, `ZUTUN_KMS_RELEASE_MODULES` | What the workflows read; until they exist a release stops and names the missing one |

You need the [Google Cloud CLI](https://cloud.google.com/sdk/docs/install) (`gcloud`, signed in with `gcloud auth login`), the [GitHub CLI](https://cli.github.com/) (`gh`, signed in as an organisation owner) and OpenSSL 3.

## 1. Settings for this session

```sh
export GITHUB_ORG=zutun-ch
export PROJECT_ID=zutun-release-signing
export LOCATION=europe-west6
export KEY_RING=zutun-release
export POOL=github-release
export PROVIDER=github
```

## 2. The project

```sh
gcloud projects create "$PROJECT_ID" --name="zutun release signing"
gcloud billing accounts list
gcloud billing projects link "$PROJECT_ID" --billing-account=<ACCOUNT_ID from the list>
gcloud config set project "$PROJECT_ID"
gcloud services enable cloudkms.googleapis.com iam.googleapis.com sts.googleapis.com
export PROJECT_NUMBER=$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')
```

Turn on the audit log of every use of the keys: in the console, **IAM & Admin → Audit Logs → Cloud Key Management Service (KMS) API**, tick **Data Read** and **Data Write**, save. Each signature then shows up in Logs Explorer with the GitHub identity that asked for it.

Keep the project's IAM short: the organisation's owners, nobody else. The workflows need no role on the project, only on the keys (step 5).

## 3. The key ring and the keys

```sh
gcloud kms keyrings create "$KEY_RING" --location "$LOCATION"

for key in release-core release-modules; do
  gcloud kms keys create "$key" \
    --keyring "$KEY_RING" --location "$LOCATION" \
    --purpose asymmetric-signing \
    --default-algorithm ec-sign-ed25519 \
    --protection-level software \
    --destroy-scheduled-duration 120d
done
```

Each key starts with version 1. `--destroy-scheduled-duration 120d` is the longest grace period: a key version scheduled for destruction by mistake can be restored for 120 days. If `gcloud` doesn't know `ec-sign-ed25519`, update it (`gcloud components update`).

## 4. The workload identity pool and the GitHub provider

The provider's attribute condition is the trust policy of architecture §8. A token is accepted only if all of this holds:

- `repository_owner` is the organisation (and `repository_owner_id` its numeric id, which survives a rename and can't be taken over by a new organisation of the same name);
- `job_workflow_ref` is one of the two pinned release workflows on the protected `main`;
- `environment` is `release` (the job waited for a required reviewer);
- `ref` is a `v*` tag.

```sh
export ORG_ID=$(gh api "orgs/$GITHUB_ORG" --jq .id)
export MODULE_WORKFLOW="$GITHUB_ORG/release/.github/workflows/module.yml@refs/heads/main"
export CORE_WORKFLOW="$GITHUB_ORG/release/.github/workflows/core.yml@refs/heads/main"

gcloud iam workload-identity-pools create "$POOL" \
  --location=global --display-name="GitHub release workflows"

gcloud iam workload-identity-pools providers create-oidc "$PROVIDER" \
  --location=global --workload-identity-pool="$POOL" \
  --display-name="GitHub Actions" \
  --issuer-uri="https://token.actions.githubusercontent.com" \
  --attribute-mapping="google.subject=assertion.sub,attribute.release_workflow=(assertion.job_workflow_ref == '$MODULE_WORKFLOW') ? 'module' : ((assertion.job_workflow_ref == '$CORE_WORKFLOW') ? 'core' : 'other')" \
  --attribute-condition="assertion.repository_owner == '$GITHUB_ORG' && assertion.repository_owner_id == '$ORG_ID' && assertion.job_workflow_ref in ['$MODULE_WORKFLOW', '$CORE_WORKFLOW'] && assertion.environment == 'release' && assertion.ref.startsWith('refs/tags/v')"
```

`attribute.release_workflow` says which of the two workflows a token comes from, so the next step can give each key to one workflow only. Check what was stored:

```sh
gcloud iam workload-identity-pools providers describe "$PROVIDER" \
  --location=global --workload-identity-pool="$POOL" \
  --format='yaml(attributeCondition,attributeMapping,state)'
```

Use this pool for nothing else. A staging pool (step 9) is a separate pool, so a staging token can never match a binding of a release key.

## 5. Who may use which key

The federated identities of one workflow form a principal set; each key grants exactly the two permissions the pipeline uses, `asymmetricSign` (`roles/cloudkms.signer`) and `getPublicKey` (`roles/cloudkms.publicKeyViewer`), on that key only. (`roles/cloudkms.signerVerifier` would work too, but also allows verifying MACs, which nothing needs.)

```sh
export PRINCIPALS="principalSet://iam.googleapis.com/projects/$PROJECT_NUMBER/locations/global/workloadIdentityPools/$POOL/attribute.release_workflow"

for role in roles/cloudkms.signer roles/cloudkms.publicKeyViewer; do
  gcloud kms keys add-iam-policy-binding release-modules \
    --keyring "$KEY_RING" --location "$LOCATION" \
    --member="$PRINCIPALS/module" --role="$role"
  gcloud kms keys add-iam-policy-binding release-core \
    --keyring "$KEY_RING" --location "$LOCATION" \
    --member="$PRINCIPALS/core" --role="$role"
done

gcloud kms keys get-iam-policy release-core --keyring "$KEY_RING" --location "$LOCATION"
gcloud kms keys get-iam-policy release-modules --keyring "$KEY_RING" --location "$LOCATION"
```

Each policy lists its two roles for one principal set and nothing else.

## 6. The public keys and their key ids

Agents verify with public keys compiled into them, and the control plane checks uploads with the same keys (PROTOCOL §6.3). Both take the raw 32-byte Ed25519 key, base64. The key id of a KMS key version is `<key>-<version>`; the pipeline derives it from the variable the same way, so the two can't disagree.

```sh
for key in release-core release-modules; do
  gcloud kms keys versions get-public-key 1 \
    --key "$key" --keyring "$KEY_RING" --location "$LOCATION" \
    --output-file "$key-1.pem"
  printf '%s-1  %s\n' "$key" "$(openssl pkey -pubin -in "$key-1.pem" -outform DER | tail -c 32 | base64)"
done
```

The output is two lines like `release-core-1  D/kyP7cKfQ8…=`. They go, with the standby keys of step 7:

- into the agent's production key set, `internal/trust/keys_prod.go` (`embeddedKeys`, each `{ID, PublicKey}`), in the agent build that is released first;
- into the control plane's `RELEASE_KEYS` setting of the production deployment: `{"keys": [{"key_id": "release-core-1", "public_key": "…"}, …]}`.

Every release run also prints the key id and public key it signed with, so you can compare.

## 7. The offline standby keys

The standby keys sign only in an emergency: if a release key leaks or is misused, an agent build signed with the matching standby key revokes it (PROTOCOL §6.3). They are never in KMS and never on a networked machine.

On an offline machine with OpenSSL 3 (a live Linux system booted from USB, say), for each of `standby-core-1` and `standby-modules-1`:

```sh
umask 077
openssl genpkey -algorithm ed25519 -aes-256-cbc -out standby-core-1.pem   # asks for a passphrase
openssl pkey -in standby-core-1.pem -pubout -outform DER | tail -c 32 | base64
```

- Write the encrypted `.pem` files to two USB sticks kept in two places (two safes, two people). Keep the passphrase separately, with two owners, in a password manager.
- Copy only the public keys (the base64 lines) off the machine. They go into the agent and `RELEASE_KEYS` next to the release keys (step 6).
- To sign in an emergency, again offline: write the signed string of PROTOCOL §6.1 without a trailing newline, sign it, and use the base64 as `sig` with `key_id` `standby-core-1`:

  ```sh
  printf 'zutun-artifact-v1\n%s\n%s\n%s\n%s\n%s' agent zutun-agent-linux-amd64 43 <sha256> <size> > signed-string.txt
  openssl pkeyutl -sign -rawin -inkey standby-core-1.pem -in signed-string.txt | base64
  ```

## 8. The GitHub organisation variables

The workflows read these. They are variables, not secrets: none of them grants anything, the trust policy does.

```sh
gh variable set ZUTUN_CONTROL_PLANE_ORIGIN --org "$GITHUB_ORG" --visibility all \
  --body "https://admin.zutun.ch"
gh variable set ZUTUN_WORKLOAD_IDENTITY_PROVIDER --org "$GITHUB_ORG" --visibility all \
  --body "projects/$PROJECT_NUMBER/locations/global/workloadIdentityPools/$POOL/providers/$PROVIDER"
gh variable set ZUTUN_KMS_RELEASE_CORE --org "$GITHUB_ORG" --visibility all \
  --body "projects/$PROJECT_ID/locations/$LOCATION/keyRings/$KEY_RING/cryptoKeys/release-core/cryptoKeyVersions/1"
gh variable set ZUTUN_KMS_RELEASE_MODULES --org "$GITHUB_ORG" --visibility all \
  --body "projects/$PROJECT_ID/locations/$LOCATION/keyRings/$KEY_RING/cryptoKeys/release-modules/cryptoKeyVersions/1"
gh variable list --org "$GITHUB_ORG"
```

| Variable | Value | Read by |
|---|---|---|
| `ZUTUN_CONTROL_PLANE_ORIGIN` | the admin app's origin, `https://<host>` without a slash; the upload token's audience (CONTROL-PLANE §7) | both workflows |
| `ZUTUN_WORKLOAD_IDENTITY_PROVIDER` | the provider's full name, with the project **number** | both workflows |
| `ZUTUN_KMS_RELEASE_CORE` | the `release-core` key **version** | `core.yml` |
| `ZUTUN_KMS_RELEASE_MODULES` | the `release-modules` key **version** | `module.yml` |
| `ZUTUN_STAGING_CONTROL_PLANE_ORIGIN`, `ZUTUN_STAGING_WORKLOAD_IDENTITY_PROVIDER`, `ZUTUN_KMS_STAGING` | step 9; while the first is unset, the staging jobs are skipped | both workflows |

A release that runs before a variable exists stops in its publish job with `The GitHub organisation variable … is not set`, before anything is signed. A key variable that points at the wrong key (a core key for modules, say) is refused too.

## 9. Staging, once there is a staging control plane

Staging gets its own key ring and its own pool. The pool's condition doesn't require the `release` environment, because staging signs without approval (architecture §8, step 5); being a separate pool, its tokens can never use a release key.

```sh
gcloud kms keyrings create zutun-staging --location "$LOCATION"
gcloud kms keys create staging --keyring zutun-staging --location "$LOCATION" \
  --purpose asymmetric-signing --default-algorithm ec-sign-ed25519 --protection-level software

gcloud iam workload-identity-pools create github-staging --location=global \
  --display-name="GitHub release workflows, staging"
gcloud iam workload-identity-pools providers create-oidc github \
  --location=global --workload-identity-pool=github-staging \
  --issuer-uri="https://token.actions.githubusercontent.com" \
  --attribute-mapping="google.subject=assertion.sub" \
  --attribute-condition="assertion.repository_owner == '$GITHUB_ORG' && assertion.repository_owner_id == '$ORG_ID' && assertion.job_workflow_ref in ['$MODULE_WORKFLOW', '$CORE_WORKFLOW'] && assertion.ref.startsWith('refs/tags/v')"

for role in roles/cloudkms.signer roles/cloudkms.publicKeyViewer; do
  gcloud kms keys add-iam-policy-binding staging --keyring zutun-staging --location "$LOCATION" \
    --member="principalSet://iam.googleapis.com/projects/$PROJECT_NUMBER/locations/global/workloadIdentityPools/github-staging/*" \
    --role="$role"
done

gh variable set ZUTUN_STAGING_WORKLOAD_IDENTITY_PROVIDER --org "$GITHUB_ORG" --visibility all \
  --body "projects/$PROJECT_NUMBER/locations/global/workloadIdentityPools/github-staging/providers/github"
gh variable set ZUTUN_KMS_STAGING --org "$GITHUB_ORG" --visibility all \
  --body "projects/$PROJECT_ID/locations/$LOCATION/keyRings/zutun-staging/cryptoKeys/staging/cryptoKeyVersions/1"
# Last, because it switches the staging jobs on:
gh variable set ZUTUN_STAGING_CONTROL_PLANE_ORIGIN --org "$GITHUB_ORG" --visibility all \
  --body "https://<the staging admin origin>"
```

The staging public key (`staging-1`) goes into the agent's staging key set (`keys_staging.go`) and the staging deployment's `RELEASE_KEYS`, never into a production build.

## Operating the keys

**Stop all signing at once** (a suspected compromise of the GitHub side): disable the provider. Nothing can sign until it is enabled again.

```sh
gcloud iam workload-identity-pools providers update-oidc "$PROVIDER" \
  --location=global --workload-identity-pool="$POOL" --disabled
```

**Rotation** (every 2 years, PROTOCOL §6.3):
1. `gcloud kms keys versions create --key release-core --keyring "$KEY_RING" --location "$LOCATION"` creates version 2, whose key id is `release-core-2`. Add its public key (step 6) to the next agent build and to `RELEASE_KEYS`.
2. Once the fleet runs that build, point `ZUTUN_KMS_RELEASE_CORE` at `…/cryptoKeyVersions/2`.
3. A later agent build drops `release-core-1`; then disable version 1 (`gcloud kms keys versions disable 1 --key release-core …`).

**Who signed what:** Logs Explorer, `protoPayload.serviceName="cloudkms.googleapis.com" AND protoPayload.methodName="AsymmetricSign"`. The principal names the repository and the environment of the job.
