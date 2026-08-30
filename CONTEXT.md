# DeepSeek Harness Desktop domain

## Purpose

DeepSeek Harness Desktop is a native application shell that owns one local Harness Host and displays the Host-provided Web Client. The first milestone proves this path on Windows, macOS, and Linux without modifying the upstream Harness submodule.

## Glossary

### Desktop

The versioned Tauri application: native shell, local Startup page, packaged official Node executable, published CLI, and lifecycle automation. Avoid using this term for the upstream Web Client alone.

### Desktop window

The single controlled window owned by Desktop. It shows the Startup page until the Host is ready, then shows the Web Client while enforcing Desktop navigation, external-link, popup, and focus rules.

### Host

The DeepSeek Harness Cordis runtime that exposes the loopback HTTP/API surface. One Desktop instance owns exactly one Host in the first milestone.

### Web Client

The upstream browser UI served by the Host. It owns the normal product experience, including Workspace management; Desktop does not fork or recreate it.

### Client readiness

The condition in which the client app shell and its required core services have activated and the normal product surface can render. Desktop first probes the fixed Host origin and requires a successful non-empty HTML response before navigating; it reports `Ready` only after the controlled main WebView completes loading that startup attempt's Host page. A TCP listener or living CLI process alone does not establish client readiness. The Startup page uses the user-facing wording “Waiting for client to start” and does not expose the upstream Web Client term.

### Client startup observer

The Desktop-owned HTTP and WebView observation boundary that establishes client readiness without modifying the Web Client or exposing Desktop capabilities to it.

### Web composition

The pinned published `dsh web` profile and its ordered upstream bundle layers. It transitively supplies the standard Host and Client plugin roster.

### Harness Home

The persistent root selected by `DSH_HOME` for Harness settings, credentials, profiles, sessions, storage, and related state. Desktop uses an isolated Harness Home under its application data; it does not share the CLI default `~/.dsh` in the first milestone.

### Workspace

A durable Harness entity representing a user-selected project directory and its grouped Sessions. The Web Client manages Workspaces. A Workspace is not the Harness Home and is not necessarily the Host working directory.

### Desktop default working directory

The deterministic, writable Desktop-owned directory used as the initial working directory for the local Host. It becomes a Session cwd only when session creation supplies neither a Workspace nor an explicit cwd. It is not a Workspace in the Workspace Registry.

### Startup page

The packaged, sandboxed Desktop renderer shown while the Host starts or when startup fails. It is not the Web Client and exposes only the narrow Tauri lifecycle/diagnostic event and command API.

### Desktop lifecycle

The Desktop-owned finite state machine: Starting, Waiting for client, Prolonged startup, Ready, Failed, and Stopping. An unexpected CLI process exit after Ready transitions to Failed. Retry first stops the owned CLI process tree before starting a replacement generation.

### Desktop navigation policy

The rule set that allows the main window to load only the packaged Startup page and the current Host loopback origin. Web Client popup requests never create another Desktop WebView: HTTP(S) targets open through the operating system default browser and every other target is rejected.

### Startup retry

A user-requested recovery operation that cancels the current startup generation, stops and confirms cleanup of its owned CLI process tree, and then starts a replacement generation. It does not reload the Web Client while preserving the old Host.

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

### Official Node executable

The packaged, version-matched Node.js executable used to run the published CLI. Its directory is placed first in the CLI process `PATH`, so plugin calls such as `spawn("node")` resolve to that same official runtime rather than a system installation.

### CLI process

The owned operating-system process created by executing the published `dsh` CLI entry with the Official Node executable. It runs the Harness runtime and is supervised as the leader of an owned process tree.

### Fixed Host origin

The Desktop-owned navigation and readiness address `http://127.0.0.1:3080/`. Changing the Desktop Host binding through `profiles/web` or Harness Home patches is unsupported in the first milestone, and Desktop does not discover an alternate origin.

### Node executable override

The optional `DSH_NODE_PATH` environment variable that explicitly replaces the packaged Official Node executable. Without it, both development and packaged Desktop use the fixed-version executable in the platform resource directory.

### Desktop shell

The native application layer responsible for windowing, lifecycle, packaging, and future desktop capability bridges. The shell does not define the Harness runtime semantics.

### Automatic update

The Desktop-owned flow that discovers a newer trusted Desktop release and, after user confirmation, replaces the installed application and restarts it. Updating includes orderly shutdown of the owned Host before installation.

### Update channel

An ordered stream of Desktop releases offered to an installation. The first automatic-update milestone exposes only the Stable channel.

### Stable channel

The production Update channel intended for all users. A built release does not enter Stable until it has passed the release gate.

### Update release

A versioned set of signed, platform-specific Desktop packages and metadata that can be offered through an Update channel.

### Stable promotion

The admission of a validated Update release into the Stable channel. Promotion changes the release offered to Desktop installations; building or staging packages alone does not.

### First-updater bootstrap

The single manually approved admission path used only while authoritative Stable was a legacy application that could not run Automatic update. It fresh-installs the exact four official candidate targets, records a content-digested immutable Bootstrap receipt, and writes Stable last without claiming a previous-Stable upgrade. The first Bootstrap receipt permanently closes this path; it cannot be reused or substitute for normal Stable promotion.

### Bootstrap receipt

The immutable OSS audit record written before the first-updater bootstrap changes Stable. Its content digest appears in its object key and it binds the approved candidate, legacy Stable manifest, and exact bootstrap evidence set. Any full or partial receipt closes the one-time path and must be preserved during recovery.

### Native update smoke

The Stable-promotion observation in which a matching native runner installs the exact published previous Stable, lets it discover and stage an isolated candidate through its compiled Stable endpoint, performs a normal platform window close, proves the saved Host process tree and exact installed Desktop processes are absent, and then separately launches a new PID from the replaced installation. macOS uses a repository-owned exact-PID Accessibility helper to press the unique main-window close button without changing TCC. It claims only facts observed from published binaries; explicit Restart interaction, negative security paths, and preference behavior remain separate tests unless a durable production-safe observation surface exists.

### Update availability indicator

A non-interrupting Desktop-owned signal that a newer Update release is available. It opens the update flow only when the user activates it and never presents an unsolicited update dialog.

### Staged update

A downloaded and verified Update release retained by Desktop until the user requests a restart or normally exits the application. Only one Update release may be staged for an installation at a time.

### Update confirmation

The user's explicit approval for Desktop to stop its owned Host, install a Staged update, and restart. Update availability and background download do not constitute confirmation.

### Trusted update

An Update release whose package signature verifies against the update public key embedded in Desktop. Operating-system publisher trust is separate from this Desktop update trust.

### Update signing key

The secret release credential used only by trusted automation to sign Update release packages. Desktop installations contain its public counterpart and never receive the secret key.

### Desktop client plugin

A private client package shipped as part of Desktop and layered onto the official Web composition. It may present Desktop-owned experience inside the Web Client but does not own native Desktop authority.

### Trusted plugin

A user-installed third-party DSH plugin treated as application code with the same ambient authority as its Host or Web Client runtime. Desktop capability declarations provide compatibility, user mediation, and diagnostics; they do not sandbox a Trusted plugin from other plugins in the same runtime.

### Desktop capability

A typed, task-level native behavior supplied by the Desktop shell to a Desktop client plugin or Trusted plugin. A capability hides Tauri commands, transport, platform differences, lifecycle, and native error details behind a domain Interface.

### Desktop capability bridge

The Desktop-owned Module that presents typed Desktop capabilities to plugins and adapts them to Rust-owned native behavior. It does not expose a generic native invocation Interface.
