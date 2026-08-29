# Automatic update release operations

This runbook provisions and operates the production release path for Desktop automatic updates. It is intentionally fail-closed: immutable packages are uploaded and checked first, and `dsh-desktop/channels/stable/latest.json` is replaced only after every target passes validation.

> **Current status:** the Alibaba Cloud resources, GitHub `production` Environment, DNS mapping, TLS certificate, and production updater signing key described below are **尚未实际创建或验证**. Repository automation can be reviewed and tested with its fake OSS adapter, but no real OSS promotion smoke test has succeeded yet. Do not interpret this document as evidence that production is live.

## Ownership boundary

Repository automation owns these steps after the external resources exist:

- builds the four updater targets and their mandatory Tauri signatures;
- creates a GitHub Draft Release for a tag without changing Stable;
- on the GitHub Release `published` event, first exchanges GitHub OIDC identity only to upload and verify immutable candidate objects and an isolated candidate manifest;
- runs the previous-Stable-to-candidate smoke workflow on all four native targets and rejects missing, duplicate, failed, stale, mock, or candidate-mismatched evidence;
- only after aggregate evidence admission, exchanges a second short-lived OIDC identity and writes the Stable manifest last;
- copies release notes only from the published GitHub Release body.

An Alibaba Cloud administrator and a GitHub repository administrator must manually create and verify:

- one shared, public-release OSS bucket in `cn-shenzhen`;
- OSS Versioning, anonymous read policy, custom domain, TLS certificate, and the CORS decision described below;
- one GitHub OIDC provider in RAM and one `dsh-desktop/` prefix-scoped RAM role;
- the GitHub `production` Environment, its variables, secrets, and deployment protection rules;
- the updater signing key and its independently stored 离线加密备份 (offline encrypted backup).

Do not put private business data in this bucket. It is a shared public-release bucket: future applications may use separate top-level prefixes, while Desktop owns only `dsh-desktop/`.

## Required GitHub Environment configuration

Create an Environment named exactly `production`. Configure required reviewers or other deployment protection appropriate to the organization. Build matrix jobs may reference `production` only to read updater signing material and embed the trusted Stable endpoint/public key. In the normal path, exactly two OSS jobs consume Alibaba Cloud OIDC provider/role variables: `prepare-candidate` may write only content-addressed immutable objects and the isolated candidate manifest, while `promote-stable` runs only after aggregate evidence admission and may replace the Stable pointer. The separately dispatched one-time bootstrap likewise has only a preparation job and a final receipt/Stable job with OSS identity. Native smoke jobs receive no id-token permission. Evidence admission jobs may use GitHub's token to verify artifact attestations, but they must not consume Alibaba Cloud OIDC variables or receive Alibaba Cloud credentials.

Set these Environment variables exactly as shown:

| Variable | Required value |
| --- | --- |
| `ALIBABA_CLOUD_OIDC_PROVIDER_ARN` | ARN of the GitHub OIDC provider, for example `acs:ram::<account-id>:oidc-provider/<provider-name>` |
| `ALIBABA_CLOUD_ROLE_ARN` | ARN of the prefix-scoped publishing role, for example `acs:ram::<account-id>:role/<role-name>` |
| `OSS_BUCKET` | Name of the shared public-release bucket; use only the bucket name, with no scheme or path |
| `OSS_REGION` | `cn-shenzhen` |
| `UPDATE_BASE_URL` | `https://updates.cyunlab.com` with no trailing slash |
| `TAURI_SIGNING_PUBLIC_KEY` | Entire minisign public-key content used by promotion; it must exactly match the public key embedded in Desktop |
| `UPDATER_BOOTSTRAP_TAG` | Exact one-time approved first-updater tag, for example `v2.1.0`; remove or retain read-only after bootstrap, but never repurpose |
| `UPDATER_BOOTSTRAP_VERSION` | Exact semantic version matching `UPDATER_BOOTSTRAP_TAG` |
| `UPDATER_BOOTSTRAP_COMMIT` | Exact 40-character lowercase Git commit resolved by the approved tag |
| `UPDATER_BOOTSTRAP_LEGACY_MANIFEST_SHA256` | Lowercase SHA-256 of the byte-exact authoritative 2.0.15 OSS Stable manifest captured during approval |

Set these Environment secrets exactly as shown:

| Secret | Required value |
| --- | --- |
| `TAURI_SIGNING_PRIVATE_KEY` | Entire password-protected Tauri updater private-key content, never a public URL or OSS object |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Password that decrypts the updater private key during trusted builds |

