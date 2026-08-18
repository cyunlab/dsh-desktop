# First runnable Desktop implementation plan

## Outcome

On Windows, macOS, and Linux, `pnpm dev` and the unpacked packaged application open a local startup page, launch a packaged Host child containing the pinned official Harness Web composition, wait for an OS-assigned loopback listener, and navigate the same window to the upstream Web Client. Electron main only launches and supervises the child; the child boots, composes, and disposes the real Harness. Closing the final window disposes the Host and exits.

## Scope

Included: one window, one isolated Host process, isolated Harness Home, Desktop default working directory, loopback-only navigation, minimal diagnostics, unit/integration/E2E tests, three-platform unsigned packages, manual CI, and tag-created Draft Releases.

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
│   ├── paths.ts                 Harness Home, default working directory, and logs
│   ├── host/
│   │   ├── launcher.ts          Narrow HostLauncher interface
│   │   ├── process-launcher.ts  Isolated Host child adapter
│   │   ├── fake-launcher.ts     Fake Host adapter
│   │   └── readiness.ts         Bounded loopback HTTP probe
│   ├── host-process/
│   │   ├── index.ts             Host child IPC/lifecycle entry
│   │   └── runtime.ts           Published-package Web composition runtime
│   ├── window/
│   │   ├── desktop-window.ts    Controlled Desktop window implementation
│   │   └── navigation-policy.ts Exact-origin and external-link policy
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
app.getPath('userData')/deepseek-harness-desktop/default-working-directory
app.getPath('logs')
```

Set `DSH_HOME` in the Host child environment before importing Harness code that resolves it. Create the Desktop default working directory before launch. Tests replace all paths with temporary directories, including a Windows path containing spaces.

### Host launch

1. Main resolves the packaged `host-process/index.js` entry and launches it with `process.execPath`, child-only `DSH_HOME` and `ELECTRON_RUN_AS_NODE=1`, and the Desktop default working directory.
2. The child dynamically loads the published Harness runtime, resolves the `@deepseek-ai/dsh` installation anchor, and uses public `@deepseek-ai/dsh-app-boot` profile APIs.
3. The child composes `@deepseek-ai/dsh-base` followed by `@deepseek-ai/dsh-web-app`; it does not copy their YAML or read from the submodule.
4. The child supplies Web arguments equivalent to `--host 127.0.0.1 --port 0`, boots the Cordis root, and reports only a validated ready IPC message.
5. Main performs the bounded HTTP readiness probe after ready IPC, and exposes `{ origin, dispose, closed }` through `HostLauncher`.
6. Child stop/disconnect paths dispose the Cordis root before exit; logs are never used as the readiness protocol.

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
