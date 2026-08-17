# DeepSeek Harness Desktop domain

## Purpose

DeepSeek Harness Desktop is a native application shell that owns one local Harness Host and displays the Host-provided Web Client. The first milestone proves this path on Windows, macOS, and Linux without modifying the upstream Harness submodule.

## Glossary

### Desktop

The versioned Electron application: main process, preload bridge, local startup page, packaging, and lifecycle automation. Avoid using this term for the upstream Web Client alone.

### Desktop window

The single controlled window owned by Desktop. It shows the Startup page until the Host is ready, then shows the Web Client while enforcing Desktop navigation, external-link, popup, and focus rules.

### Host

The in-process DeepSeek Harness Cordis runtime that exposes the loopback HTTP/API surface. One Desktop instance owns exactly one Host in the first milestone.

### Web Client

The upstream browser UI served by the Host. It owns the normal product experience, including Workspace management; Desktop does not fork or recreate it.

### Web Client readiness

The condition in which the Web Client app shell and its required core services have activated and the normal product surface can render. Host HTTP availability alone does not establish Web Client readiness.

### Web Client startup observer

The Desktop-owned, read-only observer that reports Web Client readiness or activation failure across the renderer-to-main boundary. It does not modify the Web Client or expose Desktop capabilities to it.

### Web composition

The ordered upstream profile bundles `@deepseek-ai/dsh-base` and `@deepseek-ai/dsh-web-app`, plus only the launcher/runtime packages needed to boot them. The bundles transitively supply the standard Host and Client plugin roster.

### Harness Home

The persistent root selected by `DSH_HOME` for Harness settings, credentials, profiles, sessions, storage, and related state. Desktop uses an isolated Harness Home under its application data; it does not share the CLI default `~/.dsh` in the first milestone.

### Workspace

A durable Harness entity representing a user-selected project directory and its grouped Sessions. The Web Client manages Workspaces. A Workspace is not the Harness Home and is not necessarily the Host working directory.

### Fallback workspace

The deterministic empty Desktop-owned directory used as the Host process working directory. It becomes a Session cwd only when creation supplies neither a Workspace nor an explicit cwd.

### Startup page

The packaged, sandboxed Desktop renderer shown while the Host starts or when startup fails. It is not the Web Client and exposes only the narrow lifecycle/diagnostic preload API.

### Startup recovery cycle

A bounded recovery attempt that first reloads a failed Web Client while preserving its healthy Host, then restarts the Host if client activation fails again. A later user-requested retry begins a new cycle.

### Prolonged startup

A non-terminal state in which the Web Client has reported neither readiness nor activation failure after the normal waiting period. Desktop continues waiting while offering the user recovery actions; elapsed time alone does not make startup fail.

### Runtime closure

The complete set of published JavaScript, bundle patches, frontend assets, native modules, and peer/runtime packages required for the pinned Web composition to boot from a packaged application without a system Node or Harness installation.

### Development artifact

An unsigned NSIS, DMG, or AppImage produced for this milestone. It is labelled as unsigned and is not automatically published as a public release.

### Architecture mismatch

The condition in which a Desktop artifact runs through processor translation although a native artifact is available for that machine. Desktop blocks normal startup by default, while permitting an explicit one-run override for developer validation.
