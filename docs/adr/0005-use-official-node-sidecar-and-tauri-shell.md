# Use an official Node sidecar with a Tauri shell

Status: accepted

> ADR 0006 supersedes this ADR's Desktop-owned sidecar lifecycle protocol. The Tauri shell and packaged official Node runtime decisions remain accepted.

## Decision

The Desktop product will migrate its native shell from Electron to Tauri. The Harness Host and all Harness plugins will run in a separately packaged, version-matched official Node.js executable (the Node sidecar). Tauri owns the application window and lifecycle; it does not run Harness code through its embedded runtime.

The supported compatibility target is the Web UI execution model: a plugin that works in the Web UI with the supported Harness and official Node versions must receive the same Node process semantics in Desktop. The sidecar is launched with an explicit executable path and argument vector, supervised as a process tree, and connected to the Tauri shell through a narrow lifecycle protocol. Tauri IPC serves WebView-to-Rust calls; the sidecar protocol carries process readiness, Host binding, shutdown, and failure state across the OS process boundary.

Desktop capability APIs are intentionally outside this migration decision. They will be designed later as a versioned, permissioned bridge and must not leak Tauri or Rust implementation details into plugin APIs.

## Rationale

Electron-as-Node changes the meaning of `process.execPath` and can expose Electron/Node ABI and native-loader differences to third-party plugins. Those differences have already affected native workers and restricted-token process launches on Windows. An official Node sidecar restores the runtime contract expected by the Web UI and removes Electron's embedded Node from the plugin compatibility boundary.

Tauri is selected as the shell because the product has not shipped and can absorb the one-time shell migration while reducing the permanent GUI runtime footprint. This is a shell migration, not a Harness runtime migration: the Node sidecar remains mandatory.

## Consequences

- Packaging must ship and verify a platform/architecture-specific Node executable, native Harness dependencies, and the complete runtime closure.
- Tauri must supervise sidecar startup, readiness, graceful shutdown, crash reporting, and update compatibility.
- The project must add Rust/Tauri build and signing workflows while preserving the existing Web UI and Host integration tests.
- The release matrix must test Windows, macOS, and Linux with the packaged sidecar; a system-installed Node is never a production dependency.
- The first sidecar slice may use newline-delimited JSON over stdio for lifecycle messages only; Harness business traffic remains on its existing loopback Web surface.
- User-facing runtime version negotiation is not required for a self-shipped sidecar, but startup must still fail clearly when the executable is missing, the architecture is wrong, or the sidecar cannot report the expected protocol capabilities.
- Electron-specific preload and main-process code will be replaced by Tauri commands/events or removed when no longer needed.
