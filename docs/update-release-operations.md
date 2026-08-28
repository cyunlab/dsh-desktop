# Automatic update release operations

This runbook provisions and operates the production release path for Desktop automatic updates. It is intentionally fail-closed: immutable packages are uploaded and checked first, and `dsh-desktop/channels/stable/latest.json` is replaced only after every target passes validation.

> **Current status:** the Alibaba Cloud resources, GitHub `production` Environment, DNS mapping, TLS certificate, and production updater signing key described below are **尚未实际创建或验证**. Repository automation can be reviewed and tested with its fake OSS adapter, but no real OSS promotion smoke test has succeeded yet. Do not interpret this document as evidence that production is live.

## Ownership boundary

Repository automation owns these steps after the external resources exist:

- builds the four updater targets and their mandatory Tauri signatures;
- creates a GitHub Draft Release for a tag without changing Stable;
- on the GitHub Release `published` event, exchanges GitHub OIDC identity for short-lived Alibaba Cloud STS credentials;
- uploads and validates immutable release objects before writing the Stable manifest last;
- copies release notes only from the published GitHub Release body.

An Alibaba Cloud administrator and a GitHub repository administrator must manually create and verify:

- one shared, public-release OSS bucket in `cn-shenzhen`;
- OSS Versioning, anonymous read policy, custom domain, TLS certificate, and the CORS decision described below;
- one GitHub OIDC provider in RAM and one `dsh-desktop/` prefix-scoped RAM role;
- the GitHub `production` Environment, its variables, secrets, and deployment protection rules;
- the updater signing key and its independently stored 离线加密备份 (offline encrypted backup).

Do not put private business data in this bucket. It is a shared public-release bucket: future applications may use separate top-level prefixes, while Desktop owns only `dsh-desktop/`.

## Required GitHub Environment configuration

Create an Environment named exactly `production`. Configure required reviewers or other deployment protection appropriate to the organization. Build matrix jobs may reference `production` only to read the two `TAURI_SIGNING_*` secrets required to sign updater artifacts. The promotion job is the only job granted `permissions: id-token: write` and the only job that consumes the OIDC provider, RAM role, OSS, and update-origin variables below. Build jobs must not consume or pass OIDC provider/role variables, request an ID token, or receive Alibaba Cloud credentials; unrelated test jobs should not reference `production` at all.

Set these Environment variables exactly as shown:

| Variable | Required value |
| --- | --- |
| `ALIBABA_CLOUD_OIDC_PROVIDER_ARN` | ARN of the GitHub OIDC provider, for example `acs:ram::<account-id>:oidc-provider/<provider-name>` |
| `ALIBABA_CLOUD_ROLE_ARN` | ARN of the prefix-scoped publishing role, for example `acs:ram::<account-id>:role/<role-name>` |
| `OSS_BUCKET` | Name of the shared public-release bucket; use only the bucket name, with no scheme or path |
| `OSS_REGION` | `cn-shenzhen` |
| `UPDATE_BASE_URL` | `https://updates.cyunlab.com` with no trailing slash |
| `TAURI_SIGNING_PUBLIC_KEY` | Entire minisign public-key content used by promotion; it must exactly match the public key embedded in Desktop |

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
  channels/stable/latest.json
```

Every updater package and signature object uses a basename prefixed with the lowercase SHA-256 digest of that object's complete bytes. Different bytes therefore always produce a different OSS key under the same `releases/<semver>/<target>/` directory. The implementation may use the documented fixed-length `<sha256-prefix>` rather than the entire digest, but it must derive that prefix from the complete object bytes and use the same deterministic length for every object.

Immutable release objects use a long immutable cache policy and are retained permanently. The publishing RAM role has no delete permission. The Stable manifest uses `Cache-Control: no-cache`. Its platform entries contain public HTTPS URLs for the content-addressed packages and the literal contents of each `.sig` file, not a signature filename or URL.

Release procedure:

1. Create and push the approved version tag. Wait for all four targets: Windows x64 NSIS EXE, Linux x64 AppImage, macOS arm64 app archive, and macOS x64 app archive.
2. Confirm every updater package has a matching non-empty signature and that existing macOS signing/notarization checks remain green.
3. Confirm the workflow created a GitHub **Draft Release**. A Draft does not promote and must not change `dsh-desktop/channels/stable/latest.json`.
4. Review the Draft asset set and release body. The body is the sole source of Stable release notes; correct it before publication.
5. Publish the GitHub Release. Before any OSS write, promotion uses minisign and `TAURI_SIGNING_PUBLIC_KEY` to cryptographically verify all four updater packages against their literal signature files. This public key must exactly match the public key embedded in Desktop. A missing package, missing signature, invalid signature, or public-key mismatch stops the job before it can write OSS.
6. Publication obtains short-lived STS credentials through OIDC and uploads content-addressed immutable objects only after the local verification gate has passed. Before upload it derives each `<sha256-prefix>-<artifact-basename>` from the local bytes. If that key already exists, promotion downloads or otherwise verifies the complete remote bytes and may reuse it only when it is byte-for-byte identical; a mismatch is a collision or corruption and fails promotion. Changed bytes naturally select a different key and never overwrite the prior object.
7. Automation writes `dsh-desktop/channels/stable/latest.json` only after all four targets pass. If any upload or validation fails, the job must fail and the previous manifest must remain current.
8. Independently fetch the manifest and all target URLs through `https://updates.cyunlab.com`. Verify HTTPS, version, release notes, RFC 3339 publication timestamp, literal signatures, cache headers, and a real update path on every target before recording production readiness.

Never manually edit Stable to point at a partly uploaded release. Never reuse a version path or overwrite an immutable package.

## Failure handling and recovery

### Failure before the manifest write

Leave the previous Stable manifest untouched. Diagnose and rerun the same immutable publication only if every existing content-addressed object is byte-for-byte identical to the expected object and its signature verifies. Different bytes use a different content-addressed key, but changing release contents after publication still requires a higher semantic version. Never overwrite or delete a released object.

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
- [ ] All six Environment variables and both Environment secrets use the exact names in this runbook.
- [ ] `TAURI_SIGNING_PUBLIC_KEY` matches both the protected private key and the public key embedded in Desktop; offline encrypted restore has been tested.
- [ ] Promotion verifies all four updater packages with minisign before writing OSS.
- [ ] Draft creation leaves Stable unchanged; publication failure also leaves Stable unchanged.
- [ ] A successful published-release smoke has passed on all four targets and its evidence is recorded.

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
