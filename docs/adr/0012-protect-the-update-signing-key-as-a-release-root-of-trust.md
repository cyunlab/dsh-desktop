# Protect the Update signing key as a release root of trust

All platform Update release packages are signed by one production Update signing key held in GitHub Actions secrets, with an encrypted offline recovery backup. Desktop embeds only the corresponding public key. Losing the private key would strand existing installations, while disclosure would compromise update trust, so rotation requires an old-key-signed bridge release that embeds the successor public key before release automation begins signing with it.
