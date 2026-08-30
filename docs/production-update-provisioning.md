# Production automatic-update provisioning

This is the command-oriented companion to [update-release-operations.md](./update-release-operations.md). Run it with an Alibaba Cloud administrator identity and a GitHub repository administrator identity. Replace every value inside angle brackets. Do not paste a production private key or password on a command line, because shell history and process inspection can expose it.

## 1. What already exists

The current `main` workflow already signs and notarizes both macOS builds. `.github/workflows/build.yml` imports a Developer ID `.p12`, verifies `APPLE_SIGNING_IDENTITY`, passes the App Store Connect API key to Tauri, signs the DMG, submits it with `notarytool`, staples it, and verifies it with Gatekeeper. GitHub currently reports these repository-level Actions secret names:

```text
APPLE_SIGNING_IDENTITY
APPLE_CERTIFICATE
APPLE_CERTIFICATE_PASSWORD
APPLE_API_KEY
APPLE_API_ISSUER
APPLE_API_PRIVATE_KEY
```

`gh secret list` reveals names and update timestamps, never secret values. The presence of a name proves only that a value was stored; the release workflow is the authoritative end-to-end verification. GitHub documents that environment secrets are available only to jobs that reference that environment and, where approval is configured, only after approval. [GitHub environments](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments)

The feature workflow adds a `production` Environment and two additional updater-signing secrets. At the time this guide was written, `GET /repos/cyunlab/dsh-desktop/environments/production` returned `404`, so the Environment still needs to be created.

## 2. Prerequisites and safe local variables

Authenticate both CLIs and inspect the selected identities before mutating anything:

```bash
gh auth status
aliyun configure list
aliyun sts GetCallerIdentity

export DSH_GH_REPO=cyunlab/dsh-desktop
export DSH_GH_ENV=production
export DSH_OSS_REGION=cn-shenzhen
export DSH_OSS_BUCKET=<globally-unique-public-release-bucket>
export DSH_OIDC_PROVIDER=dsh-desktop-github
export DSH_PUBLISH_ROLE=dsh-desktop-update-publisher
export DSH_PUBLISH_POLICY=dsh-desktop-update-publisher
export DSH_ACCOUNT_ID="$(aliyun sts GetCallerIdentity --output json | jq -r .AccountId)"
```

Alibaba Cloud CLI discovers API parameters from the service API; `aliyun help ims CreateOIDCProvider`, `aliyun help ram CreateRole`, and `aliyun help ram CreatePolicy` show the parameters installed on the administrator's machine. OIDC provider operations are in the `ims` product, not the older `ram` OpenAPI product. [CreateOIDCProvider API](https://help.aliyun.com/zh/ram/developer-reference/api-ims-2019-08-15-createoidcprovider), [Alibaba Cloud CLI overview](https://help.aliyun.com/zh/cli/user-guide/what-is-alibaba-cloud-cli)

