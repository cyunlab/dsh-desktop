# DeepSeek Harness Desktop domain

## Purpose

DeepSeek Harness Desktop is a native application shell that owns one local Harness Host and displays the Host-provided Web Client. The first milestone proves this path on Windows, macOS, and Linux without modifying the upstream Harness submodule.

## Glossary

### Desktop

The versioned Tauri application: native shell, local startup page, packaged official Node sidecar, and lifecycle automation. Avoid using this term for the upstream Web Client alone.

### Desktop window

The single controlled window owned by Desktop. It shows the Startup page until the Host is ready, then shows the Web Client while enforcing Desktop navigation, external-link, popup, and focus rules.

### Host

The DeepSeek Harness Cordis runtime that exposes the loopback HTTP/API surface. One Desktop instance owns exactly one Host in the first milestone.

### Web Client

The upstream browser UI served by the Host. It owns the normal product experience, including Workspace management; Desktop does not fork or recreate it.

### Client readiness

The condition in which the client app shell and its required core services have activated and the normal product surface can render. Desktop first probes the reported loopback root with HTTP and requires a successful HTML response before navigating; it reports `Ready` only after the controlled main WebView completes loading that current-attempt Host page. A TCP listener or Host lifecycle message alone does not establish client readiness. The startup page uses the user-facing wording “Waiting for client to start” and does not expose the upstream Web Client term.

### Client startup observer

The Desktop-owned, read-only observer that reports client readiness or activation failure across the renderer-to-main boundary. It does not modify the client or expose Desktop capabilities to it.

### Web composition

The ordered upstream profile bundles `@deepseek-ai/dsh-base` and `@deepseek-ai/dsh-web-app`, plus only the launcher/runtime packages needed to boot them. The bundles transitively supply the standard Host and Client plugin roster.

### Harness Home

The persistent root selected by `DSH_HOME` for Harness settings, credentials, profiles, sessions, storage, and related state. Desktop uses an isolated Harness Home under its application data; it does not share the CLI default `~/.dsh` in the first milestone.

### Workspace

A durable Harness entity representing a user-selected project directory and its grouped Sessions. The Web Client manages Workspaces. A Workspace is not the Harness Home and is not necessarily the Host working directory.

### Desktop default working directory

The deterministic, writable Desktop-owned directory used as the initial working directory for the local Host. It becomes a Session cwd only when session creation supplies neither a Workspace nor an explicit cwd. It is not a Workspace in the Workspace Registry.

### Startup page

The packaged, sandboxed Desktop renderer shown while the Host starts or when startup fails. It is not the Web Client and exposes only the narrow Tauri lifecycle/diagnostic event and command API.

### Desktop lifecycle

The Desktop-owned finite state machine: Starting, Starting sidecar, Waiting for Web Client, Ready, Failed, and Stopping. A sidecar crash after Ready transitions back to Failed. A retry first stops the owned sidecar before starting a replacement.

### Desktop navigation policy

The rule set that allows the main window to load only the packaged Startup page and the current Host loopback origin. Web Client popup requests never create another Desktop WebView: HTTP(S) targets open through the operating system default browser and every other target is rejected.

### Startup recovery cycle

A bounded recovery attempt that first reloads a failed Web Client while preserving its healthy Host, then restarts the Host if client activation fails again. A later user-requested retry begins a new cycle.

### Prolonged startup

A non-terminal state entered after 30 seconds when the Host or Web Client has not reported readiness. Desktop continues waiting indefinitely while offering user-controlled recovery actions; elapsed time alone does not make startup fail.

### Runtime closure

The complete set of published JavaScript, bundle patches, frontend assets, native modules, and peer/runtime packages required for the pinned Web composition to boot from a packaged application without a system Node or Harness installation.

### Development artifact

An unsigned NSIS, DMG, or AppImage produced for this milestone. It is labelled as unsigned and is not automatically published as a public release.

### Architecture mismatch

The condition in which a Desktop artifact runs through processor translation although a native artifact is available for that machine. Desktop blocks normal startup by default, while permitting an explicit one-run override for developer validation.

### Harness runtime

The official Node.js process that runs the Harness Host and its complete plugin graph. It is a separate runtime boundary from the Desktop shell and must provide the same Node execution semantics as the Web UI.

### Node sidecar

A packaged, version-matched official Node.js executable launched and supervised by Desktop to host the Harness runtime. Its directory is placed first in the sidecar `PATH`, so plugin calls such as `spawn("node")` resolve to that same official runtime rather than a system installation. Plugins execute inside this process rather than inside Electron or Tauri.

### Node executable override

The optional `DSH_NODE_PATH` environment variable that explicitly replaces the packaged Node sidecar executable. Without it, both development and packaged Desktop use the fixed-version official Node executable in the platform resource directory.

### Desktop shell

The native application layer responsible for windowing, lifecycle, packaging, and future desktop capability bridges. The shell does not define the Harness runtime semantics.
