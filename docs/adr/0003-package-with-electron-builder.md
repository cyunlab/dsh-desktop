# Package with electron-builder

Status: accepted

DeepSeek Harness Desktop uses pnpm and electron-builder for distributable artifacts. Builds run on the matching operating-system runner because the shipped Harness dependency graph may contain platform-specific or native components.

The first milestone produces:

- Windows x64: NSIS installer
- macOS arm64: DMG
- macOS x64: DMG
- Linux x64: AppImage

macOS architectures remain separate instead of being merged into a universal application until native-dependency compatibility is proven. Signing, notarization, publishing, and update policy are separate release concerns; the packaging choice keeps those capabilities available.

This developer-validation milestone permits unsigned artifacts from both manual and tag-triggered builds. Filenames and Draft Release notes identify them as unsigned development builds and document the extra macOS Gatekeeper and Windows SmartScreen steps; no workflow automatically publishes the draft. Build configuration retains optional signing/notarization inputs so a public release can make valid Apple Developer ID notarization and Windows Authenticode signing mandatory without replacing the packaging pipeline.

The build workflow supports two triggers. `workflow_dispatch` builds every target and retains GitHub Actions artifacts without creating a Release. A pushed semantic-version tag (`vX.Y.Z`, including a valid prerelease suffix) must equal the root package version, builds every target, and only after all platform jobs succeed collects their artifacts into a GitHub Draft Release. Publishing the draft remains a manual action. Ordinary branch pushes and pull requests do not build installers in this milestone.

The human-facing product name is `DeepSeek Harness Desktop`. Machine identifiers remain space-free: the npm package name, executable name, and artifact filename stem use `deepseek-harness-desktop`; development artifacts use `io.github.xlcyun.dsh-desktop` as the application id. A public signed release must review publisher identity before compatibility commitments are made. All path handling uses platform path APIs, and any future process launch passes an executable and argv array without a shell. Windows tests deliberately exercise a `DSH_HOME` and Workspace path containing spaces.

Packaging enables ASAR for the application while unpacking the complete Harness production runtime closure, including `node_modules`, bundle patch YAML, and native/runtime files, into `app.asar.unpacked`. This intentionally favors reliable dynamic package and filesystem resolution over minimizing the unpacked surface. An `afterPack` verification starts the Host from the packaged directory and probes the Web surface; a separate closure check fails when pruning omits a dynamically referenced plugin. Narrower unpack rules are deferred until all three platforms are stable.

## Considered Options

- **Electron Forge** provides a supported Electron toolchain, but the milestone does not need its project abstraction in addition to the existing pnpm scripts. electron-builder directly covers the selected platform targets and later GitHub Release publishing.
- **Cross-building every artifact on one runner** was rejected because native modules and macOS signing require platform-specific environments.
