# Direct official `dsh web` runtime

Tracking issue: [#41](https://github.com/cyunlab/dsh-desktop/issues/41)

## Problem Statement

Desktop 当前让官方 Node sidecar 执行一套 Desktop 自有的 JavaScript launcher。该 launcher 重新实现了官方 `dsh web` 已经拥有的 profile composition、patch 组装、Host boot、agent preset 定位和 shutdown 边界，并通过 stdin/stdout JSON 消息向 Desktop shell 报告生命周期。

这套重复实现扩大了 Desktop 的维护面，也会让 Desktop 与上游 Web composition 逐渐产生行为漂移。上游 CLI 已经负责 bundle、用户 patch、Harness Home patch、preset、配置热更新、异常处理和优雅退出，Desktop 不应再复制这些职责。产品需要在不修改只读 Harness 子模块的前提下，直接运行随 runtime closure 发布的官方 `dsh web` CLI，同时继续满足三平台窗口、就绪探测、进程树回收、诊断和打包要求。

## Solution

Desktop shell 使用随应用发布的官方 Node executable，直接执行同一 runtime closure 中固定版本的官方 `dsh` CLI，并以 `web --host 127.0.0.1 --port 3080` 启动官方 Web composition。Desktop 不再打包或执行自有 Host launcher，也不再维护 Node sidecar JSON 生命周期协议。

Desktop 在启动前确认固定 loopback 端口可用，启动后同时观察 CLI 进程和 `http://127.0.0.1:3080/` 的 HTTP HTML 响应。只有真实 Host 页面可服务且当前 Desktop window 完成该页面加载，Desktop lifecycle 才进入 Ready。stdout 和 stderr 不作为机器协议解析；开发构建继承它们，打包构建丢弃它们，Desktop 不持久化 CLI 输出。

macOS 和 Linux 通过 SIGTERM 请求官方 CLI 优雅退出；Windows 为 Node CLI 创建专属的隐藏控制台，并通过 Ctrl+C 触发官方 CLI 已有的 SIGINT shutdown handler。三平台都保留进程组或 Job Object 所有权，在有界等待超时后强制终止完整进程树。

## User Stories

1. As a Desktop user, I want Desktop to run the official Web composition, so that its behavior matches `dsh web`.
2. As a Desktop user, I want the Host to use the official packaged Node executable, so that no system Node installation is required.
3. As a Desktop user, I want Desktop to start on the stable loopback origin `http://127.0.0.1:3080`, so that startup does not depend on parsing CLI logs.
4. As a Desktop user, I want a clear startup failure when port 3080 is already occupied, so that ordinary port collisions are detected before Desktop starts the Host.
5. As a Desktop user, I want Desktop to wait for real Host HTML before navigating, so that a living Node process is not mistaken for a ready application.
6. As a Desktop user, I want the Web Client to finish loading before Desktop reports Ready, so that readiness represents a usable product surface.
7. As a Desktop user, I want prolonged startup to remain recoverable, so that a slow Host is not killed merely because 30 seconds elapsed.
8. As a Desktop user, I want Retry to stop the currently owned CLI process before starting another, so that one Desktop instance never owns two Hosts.
9. As a Desktop user, I want an unexpected CLI exit after Ready to return Desktop to the failure page, so that a dead Host is never presented as healthy.
10. As a Desktop user, I want normal application exit to let Harness flush and dispose its state, so that sessions and settings are not corrupted.
11. As a Windows user, I want Desktop to request official CLI shutdown through Ctrl+C, so that the upstream SIGINT cleanup path runs without modifying Harness.
12. As a macOS or Linux user, I want Desktop to request official CLI shutdown through SIGTERM, so that the upstream supervisor shutdown path exits cleanly.
13. As a Desktop user, I want a bounded shutdown timeout, so that a stuck plugin cannot prevent Desktop from exiting forever.
14. As a Desktop user, I want all CLI descendants terminated after the timeout, so that native helpers, PTYs and worker processes are not orphaned.
15. As a Desktop user, I want startup failures categorized from bounded lifecycle metadata rather than persisted CLI output, so that diagnostics remain useful without creating a local raw-log retention surface.
16. As a privacy-conscious user, I want copied diagnostics to remain metadata-only and redacted, so that CLI logs, environment variables, credentials and workspace content are not copied accidentally.
17. As a user with existing Harness settings, I want Desktop to keep using its isolated Harness Home, so that official CLI behavior does not switch Desktop to the global CLI home.
18. As a user selecting a Workspace, I want the Web Client to continue owning Workspace selection, so that the fixed Host working directory is not mistaken for a Workspace.
19. As a user launching Desktop twice, I want the second launch to focus the existing window, so that it does not start a second CLI or compete for port 3080.
20. As a developer, I want Desktop to invoke the official CLI entry point instead of importing its internal modules, so that the supported command-line behavior is inherited without a deep-import contract.
21. As a developer, I want official profile patches, Harness Home patches, preset roots, telemetry overlays and configuration reload behavior to come from upstream, so that Desktop does not maintain copies.
22. As a developer, I want development and packaged builds to use the same command shape, so that repository-only behavior cannot hide packaging failures.
23. As a release engineer, I want the runtime closure verifier to prove that the official CLI entry, config assets, Web frontend and native dependencies are present, so that static file checks cannot produce a false green build.
24. As a release engineer, I want each Windows, macOS and Linux artifact to boot its packaged CLI and serve real HTML, so that system Node or repository dependencies cannot mask an incomplete artifact.
25. As a release engineer, I want each artifact probe to confirm that the listener and full process tree close, so that successful startup tests do not leak runtime processes.
26. As a maintainer, I want the custom Node launcher and lifecycle protocol removed, so that the Desktop codebase owns only shell-specific responsibilities.
27. As a maintainer, I want the direct-CLI decision recorded against the earlier lifecycle-protocol decision, so that ADRs and implementation describe the same architecture.
28. As a maintainer, I want failures categorized from port checks, spawn results, HTTP readiness and exit status, so that user-facing diagnostics do not depend on parsing human CLI text.
29. As a maintainer, I want expected Windows exit code 130 distinguished from an unsolicited crash, so that a requested Ctrl+C shutdown is not reported as failure.
30. As a maintainer, I want the read-only Harness submodule left untouched, so that this refactor remains entirely within Desktop ownership.

## Implementation Decisions

- Desktop will execute the pinned published `dsh` CLI entry with the packaged official Node executable. It will not import the CLI entry as a side-effect module and will not deep-import the upstream profile launcher.
- The CLI invocation will explicitly select the `web` profile and pass `--host 127.0.0.1 --port 3080`. Desktop will not rely on the CLI fallback staying unchanged.
- The Host origin is fixed to `http://127.0.0.1:3080/`. Only this exact loopback origin is permitted by the Desktop navigation policy for the owned Host.
- Before spawning the CLI, Desktop will attempt an exclusive bind of port 3080. An occupied port is a terminal startup error for that attempt, with a stable diagnostic code and a user-visible retry path. The preflight listener is released immediately before spawn; the remaining bind race is accepted for this unshipped milestone.
- Desktop will not treat successful process creation or continued process existence as readiness. It will monitor child exit while polling the fixed root URL for a successful, non-empty HTML response, then wait for the controlled WebView to finish loading the current-attempt page before publishing Ready.
- stdout and stderr are diagnostic text only. Development builds inherit them, packaged builds discard them, and Desktop neither persists them nor parses a URL, lifecycle state or error category from human CLI output.
- The CLI process receives the Desktop Harness Home through `DSH_HOME`, uses a distinct Desktop-owned default working directory as its current directory, and otherwise inherits the parent environment. The packaged Node directory remains first in PATH so plugin calls to `node` resolve to the same official runtime.
- Direct `dsh web` uses the upstream `web` profile rather than the current Desktop-specific `desktop` profile. Because the product has not shipped, no production profile migration is required. Existing development-only `desktop` profile customization is not automatically migrated and must be called out in developer notes.
- On macOS and Linux, Desktop creates an owned process group, sends the graceful SIGTERM request only to the CLI leader, waits for a bounded interval, and kills the process group only if it does not exit.
- On Windows, Desktop will create the Node CLI with a dedicated hidden console suitable for control events and retain Job Object ownership of the complete process tree. Normal shutdown will temporarily attach to that console, make the Desktop process ignore its own generated Ctrl+C, broadcast Ctrl+C to the isolated console, detach, and wait for CLI exit.
- A requested Windows Ctrl+C shutdown may return exit code 130 because that is the official CLI SIGINT contract. Desktop will treat it as success only when the same lifecycle generation already requested shutdown. The same exit without an owned shutdown request is an unexpected failure.
- `TerminateJobObject` remains a forced fallback, never the normal Windows shutdown mechanism. It runs after the graceful deadline or when process ownership cannot be recovered safely.
- Console attach/detach operations are process-global on Windows and will be serialized behind one Desktop-owned lock. Failure to attach or generate Ctrl+C moves directly to bounded forced cleanup and a cleanup diagnostic.
- The direct CLI keeps stdin free of Desktop protocols. No JSON stop command, ready event, startup-failed event, stopped event or stop-failed event remains.
- Retry, single-instance behavior, prolonged startup, startup diagnostics, external-link handling and popup rejection remain Desktop shell responsibilities and retain their current user-visible semantics.
- The runtime closure must retain the published CLI entry, its shipped configuration directory, bundle patches, frontend assets, native modules and transitive production dependencies. The custom compiled sidecar entry is removed from the packaged resource contract.
- Artifact verification will execute the packaged CLI through the packaged Node executable with the same fixed host and port arguments used by Desktop. It will prove real HTML service, graceful shutdown, listener closure and full process-tree cleanup.
- Port-conflict tests and artifact probes must run serially per machine because the contract intentionally owns fixed port 3080.
- The direct-CLI decision preserves the core Tauri plus official Node sidecar decision but contradicts the JSON lifecycle-protocol portion of ADR 0005 and the current migration specification. Implementation must add or update an ADR that explicitly supersedes that portion, then update the migration and domain documentation.
- No file or code inside the read-only Harness submodule will be modified.

## Testing Decisions

- The primary seam is the highest existing seam: a real packaged Desktop artifact launching the packaged official Node and official `dsh web` CLI. Tests assert externally visible process, HTTP, WebView and cleanup behavior rather than internal Rust function calls.
- The existing real-Harness desktop E2E will verify that startup passes through the packaged Startup page, reaches `http://127.0.0.1:3080/`, renders the real Web Client, preserves navigation policy and keeps one Host across duplicate Desktop launches.
- A packaged runtime probe on every supported target will verify that the CLI entry and runtime closure are self-contained, that root HTTP returns non-empty HTML, and that neither repository dependencies nor system Node are used.
- A port-occupied acceptance test will bind 3080 before launch and assert a controlled Failed state, no navigation to the occupying server, a stable diagnostic code, and successful Retry after the port is released.
- A startup-exit test will make the owned CLI exit before readiness and assert that Desktop fails promptly rather than waiting for the prolonged-startup threshold.
- A crash-after-Ready test will terminate the owned CLI and assert that Desktop returns to Failed while retaining safe diagnostics and recovery actions.
- Normal close tests will assert that the fixed listener closes and the owned process tree disappears. They will not assert private implementation details of the signal or console APIs.
- Windows CI will include a real control-event acceptance test. It will launch the actual packaged CLI in its dedicated console, request Desktop shutdown, accept exit 130 only for the requested generation, and verify listener and descendant cleanup before the force deadline.
- macOS and Linux CI will verify the equivalent real SIGTERM path and process-group cleanup.
- The existing stubborn-descendant seam will remain the fallback test: if graceful shutdown exceeds its bound, Desktop must terminate the complete Job Object or process group and confirm it is gone.
- Small platform-focused tests may cover command construction, fixed-origin validation, requested-versus-unexpected exit classification and Windows console-operation failure mapping. These tests supplement but do not replace the packaged acceptance seam.
- Runtime closure tests will fail when the published CLI entry or shipped preset/config assets are absent and will continue checking native workers, addons, helpers and symlink portability.
- Release-guard tests will ensure all real desktop and artifact scenarios are committed for Windows x64, macOS arm64/x64 and Linux x64, with fixed-port scenarios serialized.
- Tests will not assert CLI log wording, because stdout and stderr are explicitly not a protocol.

## Out of Scope

- Modifying, patching or adding APIs to the upstream Harness submodule or published `dsh` package.
- Importing the CLI entry into a Desktop JavaScript wrapper or depending on an undocumented deep module path as an application API.
- Dynamic port allocation, parsing a dynamic origin from CLI output, socket inheritance or adding an upstream machine-readable readiness protocol.
- Supporting multiple simultaneous Desktop Hosts or multiple Desktop instances on different ports.
- Migrating development-only data from the old `desktop` profile directory to the official `web` profile directory.
- Changing the fixed official Node version, supported platform/architecture matrix or Node executable override contract.
- Changing the Web Client, Workspace model, navigation policy, popup policy, Startup page design or future desktop capability bridge.
- Treating forced Windows Job Object termination as graceful shutdown.

## Further Notes

- The official Web profile currently uses port 3080 as its fallback. Desktop nevertheless passes the port explicitly so the fixed-origin contract is visible and versioned on the Desktop side.
- A fixed port deliberately trades collision handling for a smaller and more upstream-faithful runtime boundary. The failure page must make port occupation actionable rather than silently switching ports or connecting to an existing listener.
- Windows does not provide POSIX SIGTERM semantics for Node. Normal shutdown therefore depends on a real console Ctrl+C reaching the official CLI SIGINT handler; direct process termination is reserved for fallback cleanup.
- `CREATE_NO_WINDOW` and detached-process creation are incompatible with the required Windows control-event path. The implementation must create a dedicated console without presenting a visible console window to the user.
- The refactor should reduce Desktop-owned runtime behavior substantially: Desktop keeps native shell lifecycle and supervision, while official `dsh web` owns Harness composition and shutdown semantics.