The promotion workflow also uses GitHub's short-lived built-in `GITHUB_TOKEN`; do not create a replacement personal access token. Never configure a long-lived Alibaba Cloud AccessKey in GitHub.

Before enabling promotion, confirm that Environment variables are not secrets and contain no private key, password, AccessKey, or reusable STS token. Confirm that Actions log masking is effective by running a deliberately failing non-production test with synthetic values, never the production key.

## Provision the OSS release bucket

1. Create or select a bucket in `cn-shenzhen`. The bucket may serve multiple public applications, but reserve the complete `dsh-desktop/` namespace for this repository.
2. Enable **OSS Versioning** before the first promotion. Do not configure lifecycle rules that delete or expire `dsh-desktop/releases/` objects or historical versions of `dsh-desktop/channels/stable/latest.json`.
3. Do not configure an OSS prevent-overwrite rule or `x-oss-forbid-overwrite`. OSS ignores these protections when bucket Versioning is enabled or suspended, so they cannot enforce release immutability here. Versioning remains enabled because promotion and recovery intentionally create recoverable versions of `dsh-desktop/channels/stable/latest.json`; release immutability instead comes from the content-addressed object keys described below.
4. Keep writes private. Grant anonymous users read-only access only to `dsh-desktop/releases/*` and `dsh-desktop/channels/stable/latest.json`; never grant public write. A bucket-level `public-read` ACL is broader than required, so prefer a prefix-scoped bucket policy.
5. Bind the ICP-filed domain `updates.cyunlab.com` to the bucket and add its DNS CNAME to the OSS public endpoint for `cn-shenzhen`. Upload and bind a valid TLS certificate in OSS. CDN is not required for the first release.
6. Test anonymous HTTPS `GET` and `HEAD` for a disposable object under `dsh-desktop/releases/`, then remove only that disposable object. Confirm anonymous listing of the bucket is denied and anonymous writes are denied.
7. CORS is not required by the native Tauri updater because it does not use browser cross-origin fetch. Leave the bucket CORS rules empty initially. If a future browser surface reads this origin directly, add a rule only for the exact approved web origin with `GET` and `HEAD`; do not use `*`, and do not enable write methods.

The public-read bucket policy should express this shape after placeholders are replaced in the Alibaba Cloud console:

```json
{
  "Version": "1",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": ["*"],
      "Action": ["oss:GetObject"],
      "Resource": [
        "acs:oss:*:*:<bucket-name>/dsh-desktop/releases/*",
        "acs:oss:*:*:<bucket-name>/dsh-desktop/channels/stable/latest.json"
      ]
    }
  ]
}
```

Verify the policy in the console before saving it. Alibaba Cloud policy editors may normalize the document representation; the effective access, rather than formatting, is authoritative.

## Configure GitHub OIDC and the publishing RAM role

Create a RAM OIDC provider with:

- issuer URL `https://token.actions.githubusercontent.com`;
- client ID/audience `sts.aliyuncs.com`, matching the default audience used by the official Alibaba Cloud credential action;
- GitHub's current OIDC thumbprint/certificate information obtained during provisioning, not copied from an old runbook.

Create a RAM role whose trusted principal is only that OIDC provider. Its trust conditions must use exact string comparison for:

- `oidc:iss` = `https://token.actions.githubusercontent.com`;
- `oidc:aud` = `sts.aliyuncs.com`;
- `oidc:sub` = `repo:cyunlab/dsh-desktop:environment:production`.

The `sub` value is case-sensitive and depends on GitHub's active subject format. Before the first production run, request a token from a diagnostic job that references the `production` Environment but has no OSS permission, decode only the non-secret JWT claims, and verify that the observed `iss`, `aud`, and `sub` exactly match the RAM trust policy. GitHub repositories using immutable subject claims have a different `sub` format containing repository identifiers; if this repository opts into that format, update the RAM trust condition to the exact observed immutable subject before running promotion. Never broaden the condition to a wildcard repository, branch, pull request, or Environment.

Attach a custom permission policy to the role. Replace `<bucket-name>` and keep both object access and bucket listing restricted to Desktop's prefix:

```json
{
  "Version": "1",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["oss:GetObject", "oss:PutObject"],
      "Resource": ["acs:oss:*:*:<bucket-name>/dsh-desktop/*"]
    },
    {
      "Effect": "Allow",
      "Action": ["oss:ListObjects"],
      "Resource": ["acs:oss:*:*:<bucket-name>"],
      "Condition": {
        "StringLike": {
          "oss:Prefix": ["dsh-desktop", "dsh-desktop/*"]
        }
      }
    }
  ]
}
```

