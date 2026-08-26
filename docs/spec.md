# Archived: First runnable DeepSeek Harness Desktop

> Superseded by the Tauri migration and ADR 0005. This document records the original Electron milestone for historical traceability; current implementation requirements live in `docs/tauri-migration.md` and `CONTEXT.md`.

## Problem Statement

Users who want the DeepSeek Harness Web Client currently need to install and operate the Harness and a compatible Node runtime themselves, launch the Web profile from a terminal, find its local URL, and manage the Host lifecycle. That creates installation and version-matching friction, especially on Windows, and does not provide a desktop application that can be built and tested consistently across Windows, macOS, and Linux.

The project needs a small, self-contained Desktop milestone that proves the complete local path without modifying the upstream Harness source: launch the pinned official Web composition, wait until its loopback Web Client is ready, display it in a secure desktop window, and shut it down reliably. The same milestone needs reproducible test and packaging automation on all three operating systems.

## Solution

Deliver an Electron application that ships a private, version-matched Harness runtime and uses Electron's embedded Node runtime. On launch, Desktop shows a minimal packaged startup page, creates isolated application data, launches one isolated Host child using the official published Web composition, binds it only to an operating-system-assigned `127.0.0.1` port, verifies HTTP readiness, and navigates the same window to the upstream Web Client. The Electron main process owns only the launch/IPC/lifecycle adapter; boot, compose, and dispose of the real Harness occur in the child.

Desktop remains a lifecycle and security shell. The upstream Web Client owns Workspace selection and the normal product experience. A single Desktop instance owns a single Host, and closing the final window disposes the Host before exiting. Failures remain on the startup page with retry and redacted diagnostic actions.

The milestone provides manually triggered three-platform test automation and manually or tag-triggered native packaging. Development packages are unsigned and clearly labelled; semantic-version tags collect successful native artifacts into an unpublished Draft Release.

## User Stories

1. As a Windows user, I want to install and run Desktop without installing Node, so that I can use Harness without managing a runtime prerequisite.
2. As a macOS user, I want a native DMG for my processor architecture, so that I can test Desktop without building it from source.
3. As a Linux user, I want an AppImage, so that I can run the milestone with minimal system installation.
4. As a user, I want Desktop to ship a compatible Harness runtime, so that a separately installed CLI cannot silently change Desktop behavior.
5. As a user, I want to see a startup screen while the Host is booting, so that a slow startup does not look like a blank or broken application.
6. As a user, I want Desktop to open the Web Client automatically after readiness, so that I do not need to find or copy a localhost URL.
7. As a user, I want the standard Harness Web experience, so that Desktop does not omit the plugins supplied by the official Web composition.
8. As a user, I want to add and select Workspaces through the Web Client, so that Desktop does not introduce a second, conflicting project-selection flow.
9. As a user, I want an unscoped Session to fall back to a harmless Desktop-owned empty directory, so that an accidental process directory does not become my writable project.
10. As a user, I want my Desktop settings, credentials, Sessions, and Workspace registry to persist across launches, so that restarting the application preserves my work.
11. As an existing CLI user, I want Desktop to leave my `~/.dsh` unchanged during this milestone, so that a differently versioned Desktop cannot corrupt my CLI state.
12. As a user, I want a second Desktop launch to focus the existing window, so that I do not accidentally create multiple competing Hosts.
13. As a user, I want closing the final window to stop the Host on every platform, so that no unexpected background process remains.
14. As a user, I want Host shutdown to be bounded, so that a faulty plugin cannot prevent the application from exiting forever.
15. As a user, I want a failed startup to show a useful error surface, so that I can retry without restarting the application blindly.
16. As a user, I want to copy a redacted diagnostic summary, so that I can report startup failures without exposing API keys or conversation content.
17. As a user, I want to open the platform-standard log directory, so that I can provide detailed diagnostics when necessary.
18. As a security-conscious user, I want the Host bound only to loopback, so that Harness is not exposed to my LAN.
19. As a security-conscious user, I want the renderer sandboxed without Node integration, so that Web content cannot directly access desktop privileges.
20. As a security-conscious user, I want unexpected navigation blocked, so that the privileged Desktop window cannot be redirected to an untrusted origin.
21. As a user, I want genuine external links to open in my system browser, so that documentation links do not gain Desktop privileges.
22. As a developer, I want the upstream Harness submodule treated as read-only, so that Desktop work cannot silently fork upstream behavior.
23. As a developer, I want exact Electron, pnpm, and Harness versions, so that local, CI, and packaged behavior are reproducible.
24. As a developer, I want paths containing spaces tested on Windows, so that common usernames and product paths do not break startup.
25. As a developer, I want the actual packaged runtime probed after packaging, so that dynamic plugin or YAML resolution failures are caught before artifacts are accepted.
26. As a maintainer, I want unit, real-Host integration, and Electron E2E tests on all three operating systems, so that platform regressions are visible in one manually triggered run.
27. As a maintainer, I want the test matrix to continue after one platform fails, so that a single run collects all platform diagnostics.
28. As a maintainer, I want manual builds to produce Actions artifacts without a Release, so that packaging can be tested repeatedly without polluting releases.
29. As a maintainer, I want a semantic-version tag checked against the application version, so that release metadata cannot drift from the package.
30. As a maintainer, I want tag builds to create only a Draft Release after every native build succeeds, so that incomplete or unreviewed artifacts are never published automatically.
31. As a tester, I want unsigned packages clearly identified with platform launch instructions, so that development artifacts are not mistaken for production-signed releases.
32. As a future maintainer, I want Host startup hidden behind a narrow launcher interface, so that process and IPC isolation remain encapsulated outside the application lifecycle.

