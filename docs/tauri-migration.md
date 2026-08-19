# Tauri + 官方 Node sidecar 垂直切片

当前迁移保留 Electron 入口作为对照，新增 Tauri shell 作为实验性运行路径。Tauri Rust 进程只负责窗口和 sidecar 生命周期；Harness Host 与插件全部运行在随应用发布的官方 Node.js 进程中。

```text
Tauri Rust
  └─ 官方 node(.exe) dist/sidecar/index.js
       └─ 同一 Node 进程内启动 Harness Host
            └─ loopback Web UI
```

开发模式下，Node 可执行文件按以下顺序解析：`DSH_NODE_PATH`、PATH 中的 `node`。打包模式只读取 `resources/node/<platform-arch>/node(.exe)`，不会依赖用户机器上的 Node 安装。sidecar 的工作目录是 Tauri 应用数据目录，`DSH_HOME` 也指向该目录。

sidecar stdout 使用逐行 JSON 传输最小生命周期事件：`ready`、`startup-failed`、`stopped`、`stop-failed`。业务请求仍由 Harness Host 的 loopback HTTP/WebSocket 处理，不通过 Rust 复制一套业务协议。窗口关闭时 Rust 发送 `{"type":"stop"}`，等待有限时间后终止进程树。

## 本地运行

需要 Rust、Cargo 和 Tauri CLI。安装官方 Node 后可通过 `DSH_NODE_PATH` 指定可执行文件：

```powershell
$env:DSH_NODE_PATH = "C:\\Program Files\\nodejs\\node.exe"
pnpm tauri:dev
```

当前垂直切片只包含窗口、Host 加载和 sidecar 回收；托盘、通知及桌面能力桥不在本次范围内。