Do not grant `oss:*`, bucket administration, object deletion, lifecycle administration, RAM administration, or access to another top-level prefix. The role needs no long-lived credential. The official `aliyun/configure-aliyun-credentials-action` exchanges the GitHub token using `ALIBABA_CLOUD_OIDC_PROVIDER_ARN` and `ALIBABA_CLOUD_ROLE_ARN`, then exports temporary STS credentials for the OSS tooling.

## Create and protect the updater signing key

Tauri updater signatures and operating-system publisher signatures are separate trust systems. The updater signature is mandatory even while Windows NSIS artifacts remain unsigned by Authenticode.

1. On an offline or tightly controlled administrator machine, use the pinned repository Tauri CLI to generate a password-protected updater key pair. Do not generate it on a shared shell, paste it into chat, or save it inside this repository.
2. Store the public key in the Desktop updater configuration and copy the exact same content to the public `TAURI_SIGNING_PUBLIC_KEY` Environment variable. Public-key contents may be committed; a file path is not accepted by Tauri's updater configuration. Promotion must fail if the Environment value differs from the public key embedded in Desktop.
3. Store the complete private-key content in `TAURI_SIGNING_PRIVATE_KEY` and its password in `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` in the GitHub `production` Environment. Tauri build reads these environment variables and emits each updater package plus its `.sig` file.
4. Create at least one offline encrypted backup of the private key and password. Store the backup and its recovery material separately, under access control and audit appropriate to a release root of trust. Record responsible maintainers and test restoration on a disposable isolated copy without exposing the production key.
5. Never upload the private key or password to GitHub Release assets, Actions artifacts/caches, OSS, logs, issue comments, or support bundles. Signature files and the public key are safe to distribute.

Loss of the private key prevents installed clients from accepting future releases. Suspected disclosure is an incident: stop publication, preserve logs, and do not simply replace the embedded public key. Planned rotation requires an old-key-signed bridge release that embeds the successor public key before automation signs later releases with the successor key.

## Release and Stable promotion

The object layout is fixed:

```text
dsh-desktop/
  releases/<semver>/<target>/<sha256-prefix>-<artifact-basename>
  candidates/<semver>/<candidate-commit>/<manifest-sha256>-latest.json
  channels/stable/latest.json
```

Every updater package and signature object uses a basename prefixed with the lowercase SHA-256 digest of that object's complete bytes. Different bytes therefore always produce a different OSS key under the same `releases/<semver>/<target>/` directory. The implementation may use the documented fixed-length `<sha256-prefix>` rather than the entire digest, but it must derive that prefix from the complete object bytes and use the same deterministic length for every object.

Immutable release objects use a long immutable cache policy and are retained permanently. The publishing RAM role has no delete permission. The Stable manifest uses `Cache-Control: no-cache`. Its platform entries contain public HTTPS URLs for the content-addressed packages and the literal contents of each `.sig` file, not a signature filename or URL.

Release procedure:

1. Create and push the approved version tag. Wait for all four targets: Windows x64 NSIS EXE, Linux x64 AppImage, macOS arm64 app archive, and macOS x64 app archive.
2. Confirm every updater package has a matching non-empty signature and that existing macOS signing/notarization checks remain green.
3. Confirm the workflow created a GitHub **Draft Release**. A Draft does not promote and must not change `dsh-desktop/channels/stable/latest.json`.
4. Review the Draft asset set and release body. The body is the sole source of Stable release notes; correct it before publication.
5. Publish the GitHub Release. Candidate preparation verifies the exact Windows `.exe`, Linux `.AppImage`, and two macOS `.app.tar.gz` updater files, their platform magic, and their minisign signatures before uploading them. The embedded public key must be identical to `TAURI_SIGNING_PUBLIC_KEY`.
6. Candidate preparation reads the authoritative current OSS Stable manifest, records its URL, version, and SHA-256 in candidate metadata, then uses its first short-lived OIDC session only to upload and remotely re-read content-addressed release objects and an isolated immutable candidate manifest. It never calls the Stable replacement operation.
7. The reusable native smoke workflow consumes that isolated OSS manifest once and runs its internal four-target matrix on Windows x64, Linux x64 AppImage, macOS arm64, and macOS x64. Its aggregate verifier requires exactly those four real-native evidence documents, matching candidate tag, commit, manifest digest, previous Stable identity, and freshness. Fixture or mock evidence is never production admission evidence.
8. `aggregate-evidence` runs the verifier with `--require-real-native`. `promote-stable` downloads and reverifies the same evidence before its second OIDC exchange; therefore any missing, duplicate, failed, stale, or mismatched evidence prevents final credential exchange and Stable mutation.
9. Immediately before replacement, final promotion re-reads both the immutable candidate manifest and the authoritative Stable pointer. Either digest changing after candidate preparation fails closed. The byte-identical candidate manifest is then written to `dsh-desktop/channels/stable/latest.json` as the final OSS mutation with `Cache-Control: no-cache`.
10. Independently fetch the manifest and all target URLs through `https://updates.cyunlab.com`. Verify HTTPS, version, release notes, RFC 3339 publication timestamp, literal signatures, cache headers, and a real update path on every target before recording production readiness.

