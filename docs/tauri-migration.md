# Tauri + 官方 Node sidecar 垂直切片

Tauri 是唯一的 Desktop shell。Tauri Rust 进程只负责窗口和 sidecar 生命周期；Harness Host 与插件全部运行在随应用发布的官方 Node.js 进程中。

```text
Tauri Rust
  └─ 官方 node(.exe) dist/sidecar/index.js
       └─ 同一 Node 进程内启动 Harness Host
            └─ loopback Web UI
```

开发与打包模式默认都读取固定版本的 `resources/node/<platform-arch>/node(.exe)`，不会依赖 PATH 或用户机器上的 Node 安装。`DSH_NODE_PATH` 是唯一的显式覆盖入口。开发和构建命令会下载该固定版本，已存在且完整时不会重复下载。sidecar 的工作目录是 Tauri 应用数据目录，`DSH_HOME` 也指向该目录。

sidecar stdout 使用逐行 JSON 传输最小生命周期事件：`ready`、`startup-failed`、`stopped`、`stop-failed`。业务请求仍由 Harness Host 的 loopback HTTP/WebSocket 处理，不通过 Rust 复制一套业务协议。窗口关闭时 Rust 发送 `{"type":"stop"}`，等待有限时间后终止进程树。

Desktop 只保有一个主窗口。Web Client 请求创建 popup 时，Desktop 不创建第二个 WebView；`http` 与 `https` 目标交由操作系统默认浏览器打开，其他协议一律拒绝。主窗口只允许加载受控的启动页及当前 sidecar 报告的 loopback origin。

## 生命周期与恢复

启动页与 Rust shell 只通过 Tauri event/command 通信，不读取 sidecar stdin/stdout，也不直接访问文件系统。Desktop 生命周期为 `Starting`、`Starting sidecar`、`Waiting for client to start`、`Ready`、`Failed`、`Stopping`。等待 30 秒后进入非终态的“启动时间较长”，继续无限等待；仅用户 Retry 或明确的启动错误才会中止本轮启动。sidecar 在 Ready 后意外退出时必须进入 Failed。启动页不向用户暴露上游 Web Client 这一内部术语。

失败页提供 Retry、Copy diagnostics 和 Open logs。Retry 必须先向已有 sidecar 请求停止，等待有限时间；超时后终止其进程树，随后才能创建新的 sidecar。诊断只包含版本、平台与架构、sidecar 路径状态、生命周期时间和脱敏错误；不得记录环境变量、凭据、会话、提示词、工具参数、工作区内容、URL 查询或 HTTP 请求体。

Desktop 使用单实例语义。重复启动只恢复并聚焦已有主窗口，不转发第二次启动的参数，也不启动第二个 Host。

## 测试与发布

CI 在 Windows x64、macOS arm64/x64 和 Linux x64 上都会先用随项目下载的固定官方 Node 启动真实 Harness，并验证 loopback HTML 响应和优雅回收。这是所有平台的运行时门禁。三平台都强制运行已提交的真实桌面 E2E，并使用 embedded `@wdio/tauri-service` provider；Linux 通过 Xvfb 运行。Computer Use 仅作 Windows 人工验证，不作为 CI 门禁。

Windows 仅构建和发布 x64 NSIS `.exe`，不构建 MSI。macOS 分别构建 arm64 与 x64 DMG，Linux 构建 x64 AppImage。CI 在每个目标平台打包官方 Node sidecar、运行 Tauri 行为测试，并保留 Harness 子模块只读校验。

## 本地运行

需要 Rust、Cargo 和 Tauri CLI。首次运行 `pnpm tauri:dev` 或 `pnpm tauri:build` 会为当前平台下载固定版本官方 Node 到 `resources/node/<platform-arch>/node(.exe)`；已有完整可执行文件时不会重复下载。若只想临时使用其他 Node，可通过 `DSH_NODE_PATH` 覆盖运行时路径：

```powershell
$env:DSH_NODE_PATH = "C:\\Program Files\\nodejs\\node.exe"
pnpm tauri:dev
```

Node 归档缓存在 Windows 的 `%LOCALAPPDATA%\\dsh-desktop\\node`，在 macOS/Linux 的 `$XDG_CACHE_HOME/dsh-desktop/node`（未设置时为 `~/.cache/dsh-desktop/node`）。每次使用缓存前都会按仓库内固定的官方 SHA-256 校验，下载中的归档不会直接写入资源目录。

当前垂直切片只包含窗口、Host 加载和 sidecar 回收；托盘、通知及桌面能力桥不在本次范围内。
