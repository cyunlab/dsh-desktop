# Launch the published `dsh web` CLI directly

Status: accepted

Desktop launches the pinned published `dsh` CLI entry with the packaged official Node executable instead of maintaining a JavaScript Host launcher and newline-delimited JSON lifecycle protocol. The CLI owns Web profile composition and runtime disposal; the Tauri shell owns a fixed `127.0.0.1:3080` origin, readiness observation, lifecycle generations, Retry, platform shutdown requests, and process-tree cleanup. This supersedes only ADR 0005's Desktop-owned sidecar protocol while preserving its Tauri and official Node runtime boundary.

## Consequences

- Desktop passes explicit `web --host 127.0.0.1 --port 3080` arguments and does not parse human CLI output.
- Customizing the Desktop Host binding through `profiles/web` or Harness Home patches is unsupported in this milestone; Desktop does not discover an alternate origin.
- macOS and Linux request graceful shutdown with SIGTERM to the CLI leader. Windows uses Ctrl+C in a dedicated hidden console. Owned process groups and Job Objects provide bounded forced cleanup.
- The development-only `profiles/desktop` data is neither migrated nor deleted because the product has not shipped.