### One-time first updater bootstrap

The current 2.0.15 Stable application was not built with the automatic updater and cannot produce truthful previous-Stable-to-candidate evidence. The normal published-release workflow therefore remains blocked for the first updater-capable release. It is not weakened or bypassed.

After the four official candidate packages exist on one published GitHub Release, capture the byte-exact authoritative 2.0.15 Stable manifest digest and configure the four `UPDATER_BOOTSTRAP_*` Environment variables above. A repository administrator may then manually dispatch `Bootstrap first updater Stable`. The dispatcher must enter the exact approved `v<semver>` tag, matching semantic version, and 40-character lowercase Git commit. The workflow requires those inputs to match the protected Environment values byte-for-byte. Both OSS-writing jobs reference the GitHub `production` Environment; configure required reviewers so a human reviews this identity before credentials are issued. The workflow refuses a Draft Release, tag/commit drift, a Stable pointer other than the configured byte-exact 2.0.15 manifest, or any object under `dsh-desktop/bootstrap/receipts/`.

The reusable bootstrap smoke workflow fresh-installs and launches the official published Windows x64 current-user NSIS EXE, Linux x64 AppImage, macOS arm64 archive, and macOS x64 archive. Its distinct `bootstrap-fresh-install` evidence proves package/signature/manifest identity, updater configuration, installed version, launch, Runtime closure, Official Node, Desktop capability package, update client, and composition patch. It explicitly records `claims_previous_stable_upgrade: false`. This evidence cannot pass `verify-update-smoke-evidence.mjs --require-real-native` and must never be described as 2.0.15 upgrade evidence.

Finalization downloads and re-verifies the attested four-target evidence, then exchanges the final OIDC identity. The publisher re-reads the byte-exact candidate, legacy Stable pointer, evidence set, and absence of any receipt before its first mutation. It writes `dsh-desktop/bootstrap/receipts/<receipt-sha256>-first-updater-stable.json` with immutable caching, reads it back byte-for-byte, re-reads all admission inputs, and replaces `channels/stable/latest.json` last. The receipt binds the approved tag/version/commit, candidate and legacy manifest digests, and an exact evidence-set digest.

This workflow is used exactly once. Once Stable is updater-capable, all later releases use normal previous-Stable real-native validation. Never change the configured approved identity during a run, manually edit Stable, delete a receipt, or reuse bootstrap for a later release.

Never manually edit Stable to point at a partly uploaded release. Never reuse a version path or overwrite an immutable package.

## Native automatic-update smoke evidence

Stable promotion must consume the versioned contract in `docs/update-smoke-evidence-v1.schema.json` through the public verifier `scripts/verify-update-smoke-evidence.mjs --require-real-native`. Exactly one document is required for Windows x64, Linux x64 AppImage, macOS arm64, and macOS x64. Every JSON file has a byte-exact `.sha256` companion. The checksum detects accidental or later byte changes; it is not by itself a signature. The reusable `.github/workflows/update-smoke.yml` additionally binds uploaded evidence to the trusted workflow identity with GitHub artifact attestations and retains the aggregate artifact for 30 days.

The authoritative previous Stable is the version and target entry fetched from the configured OSS Stable `latest.json`, not GitHub's latest-release selection. Evidence binds that manifest digest, its exact immutable package URL, literal paired updater signature digest, package digest, previous tag/version, and the Git commit resolved for that tag. Candidate evidence independently binds the isolated manifest digest, tag, version, commit, package digest, and signature digest. Missing, duplicate, stale, failed, mismatched, oversized, or tampered evidence fails closed.

