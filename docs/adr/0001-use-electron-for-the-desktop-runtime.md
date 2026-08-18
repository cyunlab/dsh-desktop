# Use Electron for the desktop runtime

Status: accepted

DeepSeek Harness Desktop uses Electron and ships a version-matched Harness runtime with the application. Electron provides the private Node runtime needed by the published Harness packages and gives the required Windows support without modifying the read-only `deepseek-harness/` submodule. The renderer continues to use the Harness loopback HTTP/WebSocket interface with Node integration disabled; desktop-native capabilities and Harness lifecycle management stay outside the renderer.

For the first runnable milestone, Electron main launches a packaged Host child with a child-only Node-mode environment and serves the Web Client over a random loopback port. Main does not boot or compose Harness runtime modules. The child dynamically loads the published composition, reports a validated ready message, and disposes the runtime on stop or parent disconnect. The BrowserWindow first displays a packaged local startup page. After main completes the Host's loopback HTTP readiness probe, the window navigates to the Web Client; startup failure leaves the local page available to show the error and offer retry and log-copy actions.

The packaged startup/failure renderer is plain HTML, CSS, and TypeScript rather than a second application framework. Its sandboxed preload bridge exposes only lifecycle state plus retry, copy-diagnostics, and open-log-directory commands. After readiness, the upstream Web Client owns the complete product surface.

The first milestone is a single-instance application with exactly one Host. A second launch focuses the existing window instead of booting another Host. Closing the last window exits on every platform, including macOS, after requesting Harness disposal with a bounded shutdown timeout; the app records a shutdown failure before terminating.

The Web Client remains the owner of the durable multi-Workspace experience. Desktop does not add a second project picker before Host startup. Before launch, it assigns the child Host a deterministic empty Desktop default working directory under Desktop-owned application data so a Session created without a Workspace or explicit cwd never inherits an installer, shortcut, or terminal directory.

The BrowserWindow permits navigation only to its packaged startup document and the exact `http://127.0.0.1:<assigned-port>` origin of the Host started by that application instance. The renderer runs sandboxed with context isolation and without Node integration. Unexpected navigation is blocked; external links and new-window requests are handed to the operating system browser. The Host binds loopback only, with no LAN exposure in this milestone.

Desktop requests port `0`, allowing the operating system to allocate the listener atomically. The child requires the Harness boot/configuration tree to settle and reads the assigned port from the `webServer` service. Main then performs a bounded loopback HTTP probe before navigation. Log output such as `dsh web: ...` is diagnostic only and is not a lifecycle protocol.

This developer-validation milestone assigns `DSH_HOME` to a separate Desktop-owned application-data directory rather than sharing the CLI default `~/.dsh`. A user-facing release must provide a reviewed migration path for existing Harness data. The intended direction is a one-time, non-destructive import of compatible user data into the isolated Desktop home, not concurrent operation by independently versioned CLI and Desktop runtimes over the same mutable home. Migration is outside this milestone.

Desktop diagnostics use Electron's platform-standard `logs` directory. Bounded rolling files record versions, platform/architecture, lifecycle transitions and timings, the assigned loopback port, navigation-policy rejections, and startup/shutdown failures. They must not record credentials, environment dumps, conversations, prompts, tool payloads, user-file contents, URL queries, or request bodies. The startup page copies only a redacted summary and asks the main process to reveal the log directory.

## Considered Options

- **Tauri with a Harness single-executable sidecar** was rejected for the first release because the upstream single-executable pipeline does not target Windows, and an outer Windows pipeline would need new validation for dynamic ESM, `node-pty`, Koffi, ACL sandboxing, signing, and plugin loading.
- **Tauri with a private Node tree** was rejected because it duplicates runtime packaging and lifecycle work that Electron already supplies.
- **A client for a separately installed Harness** was rejected as the default because it weakens installation success and permits Desktop, Web Client, and Host version mismatches. External or remote Harness connections may be added later as explicit modes.

## Consequences

The first supported Windows target is Windows 10/11 x64. Electron, the Web Client, and the Harness runtime are built and tested as one versioned release; this developer milestone permits clearly labelled unsigned artifacts under ADR 0003. The application owns Electron/Chromium/Node security updates and must keep the renderer sandboxed with context isolation and no Node integration.

The initial toolchain pins Electron `43.4.0` exactly and uses Node 24 for development and CI; the root `packageManager` field also pins pnpm exactly. Startup verifies that Electron's embedded Node satisfies the pinned Harness engine. Automated dependency tooling may propose updates, but Electron major and Harness runtime changes require explicit review and the three-platform test workflow.