## Implementation Decisions

- Desktop uses Electron rather than Tauri. Electron provides the private Node runtime required by Harness and a consistent Windows path without building a separate Harness executable.
- Electron is pinned exactly to `43.4.0`; development and CI use Node 24, and pnpm is pinned to `11.7.0`.
- The initial published Harness runtime family is `0.1.0-rc.6`. Direct Harness dependencies use exact versions, never ranges or npm dist-tags.
- Production builds consume published packages. The Harness git submodule is a read-only source and documentation reference outside the Desktop workspace and is never modified or used as the normal production build input.
- The Web composition is the ordered official `dsh-base` and `dsh-web-app` bundle pair. These aggregate packages bring the standard Host and Client plugin roster transitively; Desktop does not copy their configuration or curate a reduced roster.
- Desktop declares the public launcher/runtime packages needed by the Host child to boot that composition. The main bundle does not import or boot published Harness runtime modules.
- The Electron main process launches a packaged Host child through a narrow launcher boundary returning the assigned origin, close signal, and an idempotent disposer. The child sets no parent process state, dynamically boots/composes the published Harness runtime, and disposes it before exit.
- Desktop is a single-instance, one-window, one-Host application. A second launch activates the existing window.
- The application lifecycle has explicit preparing, booting, probing, ready, failed, retrying, stopping, and stopped states. Only the main process owns transitions.
- The startup renderer is plain HTML, CSS, and TypeScript. It receives immutable lifecycle snapshots through a narrowly scoped sandboxed preload bridge and can request only retry, copy-diagnostics, and reveal-log-directory actions.
- The BrowserWindow disables Node integration, enables context isolation and sandboxing, and initially loads only the packaged startup document.
- After Host readiness, navigation is limited to the exact assigned `http://127.0.0.1:<port>` origin. Other in-window navigation is blocked. Explicit external HTTP(S) links open in the system browser; untrusted schemes and popup creation are denied.
- The Host binds `127.0.0.1` with port `0`. Desktop reads the assigned port from the Web server service after the Harness configuration tree settles and then performs a bounded HTTP readiness probe. Console output is diagnostic, not a lifecycle protocol.
- The Web Client owns the durable multi-Workspace experience. Desktop does not require a project picker before Host startup.
- Desktop sets a deterministic, writable default working directory as the Host's initial cwd. It is used as a Session cwd only when creation supplies neither a Workspace nor an explicit cwd, and it is not a Workspace Registry entry.
- Desktop uses an isolated Harness Home under application data rather than the CLI default `~/.dsh`. Migration is deferred; the eventual direction is non-destructive one-time import rather than concurrent mutation of one home by separately versioned runtimes.
- Electron's platform-standard logs directory stores bounded rolling diagnostics. Logs include versions, architecture, lifecycle timings, assigned port, navigation rejections, and failure stacks, while excluding credentials, environment dumps, prompts, conversations, tool payloads, file contents, query strings, and request bodies.
- The product display name is `DeepSeek Harness Desktop`. Package, executable, and artifact identifiers are space-free. Development artifacts use `io.github.xlcyun.dsh-desktop` as the application ID; publisher identity must be reviewed before a public signed release.
- electron-builder creates Windows x64 NSIS, separate macOS arm64 and x64 DMGs, and Linux x64 AppImage artifacts on matching native runners.
- Packaging enables ASAR while unpacking the complete Harness runtime closure, including production dependencies, bundle YAML, frontend assets, native modules, and runtime files. Reliability of dynamic resolution takes precedence over narrowing the unpacked surface in this milestone.
- Manual and tag builds may be unsigned. Their names and Draft Release notes identify them as development builds and document Gatekeeper or SmartScreen steps. Signing inputs remain optional seams for a later public-release gate.
- The build workflow supports manual dispatch and semantic-version tags. Manual builds retain Actions artifacts only. Matching tags create an unpublished Draft Release only after every platform build succeeds; ordinary pushes and pull requests do not build installers.