`real-native` means a matching hosted runner installed the exact package selected by the OSS Stable manifest and obtained every checkpoint from repository-owned observation of the real process, filesystem, network, and application surfaces. A source rebuild with an isolated compile-time endpoint is useful development evidence but is labelled `source-rebuild`; fixture adapters are labelled `local-fixture`. Neither is accepted by `--require-real-native`.

The required native observations include both update exit modes and all guard paths:

- available → downloaded → staged → user-opened → explicit restart → confirmed Host cleanup → install → relaunch → candidate version and fixed Host origin ready;
- normal operating-system close with a staged update → confirmed Host cleanup → install without automatic relaunch, followed by a separately observed manual launch;
- bad and missing signatures, missing target, unreachable immutable object, tampered staged package, and failed Host cleanup all block installation;
- manual check and background-download-off remain functional;
- the installed candidate contains the Official Node executable, complete published CLI Runtime closure, both private Desktop packages, composition patch, and a working trusted updater configuration.

Windows evidence additionally requires an NSIS EXE installed under the current user (`HKCU` and a user-profile location), no MSI, and no assumption that Authenticode exists. Linux requires executable AppImage replacement at the same path with a changed package digest. macOS requires a native-architecture application archive; when production Apple credentials are configured, the runner must observe strict code-signature verification, Gatekeeper assessment, and notarization/stapling rather than only reading workflow configuration.

### Bootstrap evidence limitation

The current previous Stable, `2.0.15`, predates the automatic updater. Its published binary therefore cannot discover an isolated candidate manifest or exercise either install path. The updater endpoint is also compiled into the binary. Rebuilding the `2.0.15` source with another endpoint would be `source-rebuild` evidence, not evidence for the published Stable artifact.

The repository-owned native driver currently stops after verifying the real runner identity and reports this limitation. It does not emit evidence. This is an unimplemented internal test capability, not an external credential or runner configuration problem. Normal close can be automated through operating-system close plus process, staging, port, replacement, and manual-relaunch observations, but that observation code is not yet implemented in the production driver. The packaged explicit Restart action also has no durable native automation entry. Rust unit tests and debug-only WDIO hooks do not satisfy this production evidence contract.

The separately reviewed one-time bootstrap admits only fresh-install evidence; it does not fabricate the missing 2.0.15 update lifecycle. Its native driver remains fail-closed until each target can produce the complete fresh-install contract. Until all four real runners emit valid bootstrap evidence, first-updater Stable promotion remains blocked. After bootstrap succeeds, normal Stable promotion remains blocked until its real previous-Stable driver implements both install paths and all required checkpoints.

## Failure handling and recovery

### Failure before the manifest write

Leave the previous Stable manifest untouched. Diagnose and rerun the same immutable publication only if every existing content-addressed object is byte-for-byte identical to the expected object and its signature verifies. Different bytes use a different content-addressed key, but changing release contents after publication still requires a higher semantic version. Never overwrite or delete a released object.

For the first-updater bootstrap, the rule is stricter. A failure before the receipt write may be retried only with the same approved tag, version, commit, byte-identical candidate, unchanged 2.0.15 Stable pointer, and newly admitted complete evidence. A failure during or after receipt creation is a partial bootstrap record and must not be retried. Preserve the receipt, candidate, evidence artifacts, workflow logs, and current Stable version for investigation. Do not delete or rename the receipt. If Stable was not changed, repair the release process and publish a higher version through a separately reviewed recovery decision; if Stable was changed, follow bad-release recovery below.

### Bad release after promotion

1. Stop further uptake by restoring the prior version of `dsh-desktop/channels/stable/latest.json` using OSS Versioning. Preserve the bad release's immutable objects and the overwritten manifest version for investigation.
2. Fetch `latest.json` anonymously through `updates.cyunlab.com` and verify its version and target URLs match the restored manifest.
3. Do not attempt an automatic downgrade for clients that already installed the bad version. Build, validate, and publish a fix with a higher semantic version.
4. Do not delete GitHub Release assets or OSS release objects as a recovery mechanism. Permanent retention keeps audits and already-issued URLs reproducible.

### Credential or key incident

Disable the `production` Environment or publishing role first. Revoke or tighten the RAM trust/policy as appropriate. STS credentials expire and must not be treated as reusable secrets. For updater private-key disclosure, follow the bridge-release constraints above and obtain a security review before re-enabling promotion.

## Go-live checklist