Alibaba Cloud CLI 3.4 currently labels its bundled `aliyun oss` compatibility command deprecated. The commands below use it where it has the required operation; the newer bucket-level Block Public Access operation requires the separately installed official ossutil 2 binary. [ossutil overview](https://help.aliyun.com/en/oss/developer-reference/ossutil-overview/)

## 3. Create the OSS bucket

Create a private Standard bucket in Shenzhen, then enable Versioning. A bucket name is globally unique. Keeping the bucket ACL private lets the later prefix-scoped bucket policy be the only anonymous-read grant. Versioning must be enabled before the first Stable write. [ossutil `mb`](https://help.aliyun.com/zh/oss/developer-reference/mb), [OSS Versioning](https://help.aliyun.com/zh/oss/user-guide/overview-80)

```bash
aliyun oss mb "oss://${DSH_OSS_BUCKET}" \
  --region "$DSH_OSS_REGION" \
  --acl private \
  --storage-class Standard \
  --redundancy-type LRS

aliyun oss bucket-versioning --method put \
  "oss://${DSH_OSS_BUCKET}" enabled \
  --region "$DSH_OSS_REGION"

aliyun oss bucket-versioning --method get \
  "oss://${DSH_OSS_BUCKET}" \
  --region "$DSH_OSS_REGION"
```

New OSS buckets have been progressively created with Block Public Access enabled by default since October 13, 2025. Because this release bucket intentionally allows anonymous reads for two narrow path sets, disable Block Public Access at the bucket level before applying the prefix policy; do not disable it account-wide. This command is from ossutil 2, not the deprecated `aliyun oss` wrapper. [OSS `put-bucket-public-access-block`](https://help.aliyun.com/zh/oss/developer-reference/put-bucket-public-access-block)

```bash
ossutil api put-bucket-public-access-block \
  --bucket "$DSH_OSS_BUCKET" \
  --public-access-block-configuration '{"BlockPublicAccess":"false"}' \
  --endpoint oss-cn-shenzhen.aliyuncs.com \
  --region cn-shenzhen
```

Create `dsh-public-read-policy.json` locally with the exact policy from `update-release-operations.md`, replacing `<bucket-name>`, then apply and read it back:

```bash
aliyun oss bucket-policy --method put \
  "oss://${DSH_OSS_BUCKET}" dsh-public-read-policy.json \
  --region "$DSH_OSS_REGION"

aliyun oss bucket-policy --method get \
  "oss://${DSH_OSS_BUCKET}" effective-public-read-policy.json \
  --region "$DSH_OSS_REGION"
```

Do not run `set-acl public-read`. The intended public surface is only `dsh-desktop/releases/*` and `dsh-desktop/channels/stable/latest.json`. OSS bucket policies support granting a principal selected actions on selected resources. [OSS bucket policy](https://help.aliyun.com/zh/oss/developer-reference/bucket-policy)

CORS should remain empty for the native updater. Confirm that no rules exist; do not add a wildcard rule:

```bash
aliyun oss cors --method get "oss://${DSH_OSS_BUCKET}" \
  --region "$DSH_OSS_REGION"
```

A `NoSuchCORSConfiguration` response is the expected initial state. CORS is a browser-enforced cross-origin mechanism; add it later only if an approved browser origin directly fetches update objects. [OSS CORS](https://help.aliyun.com/zh/oss/user-guide/cors)

## 4. Bind `updates.cyunlab.com` without CDN

OSS supports a direct custom-domain CNAME; CDN is optional. First create and retrieve the domain-ownership token:

```bash
aliyun oss bucket-cname --method put --item token \
  "oss://${DSH_OSS_BUCKET}" updates.cyunlab.com \
  --region "$DSH_OSS_REGION"

aliyun oss bucket-cname --method get --item token \
  "oss://${DSH_OSS_BUCKET}" updates.cyunlab.com \
  --region "$DSH_OSS_REGION"
```

Add the returned TXT name/value in Alibaba Cloud DNS, wait for it to resolve, then bind the domain:

```bash
aliyun oss bucket-cname --method put \
  "oss://${DSH_OSS_BUCKET}" updates.cyunlab.com \
  --region "$DSH_OSS_REGION"

aliyun oss bucket-cname --method get \
  "oss://${DSH_OSS_BUCKET}" \
  --region "$DSH_OSS_REGION"
```

Create a DNS CNAME from `updates.cyunlab.com` to `${DSH_OSS_BUCKET}.oss-cn-shenzhen.aliyuncs.com`. The official flow requires domain binding before the CNAME is relied upon. [OSS custom domains](https://help.aliyun.com/zh/oss/user-guide/access-buckets-via-custom-domain-names), [ossutil `bucket-cname`](https://help.aliyun.com/zh/oss/developer-reference/bucket-cname)

For HTTPS without CDN, host a certificate for `updates.cyunlab.com` directly on the OSS CNAME. `bucket-cname --method put --item certificate` accepts the certificate XML described in the ossutil reference. Keep the private key file outside the repository and delete the local working copy after successful verification:

```bash
aliyun oss bucket-cname --method put --item certificate \
  "oss://${DSH_OSS_BUCKET}" oss-cname-certificate.xml \
  --region "$DSH_OSS_REGION"

curl --silent --show-error --head \
  https://updates.cyunlab.com/dsh-desktop/channels/stable/latest.json
```

The last command should return `404` before the first manifest exists, but must complete a valid TLS handshake. A custom domain served directly by OSS requires certificate hosting in OSS; the default bucket endpoint already has Alibaba-managed HTTPS. [OSS HTTPS](https://help.aliyun.com/zh/oss/user-guide/access-oss-by-https-protocol)

## 5. Create the GitHub OIDC provider

This repository was created after GitHub's immutable-subject rollout. Its Environment-bound subject prefix currently reports owner ID `318327647` and repository ID `1335996339`, so the expected production subject is `repo:cyunlab@318327647/dsh-desktop@1335996339:environment:production`. Verify the actual claim before the first OSS write and put that exact value in the trust policy. Do not use a wildcard. [GitHub OIDC subject reference](https://docs.github.com/en/actions/reference/security/oidc)

The provider values expected by this repository are:

```text
Issuer URL: https://token.actions.githubusercontent.com
Client ID / audience: sts.aliyuncs.com
Provider name: dsh-desktop-github
```

Obtain the current SHA-1 fingerprint of the HTTPS CA certificate chain during provisioning and verify it against the displayed GitHub chain. Do not copy a historical fingerprint from this guide. Then create and inspect the provider:

```bash
export DSH_GITHUB_CA_SHA1=<current-uppercase-or-lowercase-hex-without-colons>

aliyun ims CreateOIDCProvider \
  --OIDCProviderName "$DSH_OIDC_PROVIDER" \
  --IssuerUrl https://token.actions.githubusercontent.com \
  --ClientIds sts.aliyuncs.com \
  --Fingerprints "$DSH_GITHUB_CA_SHA1" \
  --IssuanceLimitTime 1 \
  --Description 'GitHub Actions for cyunlab/dsh-desktop production'

aliyun ims GetOIDCProvider \
  --OIDCProviderName "$DSH_OIDC_PROVIDER"
```

Alibaba Cloud requires the issuer URL, client ID, and HTTPS CA fingerprint when creating an OIDC provider. [Alibaba Cloud CreateOIDCProvider](https://help.aliyun.com/zh/ram/developer-reference/api-ims-2019-08-15-createoidcprovider)

## 6. Create the prefix-scoped publishing role

Create `dsh-role-trust.json` using the trust-policy shape in `update-release-operations.md`. Its principal must be:

```text
acs:ram::<account-id>:oidc-provider/dsh-desktop-github
```

and its `StringEquals` conditions must contain the exact `oidc:iss`, `oidc:aud`, and observed `oidc:sub`. Alibaba Cloud's role API documents OIDC providers under `Principal.Federated` and supports OIDC claim conditions. [CreateRole OIDC example](https://help.aliyun.com/en/ram/developer-reference/api-ram-2015-05-01-createrole)

Create `dsh-role-permissions.json` using the least-privilege policy in `update-release-operations.md`; replace `<bucket-name>`. Create the role, create the custom policy, attach it, and inspect both:

```bash
aliyun ram CreateRole \
  --RoleName "$DSH_PUBLISH_ROLE" \
  --Description 'Publish signed dsh-desktop updates only' \
  --MaxSessionDuration 3600 \
  --AssumeRolePolicyDocument "$(jq -c . dsh-role-trust.json)"

aliyun ram CreatePolicy \
  --PolicyName "$DSH_PUBLISH_POLICY" \
  --Description 'OSS dsh-desktop prefix and promotion lock only' \
  --PolicyDocument "$(jq -c . dsh-role-permissions.json)"

aliyun ram AttachPolicyToRole \
  --PolicyType Custom \
  --PolicyName "$DSH_PUBLISH_POLICY" \
  --RoleName "$DSH_PUBLISH_ROLE"

aliyun ram GetRole --RoleName "$DSH_PUBLISH_ROLE"
aliyun ram GetPolicy --PolicyType Custom --PolicyName "$DSH_PUBLISH_POLICY"
aliyun ram ListPoliciesForRole --RoleName "$DSH_PUBLISH_ROLE"
```

The resulting values for GitHub are:

```bash
export DSH_OIDC_PROVIDER_ARN="acs:ram::${DSH_ACCOUNT_ID}:oidc-provider/${DSH_OIDC_PROVIDER}"
export DSH_PUBLISH_ROLE_ARN="acs:ram::${DSH_ACCOUNT_ID}:role/${DSH_PUBLISH_ROLE}"
```

RAM roles have no long-lived credential; GitHub's `id-token: write` permission only allows requesting an OIDC token, and Alibaba Cloud's official action exchanges it for temporary credentials. [GitHub OIDC cloud-provider guide](https://docs.github.com/en/actions/how-tos/secure-your-work/security-harden-deployments/oidc-in-cloud-providers), [official Alibaba Cloud credentials action](https://github.com/aliyun/configure-aliyun-credentials-action)

## 7. Create and protect the GitHub Environment

Resolve the required reviewer to a numeric GitHub user ID, then create the Environment. `prevent_self_review: true` prevents the workflow initiator from approving their own protected deployment. GitHub allows up to six user/team reviewers and only one approval is required. On GitHub Free/Pro/Team, required reviewers are available only for public repositories. `cyunlab/dsh-desktop` currently reports `visibility: public`, so this repository satisfies that visibility condition; still treat the actual API response as the account-plan capability check. [GitHub environment protection rules](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments), [Environment REST API](https://docs.github.com/en/rest/deployments/environments)

```bash
export DSH_REVIEWER_LOGIN=<github-login>
export DSH_REVIEWER_ID="$(gh api "users/${DSH_REVIEWER_LOGIN}" --jq .id)"

jq -n --argjson reviewer "$DSH_REVIEWER_ID" '{
  wait_timer: 0,
  prevent_self_review: true,
  reviewers: [{type: "User", id: $reviewer}],
  deployment_branch_policy: null
}' | gh api --method PUT \
  "repos/${DSH_GH_REPO}/environments/${DSH_GH_ENV}" \
  --input -

gh api "repos/${DSH_GH_REPO}/environments/${DSH_GH_ENV}" \
  --jq '{name, protection_rules, deployment_branch_policy}'
```

The release workflow validates that the tag commit belongs to `main`, so the Environment does not need to guess a tag branch pattern. The required reviewer remains the human production gate.

## 8. Set Environment variables and updater secrets

Set public/non-secret values with `gh variable set --env`. The CLI accepts standard input when `--body` is omitted. [GitHub CLI `gh variable set`](https://cli.github.com/manual/gh_variable_set)

```bash
printf '%s' "$DSH_OIDC_PROVIDER_ARN" | gh variable set ALIBABA_CLOUD_OIDC_PROVIDER_ARN --env production --repo "$DSH_GH_REPO"
printf '%s' "$DSH_PUBLISH_ROLE_ARN" | gh variable set ALIBABA_CLOUD_ROLE_ARN --env production --repo "$DSH_GH_REPO"
printf '%s' "$DSH_OSS_BUCKET" | gh variable set OSS_BUCKET --env production --repo "$DSH_GH_REPO"
printf '%s' cn-shenzhen | gh variable set OSS_REGION --env production --repo "$DSH_GH_REPO"
printf '%s' https://updates.cyunlab.com | gh variable set UPDATE_BASE_URL --env production --repo "$DSH_GH_REPO"
gh variable set TAURI_SIGNING_PUBLIC_KEY --env production --repo "$DSH_GH_REPO" < <public-updater-key-file>
```

Set the updater private key and password as Environment secrets. Do not pass their contents with `--body`. [GitHub CLI `gh secret set`](https://cli.github.com/manual/gh_secret_set)

```bash
gh secret set TAURI_SIGNING_PRIVATE_KEY --env production --repo "$DSH_GH_REPO" < <private-updater-key-file>
gh secret set TAURI_SIGNING_PRIVATE_KEY_PASSWORD --env production --repo "$DSH_GH_REPO"
```

Set the one-time bootstrap approval variables only after the approved tag, version, commit, legacy-manifest digest, and Apple-signing decision are fixed:

```bash
printf '%s' '<v-semver>' | gh variable set UPDATER_BOOTSTRAP_TAG --env production --repo "$DSH_GH_REPO"
printf '%s' '<semver>' | gh variable set UPDATER_BOOTSTRAP_VERSION --env production --repo "$DSH_GH_REPO"
printf '%s' '<40-char-lowercase-commit>' | gh variable set UPDATER_BOOTSTRAP_COMMIT --env production --repo "$DSH_GH_REPO"
printf '%s' '<legacy-semver>' | gh variable set UPDATER_BOOTSTRAP_LEGACY_VERSION --env production --repo "$DSH_GH_REPO"
printf '%s' '<64-char-lowercase-sha256>' | gh variable set UPDATER_BOOTSTRAP_LEGACY_MANIFEST_SHA256 --env production --repo "$DSH_GH_REPO"
printf '%s' true | gh variable set UPDATER_BOOTSTRAP_MACOS_SIGNING_CONFIGURED --env production --repo "$DSH_GH_REPO"
```

Confirm names and public values without reading secrets:

```bash
gh variable list --env production --repo "$DSH_GH_REPO"
gh secret list --env production --repo "$DSH_GH_REPO"
```

## 9. Reuse the existing Apple signing configuration

The six Apple secrets already exist at repository scope, and jobs referencing an Environment can still read repository secrets. No migration is technically required. Keeping the existing repository secrets preserves the current `main` release workflow. Confirm only names/timestamps:

```bash
gh secret list --repo "$DSH_GH_REPO" | grep '^APPLE_'
```

The expected list is the six names in section 1. Then run a controlled release build and verify these workflow steps succeed on both macOS runners:

```text
Import Developer ID certificate and notarization key
Sign, notarize, and staple macOS package
```

Finally download the produced DMG and verify its trust metadata on macOS:

```bash
codesign --verify --strict --verbose=2 <downloaded.dmg>
xcrun stapler validate <downloaded.dmg>
spctl --assess --type open --context context:primary-signature --verbose=4 <downloaded.dmg>
```

If stricter Environment scoping is desired later, copy the same six values into `production` with `gh secret set NAME --env production`; environment secrets override repository secrets with the same name. Do this only from the original secret material because GitHub never allows reading secret values back. [GitHub Actions secret precedence and environment secrets](https://docs.github.com/en/actions/security-for-github-actions/security-guides/using-secrets-in-github-actions)

## 10. Final preflight

Before dispatching bootstrap, verify all of the following:

```bash
aliyun oss stat "oss://${DSH_OSS_BUCKET}" --region "$DSH_OSS_REGION"
aliyun ims GetOIDCProvider --OIDCProviderName "$DSH_OIDC_PROVIDER"
aliyun ram GetRole --RoleName "$DSH_PUBLISH_ROLE"
aliyun ram ListPoliciesForRole --RoleName "$DSH_PUBLISH_ROLE"
gh api "repos/${DSH_GH_REPO}/environments/production" --jq .protection_rules
gh variable list --env production --repo "$DSH_GH_REPO"
gh secret list --env production --repo "$DSH_GH_REPO"
gh secret list --repo "$DSH_GH_REPO" | grep '^APPLE_'
```

Do not configure `ALIBABA_CLOUD_ACCESS_KEY_ID` or `ALIBABA_CLOUD_ACCESS_KEY_SECRET` in GitHub. Do not dispatch the bootstrap until the observed GitHub OIDC claims match the role trust policy exactly, anonymous `GET` works only for the intended paths, anonymous listing/write fail, TLS validates on `updates.cyunlab.com`, and the required-reviewer prompt appears before either OSS-writing job obtains credentials.
