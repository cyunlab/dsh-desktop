# First runnable Desktop implementation plan

## Outcome

On Windows, macOS, and Linux, `pnpm dev` and the unpacked packaged application open a local startup page, boot the pinned official Harness Web composition inside Electron's main process, wait for an OS-assigned loopback listener, and navigate the same window to the upstream Web Client. Closing the final window disposes the Host and exits.

## Scope

Included: one window, one in-process Host, isolated Harness Home, fallback workspace, loopback-only navigation, minimal diagnostics, unit/integration/E2E tests, three-platform unsigned packages, manual CI, and tag-created Draft Releases.

Excluded: tray/background mode, updater, custom terminal, plugin marketplace, external Host, migration from `~/.dsh`, multiple windows/Hosts, launch-at-login, production signing, and a custom product renderer.

## Proposed repository shape

```text
src/
├── main/
│   ├── index.ts                 Electron entry and single-instance wiring
│   ├── lifecycle/
│   │   ├── application.ts       Application lifecycle coordinator
│   │   ├── electron-wiring.ts   Electron lifecycle adapter
│   │   └── startup-failure.ts   User-facing startup failure mapping
│   ├── paths.ts                 Harness Home, fallback workspace, and logs
│   ├── host/
│   │   ├── launcher.ts          Narrow HostLauncher interface
│   │   ├── harness-launcher.ts  Published-package Web composition adapter
│   │   ├── fake-launcher.ts     Fake Host adapter
│   │   └── readiness.ts         Bounded loopback HTTP probe
│   ├── navigation-policy.ts     Exact-origin and external-link policy
│   ├── diagnostics.ts           Redacted rolling diagnostics
│   └── version-guard.ts         Electron Node/Harness engine assertion
├── preload/
│   └── startup.ts               Narrow typed lifecycle bridge
├── startup/
│   ├── index.html
│   ├── index.ts
│   └── index.css
└── shared/
    └── startup-contract.ts      State and IPC contract
tests/
├── unit/
├── integration/
└── e2e/
scripts/
├── verify-runtime-closure.mjs
├── verify-packaged-runtime.mjs
└── verify-release-version.mjs
.github/workflows/
├── test.yml
└── build.yml
```

## Runtime design

### State machine

```text
idle → preparing → booting → probing → ready
                    ↘ failed ←─────────┘
failed → retrying → booting
ready/failed → stopping → stopped
```

Only the main process mutates state. The preload bridge publishes immutable snapshots to the startup page. Retry first disposes any partial Cordis root and listener before creating a fresh boot attempt. Shutdown is idempotent and bounded.

### Paths

After `app.whenReady()`:

```text
app.getPath('userData')/deepseek-harness-desktop/harness-home
app.getPath('userData')/deepseek-harness-desktop/fallback-workspace
app.getPath('logs')
```

Set `DSH_HOME` before importing or invoking Harness code that resolves it. Create the fallback workspace and set the Host cwd before composition. Tests replace all paths with temporary directories, including a Windows path containing spaces.

### Host launch

1. Resolve the published `@deepseek-ai/dsh` package manifest as the installation anchor.
2. Use public `@deepseek-ai/dsh-app-boot` profile APIs to initialize/load the Desktop-owned `desktop` profile from the isolated Harness Home; its contents remain the official Web composition.
3. Compose `@deepseek-ai/dsh-base` followed by `@deepseek-ai/dsh-web-app`; do not copy their YAML or read from the submodule.
4. Supply Web arguments equivalent to `--host 127.0.0.1 --port 0` through the published command-line provider.
5. Boot the Cordis root and retain its context/disposer behind `HostLauncher`.
6. Read `ctx.webServer.port`, form the exact loopback origin, and pass a bounded HTTP readiness probe.
7. Return `{ origin, dispose }`; logs are never used as the readiness protocol.

The adapter must use public package exports only. If the exact published version lacks a needed public seam, stop and document that incompatibility rather than importing submodule source or patching the package.

### Window security

Create the BrowserWindow with `nodeIntegration: false`, `contextIsolation: true`, and `sandbox: true`. Initially load only the packaged startup page. After readiness, allow the exact assigned loopback origin. Block every other navigation. Send explicitly external HTTP(S) links to `shell.openExternal`; deny other schemes and all untrusted popup creation.

### Diagnostics

Use Electron's standard logs path and bounded rotation (initial target: five 5 MiB files). Record versions, architecture, state transitions/timings, the assigned port, policy rejections, and failure stacks. Do not record credentials, environment dumps, prompts, conversations, tool payloads, file contents, query strings, or request bodies.

## Build system

- Root package: private ESM package named `deepseek-harness-desktop` with product name `DeepSeek Harness Desktop`.
- Pin Electron `43.4.0`, Node 24 in CI, pnpm `11.7.0`, and every direct published Harness package to the `0.1.0-rc.6` family exactly. Do not resolve Harness packages through npm dist-tags.
- Compile main/preload/startup TypeScript into separate outputs; the startup renderer has no framework dependency.
- electron-builder uses ASAR and unpacks the complete production runtime closure.
- Targets: Windows x64 NSIS, macOS arm64 DMG, macOS x64 DMG, Linux x64 AppImage.
- `afterPack` boots and probes the packaged directory; runtime-closure validation checks dynamic bundle/plugin resolution before artifacts are accepted.

## Test strategy

### Unit

Lifecycle transitions and retry idempotence; platform path mapping; exact-origin navigation policy; redaction; version guard; release tag/version validation.

### Integration

Boot the real pinned Web composition with temporary isolated paths; assert a nonzero assigned port, Web HTML/API readiness, no LAN listener, and bounded disposal. Include spaces in the path fixture. Do not require row-for-row CLI plugin inventory parity.

### E2E

Playwright launches the unpacked Electron application. Verify startup-page-to-Web-Client transition, single-instance focus, startup failure and retry, external-link handling, and final-window shutdown. Linux runs under Xvfb.

## CI

`test.yml` is `workflow_dispatch` only, uses a non-fail-fast Windows/macOS/Linux matrix, and runs unit, integration, and E2E layers.

`build.yml` runs on `workflow_dispatch` and semantic-version tags. Manual runs upload unsigned Actions artifacts. Tags must equal `package.json` and, after every native build succeeds, create an unpublished Draft Release containing clearly labelled unsigned development artifacts and platform launch instructions.

## Implementation order

1. Scaffold pinned pnpm/TypeScript/Electron tooling and minimal startup window.
2. Implement typed startup state, narrow preload bridge, navigation policy, and paths.
3. Implement `HostLauncher` and prove source-tree Web composition boot with port `0`.
4. Add HTTP readiness, retry, single-instance behavior, and bounded disposal.
5. Add redacted rotating diagnostics and failure actions.
6. Add unit and real-Host integration tests.
7. Add Playwright Electron E2E on all three platforms.
8. Configure electron-builder, ASAR unpacking, closure verification, and packaged boot probe.
9. Add manual test workflow and manual/tag build workflow.
10. Run the full three-platform workflows; record any platform-specific exceptions as new decisions rather than changing the read-only submodule.

## Acceptance checks

- A clean machine needs neither system Node nor a preinstalled Harness.
- No file under `deepseek-harness/` changes.
- The same window reaches the upstream Web Client on an OS-assigned `127.0.0.1` port.
- A Session can add/select Workspaces through the upstream UI; an omitted Workspace falls back to the Desktop-owned empty cwd.
- Closing the final window disposes the listener and exits on all three platforms.
- Manual test and build workflows finish on Windows, macOS, and Linux.
- A matching semantic tag creates only a Draft Release; unsigned status is conspicuous.