- [ ] Bucket exists in `cn-shenzhen`; Versioning is enabled for Stable manifest recovery, no incompatible prevent-overwrite rule/header is configured, and no deletion lifecycle affects `dsh-desktop/`.
- [ ] Anonymous `GET`/`HEAD` works only for public release objects; anonymous list/write fails.
- [ ] `updates.cyunlab.com` CNAME and TLS certificate are valid; HTTP is not used by Desktop.
- [ ] CORS is empty unless an exact browser origin has a documented need for read-only `GET`/`HEAD`.
- [ ] RAM trust matches the observed `iss`, `aud`, and exact `production` Environment `sub` claim.
- [ ] RAM permissions cannot read, write, list, delete, or administer outside the required `dsh-desktop/` scope.
- [ ] The publishing RAM role has no object delete permission and immutable release objects are retained permanently.
- [ ] Every package and signature basename starts with its deterministic SHA-256 prefix; same-key retries verify byte-for-byte identity before reuse.
- [ ] All normal Environment variables, the four fixed `UPDATER_BOOTSTRAP_*` approval variables, and both Environment secrets use the exact names in this runbook.
- [ ] `TAURI_SIGNING_PUBLIC_KEY` matches both the protected private key and the public key embedded in Desktop; offline encrypted restore has been tested.
- [ ] Promotion verifies all four updater packages with minisign before writing OSS.
- [ ] Windows builds explicitly use NSIS `currentUser`; all four binaries embed the production Stable endpoint and the same updater public key used by promotion.
- [ ] Candidate preparation binds the authoritative previous Stable URL/version/digest, uploads only immutable objects, and leaves Stable unchanged.
- [ ] Aggregate and final admission both require exact fresh real-native evidence before final OIDC exchange.
- [ ] Draft creation leaves Stable unchanged; every candidate, smoke, evidence, credential, or revalidation failure also leaves Stable unchanged.
- [ ] A successful published-release smoke has passed on all four targets and its evidence is recorded.
- [ ] The manually dispatched one-time bootstrap is protected by `production` required reviewers and binds the exact approved tag/version/commit.
- [ ] Authoritative Stable is still byte-identical version 2.0.15 and the bootstrap receipt prefix is empty before dispatch.
- [ ] All four attested `bootstrap-fresh-install` documents pass the dedicated verifier without claiming a previous-Stable upgrade.
- [ ] The content-digested immutable bootstrap receipt is byte-verified before Stable is written last; any partial receipt is preserved and blocks reuse.
- [ ] The four evidence documents pass `verify-update-smoke-evidence.mjs --require-real-native`, and their GitHub artifact attestations verify against this repository and workflow run.
- [ ] The evidence baseline is the exact OSS Stable manifest target, not a source rebuild, fixture, or GitHub latest-release guess.

Until every checkbox is complete, production automatic updates remain not configured or not verified.

## Primary references

- [GitHub Actions OpenID Connect reference](https://docs.github.com/en/actions/reference/security/oidc)
- [GitHub: Configuring OIDC in cloud providers](https://docs.github.com/en/actions/how-tos/secure-your-work/security-harden-deployments/oidc-in-cloud-providers)
- [Alibaba Cloud official credentials action](https://github.com/aliyun/configure-aliyun-credentials-action)
- [Alibaba Cloud RAM role-based OIDC overview](https://www.alibabacloud.com/help/en/ram/overview-of-oidc-based-sso)
- [Alibaba Cloud: AssumeRoleWithOIDC](https://www.alibabacloud.com/help/en/ram/developer-reference/api-sts-2015-04-01-assumerolewithoidc)
- [Alibaba Cloud: Control OSS access with RAM policies](https://www.alibabacloud.com/help/en/oss/user-guide/access-control-base-on-ram-policy)
- [Alibaba Cloud: OSS custom domains](https://www.alibabacloud.com/help/en/oss/user-guide/access-buckets-via-custom-domain-names)
- [Alibaba Cloud: OSS Versioning and mutually exclusive features](https://www.alibabacloud.com/help/en/oss/user-guide/overview-78/)
- [Alibaba Cloud: PutObject and `x-oss-forbid-overwrite`](https://www.alibabacloud.com/help/en/oss/developer-reference/putobject)
- [Alibaba Cloud: Manage versioned objects](https://www.alibabacloud.com/help/en/oss/user-guide/manage-objects-in-a-versioning-enabled-bucket)
- [Alibaba Cloud: Configure OSS CORS](https://www.alibabacloud.com/help/en/oss/user-guide/configure-cross-origin-resource-sharing)
- [Tauri updater documentation](https://v2.tauri.app/plugin/updater/)
