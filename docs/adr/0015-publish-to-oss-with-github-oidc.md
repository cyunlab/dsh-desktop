# Publish to OSS with GitHub OIDC

GitHub Actions assumes a prefix-scoped Alibaba Cloud RAM role through GitHub OIDC and STS instead of storing a long-lived OSS AccessKey. Only the production publication job receives `id-token: write`; its trust policy is restricted to the immutable `cyunlab/dsh-desktop` repository identity and the `production` Environment, while build and test jobs receive no Alibaba Cloud identity.