## Testing Decisions

- The primary acceptance seam is the unpacked packaged Electron application: launch it as a user would, observe the startup page transition to the real upstream Web Client, and observe process and listener shutdown. Tests should assert external behavior rather than internal Cordis rows or Electron implementation details.
- A lower real-Host seam supports faster diagnosis: boot the pinned published Web composition with temporary isolated directories, assert an operating-system-assigned loopback listener, probe Web HTML and API behavior, and dispose it cleanly.
- Unit seams are limited to deterministic policy and state behavior: lifecycle transitions, retry and shutdown idempotence, path selection, navigation allowlisting, diagnostic redaction, Node engine validation, and release version validation.
- The test workflow is manually triggered and uses a non-fail-fast Windows, macOS, and Linux matrix. Each platform runs unit, integration, and Playwright Electron E2E layers. Linux GUI tests run under Xvfb.
- E2E coverage includes startup-to-Web transition, single-instance focus, startup failure and retry, external-link handling, and final-window shutdown.
- Integration fixtures use a temporary Harness Home and Desktop default working directory; Windows fixtures deliberately contain spaces.
- Packaged-runtime verification runs after electron-builder packaging and starts the Host from the packaged directory before probing the Web surface. A runtime-closure gate separately detects dependencies pruned despite dynamic bundle/plugin resolution.
- Installer construction remains in the build workflow rather than the behavior-test workflow. Platform artifact smoke checks belong beside the native packaging jobs.
- Exact row-for-row plugin inventory parity with the CLI is not a milestone gate. The externally visible Web startup and user journey are required; inventory parity may be added after packaging stabilizes.
- Upstream prior art is the Harness Web profile's real-composition tests and the reference Desktop repository's packaged-runtime and runtime-closure verification approach. Desktop adapts those testing shapes without copying or modifying upstream source.

## Out of Scope

- System tray behavior or background residency after the final window closes.
- Automatic updates or update-channel design.
- A custom integrated terminal.
- Plugin marketplace, plugin installation, or plugin-management UI.
- External or remote Harness Hosts.
- Reusing, migrating, or importing an existing `~/.dsh` during this milestone.
- Multiple windows or multiple Hosts.
- Launch at login.
- Production Apple Developer ID signing, notarization, Windows Authenticode signing, or public release publication.
- A custom application framework or replacement UI for the upstream Web Client.
- Exact CLI plugin inventory parity testing.
- Universal macOS binaries, Windows ARM64, Linux ARM64, MSI, MSIX, Store distribution, or other package formats.
- Replacing the isolated Host child with a utility process or a separate service.

## Further Notes

- The source reference is the read-only Harness submodule commit `47f943859bef60e4160492346772ded9b24f765a`; published runtime versions are recorded independently because source and npm publication state may differ.
- The npm registry currently exposes the compatible `0.1.0-rc.6` bundle family even though a package's `latest` dist-tag may point to an older release. Exact pins are therefore a correctness requirement.
- A clean target machine must need neither a system Node installation nor a separately installed Harness.
- A future public release must revisit existing-user migration, publisher identity, signing, minimum supported macOS/Linux versions, and update compatibility. None blocks this developer-validation milestone.
