# Tauri + official Node direct-CLI vertical slice

Tauri is the only Desktop shell. The Rust process owns the controlled window and Desktop lifecycle. Harness Host and plugins run in a separately packaged official Node.js process through the pinned published `dsh` CLI.

```text
Tauri Rust
  └─ official node(.exe) @deepseek-ai/dsh/lib/bin.js
       └─ dsh web --host 127.0.0.1 --port 3080
            └─ loopback Web Client
```

Development and packaged modes resolve the same fixed Node version from `resources/node/<platform-arch>/node(.exe)` unless `DSH_NODE_PATH` explicitly overrides it. Desktop places that executable's directory first in the child PATH, provides the isolated Desktop Harness Home through `DSH_HOME`, and starts the CLI from a distinct Desktop-owned default working directory. The CLI otherwise inherits the parent environment.

Desktop invokes the published CLI entry and does not import internal profile-launcher modules. The CLI owns the upstream `web` profile, profile and Home patches, presets, telemetry overlay, configuration reload, exception handling, and Harness disposal. The old Desktop JavaScript launcher and stdin/stdout JSON lifecycle protocol are removed.

## Fixed Host origin and readiness

Desktop always passes `web --host 127.0.0.1 --port 3080` and allows the main window to load only `http://127.0.0.1:3080/` for the owned Host. Customizing the Desktop Host binding through `profiles/web` or Harness Home patches is unsupported; Desktop neither parses CLI output nor discovers an alternate origin.

Before spawn, Desktop attempts an exclusive bind of port 3080. It releases the listener immediately before starting the CLI. This is a practical ordinary-collision check, not a guarantee against a hostile local process that deliberately wins the bind race and imitates the expected service.

After spawn, Desktop polls the fixed root while observing CLI exit. A 2xx response with `Content-Type: text/html` and a non-empty body allows navigation. Desktop publishes Ready only after the controlled WebView finishes loading that startup generation's root page. It does not continuously poll HTTP after Ready; a later unexpected CLI exit returns the window to Failed.

## Runtime closure

The build materializes a portable production dependency tree containing the pinned published CLI entry, its shipped configuration and presets, bundle patches, Web frontend, native modules, helpers, and transitive production dependencies. The package contains no pnpm store, workspace symlinks, development dependencies, or Desktop-owned JavaScript Host launcher.

Runtime closure verification rejects a missing CLI entry, CLI configuration asset, frontend, native dependency, helper, or non-portable symlink. Artifact probes locate packaged Node and the packaged CLI, start the same fixed command used by Desktop, require real HTML, and confirm listener plus process-tree cleanup without using repository dependencies or system Node.

## Lifecycle and recovery

The Startup page and Rust shell communicate only through Tauri events and commands. Desktop lifecycle states are Starting, Waiting for client, Prolonged startup, Ready, Failed, and Stopping.

Starting covers fixed-port preflight and CLI spawn. Waiting for client covers HTTP readiness and the current-generation WebView load. After 30 seconds the same attempt enters the non-terminal Prolonged startup state and exposes Retry while continuing to wait indefinitely. Port conflict, spawn failure, cleanup failure, or CLI exit before readiness enters Failed.

Retry always cancels the current generation and stops its owned CLI process tree before starting a replacement. It does not preserve the old Host for a WebView-only reload. Duplicate Desktop launches focus the existing main window and never start another CLI.

Copy diagnostics contains only application and runtime versions, platform and architecture, lifecycle state and elapsed time, process status, and a stable error category. CLI stdout and stderr are inherited by development builds and discarded by packaged builds. Desktop does not persist CLI output and does not expose an Open logs action in this milestone.

## Shutdown ownership

On macOS and Linux, Desktop sends SIGTERM to the CLI leader so the upstream CLI can dispose Harness. The CLI process group remains owned for forced cleanup after the eight-second Desktop deadline.

On Windows, Desktop creates the CLI in a dedicated hidden console, attaches it to a Job Object before normal execution, and sends Ctrl+C for an owned shutdown request. Exit 130 is expected only when that same lifecycle generation requested shutdown. Console failure or timeout falls back to bounded `TerminateJobObject` cleanup.

## Testing and release

Tests cover fixed command construction, port conflict, startup exit, HTML and WebView readiness, generation isolation, prolonged startup, Retry ordering, crash after Ready, expected versus unexpected exit classification, and forced descendant cleanup.

macOS and Linux exercise the real SIGTERM path. A Windows-only integration test exercises the real console Ctrl+C path and exit 130 classification. It is committed with the implementation but remains unexecuted while development is on macOS and Windows CI is unavailable. A follow-up issue will promote the real packaged Windows control-event scenario to a blocking release guard.

Windows produces x64 NSIS, macOS produces arm64 and x64 DMG, and Linux produces x64 AppImage development artifacts. The read-only Harness submodule remains outside the Desktop build inputs.

## Local development

`pnpm tauri:dev` and `pnpm tauri:build` ensure the fixed official Node executable is present before running. A developer may temporarily override it with `DSH_NODE_PATH`. Node archives are checksum-verified before use.

This vertical slice excludes tray behavior, notifications, a desktop capability bridge, dynamic ports, persisted CLI logs, user-configurable Desktop Host binding, and public-release Windows control-event gating.
