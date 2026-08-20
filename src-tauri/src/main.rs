#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod lifecycle;

use lifecycle::{
    cleanup_then_restart, stop_process, wait_for_readiness, LifecycleAction, LifecycleMachine,
    ProcessControl, ReadinessWaitError, SidecarEvent,
};
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_opener::OpenerExt;

#[cfg(unix)]
use std::os::unix::process::CommandExt;
#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
use windows_sys::Win32::Foundation::{CloseHandle, HANDLE, INVALID_HANDLE_VALUE};
#[cfg(windows)]
use windows_sys::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Thread32First, Thread32Next, TH32CS_SNAPTHREAD, THREADENTRY32,
};
#[cfg(windows)]
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JobObjectBasicAccountingInformation,
    JobObjectExtendedLimitInformation, QueryInformationJobObject, SetInformationJobObject,
    TerminateJobObject, JOBOBJECT_BASIC_ACCOUNTING_INFORMATION,
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
};
#[cfg(windows)]
use windows_sys::Win32::System::Threading::{
    OpenProcess, OpenThread, ResumeThread, CREATE_NEW_PROCESS_GROUP, CREATE_SUSPENDED,
    PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SET_QUOTA, PROCESS_TERMINATE, THREAD_SUSPEND_RESUME,
};

const SNAPSHOT_EVENT: &str = "startup:snapshot";
const PROLONGED_STARTUP_AFTER: Duration = Duration::from_secs(30);
const SIDECAR_STOP_AFTER: Duration = Duration::from_secs(8);
const SIDECAR_FORCE_CONFIRM_AFTER: Duration = Duration::from_secs(5);
const BUNDLED_NODE_VERSION: &str = "24.19.0";

/// Sidecar 生命周期消息的 JSON 表示。
#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "kebab-case", tag = "type")]
enum SidecarMessage {
    Ready {
        origin: String,
    },
    StartupFailed {
        #[serde(rename = "error")]
        _error: SidecarError,
    },
    Stopped,
    StopFailed {
        #[serde(rename = "error")]
        _error: SidecarError,
    },
}

/// Sidecar 返回的可序列化错误。
#[derive(Debug, Deserialize, Clone)]
struct SidecarError {}

/// 生命周期状态，序列化后作为启动页的稳定协议。
#[derive(Debug, Serialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
enum LifecycleState {
    Starting,
    StartingSidecar,
    WaitingForClient,
    ProlongedStartup,
    Ready,
    Failed,
    Stopping,
}

/// 启动页可见的生命周期快照。
#[derive(Debug, Serialize, Clone)]
struct LifecycleSnapshot {
    state: LifecycleState,
    message: String,
    origin: Option<String>,
}

/// 允许复制到诊断信息中的安全错误分类。
#[derive(Debug, Serialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum DiagnosticCode {
    /// 无法解析 Tauri 资源目录。
    ResourceUnavailable,
    /// 官方 Node 不存在且没有显式覆盖。
    NodeUnavailable,
    /// sidecar bootstrap 不存在。
    BootstrapUnavailable,
    /// 无法准备应用数据目录。
    AppDataUnavailable,
    /// 无法创建或接管 sidecar 进程树。
    SpawnFailed,
    /// sidecar 返回了启动失败消息。
    StartupFailed,
    /// sidecar 返回了停止失败消息。
    StopFailed,
    /// sidecar 返回了不允许的 origin。
    InvalidOrigin,
    /// sidecar 在 ready 或 listener 等待期间退出。
    UnexpectedExit,
    /// 进程树清理没有得到确认。
    CleanupFailed,
    /// 内部状态或 listener 探测失败。
    InternalFailure,
}

/// 描述当前 sidecar 的进程树拥有关系。
#[cfg(windows)]
struct ProcessOwnership {
    /// Windows Job Object 句柄；句柄关闭时会终止仍属于该 Job 的后代。
    job: isize,
}

#[cfg(windows)]
impl ProcessOwnership {
    /// 为挂起的新进程创建并附加带有 kill-on-close 语义的 Job Object。
    fn attach(pid: u32) -> Result<Self, String> {
        let job = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
        if job.is_null() {
            return Err("failed to create sidecar Job Object".into());
        }
        let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let configured = unsafe {
            SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                &mut limits as *mut _ as *mut std::ffi::c_void,
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
        } != 0;
        if !configured {
            unsafe { CloseHandle(job) };
            return Err("failed to configure sidecar Job Object".into());
        }
        let process = unsafe {
            OpenProcess(
                PROCESS_SET_QUOTA | PROCESS_TERMINATE | PROCESS_QUERY_LIMITED_INFORMATION,
                0,
                pid,
            )
        };
        if process.is_null() {
            unsafe { CloseHandle(job) };
            return Err("failed to open suspended sidecar process".into());
        }
        let assigned = unsafe { AssignProcessToJobObject(job, process) != 0 };
        unsafe { CloseHandle(process) };
        if !assigned {
            unsafe { CloseHandle(job) };
            return Err("failed to assign suspended sidecar to Job Object".into());
        }
        Ok(Self { job: job as isize })
    }

    /// 在 Job Object 接管完成后恢复挂起 sidecar 的全部初始线程。
    fn resume_suspended(&self, pid: u32) -> Result<(), String> {
        let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0) };
        if snapshot == INVALID_HANDLE_VALUE {
            return Err("failed to enumerate suspended sidecar threads".into());
        }
        let mut entry: THREADENTRY32 = unsafe { std::mem::zeroed() };
        entry.dwSize = std::mem::size_of::<THREADENTRY32>() as u32;
        let mut found = false;
        let mut has_entry = unsafe { Thread32First(snapshot, &mut entry) != 0 };
        while has_entry {
            if entry.th32OwnerProcessID == pid {
                let thread_handle =
                    unsafe { OpenThread(THREAD_SUSPEND_RESUME, 0, entry.th32ThreadID) };
                if thread_handle.is_null() {
                    unsafe { CloseHandle(snapshot) };
                    return Err("failed to open suspended sidecar thread".into());
                }
                let resume_result = unsafe { ResumeThread(thread_handle) };
                unsafe { CloseHandle(thread_handle) };
                if resume_result == u32::MAX {
                    unsafe { CloseHandle(snapshot) };
                    return Err("failed to resume suspended sidecar thread".into());
                }
                found = true;
            }
            has_entry = unsafe { Thread32Next(snapshot, &mut entry) != 0 };
        }
        unsafe { CloseHandle(snapshot) };
        if found {
            Ok(())
        } else {
            Err("suspended sidecar thread was not found".into())
        }
    }

    /// 终止 Job Object 中的整个 sidecar 进程树。
    fn force_kill_tree(&self) -> Result<(), String> {
        if unsafe { TerminateJobObject(self.job as HANDLE, 1) } != 0 {
            Ok(())
        } else {
            Err("failed to terminate sidecar Job Object".into())
        }
    }

    /// 查询 Job Object 中的 sidecar 和后代是否都已退出。
    fn tree_has_exited(&self) -> Result<bool, String> {
        let mut accounting: JOBOBJECT_BASIC_ACCOUNTING_INFORMATION = unsafe { std::mem::zeroed() };
        let queried = unsafe {
            QueryInformationJobObject(
                self.job as HANDLE,
                JobObjectBasicAccountingInformation,
                &mut accounting as *mut _ as *mut std::ffi::c_void,
                std::mem::size_of::<JOBOBJECT_BASIC_ACCOUNTING_INFORMATION>() as u32,
                std::ptr::null_mut(),
            )
        } != 0;
        if queried {
            Ok(accounting.ActiveProcesses == 0)
        } else {
            Err("failed to query sidecar Job Object".into())
        }
    }
}

#[cfg(windows)]
impl Drop for ProcessOwnership {
    /// 关闭 Job Object 句柄，确保仍存活的拥有进程树不会脱离桌面端。
    fn drop(&mut self) {
        unsafe { CloseHandle(self.job as HANDLE) };
    }
}

#[cfg(unix)]
struct ProcessOwnership {
    /// sidecar 独立进程组的组长 PID。
    pgid: i32,
}

#[cfg(unix)]
impl ProcessOwnership {
    /// 记录由 CommandExt 创建的独立进程组。
    fn attach(pid: u32) -> Result<Self, String> {
        Ok(Self { pgid: pid as i32 })
    }

    /// 向独立进程组发送 SIGKILL，覆盖 sidecar 生成的后代。
    fn force_kill_tree(&self) -> Result<(), String> {
        let result = unsafe { libc::kill(-self.pgid, libc::SIGKILL) };
        if result == 0 {
            Ok(())
        } else {
            let error = std::io::Error::last_os_error();
            if error.raw_os_error() == Some(libc::ESRCH) {
                Ok(())
            } else {
                Err(format!(
                    "failed to kill sidecar process group {}: {error}",
                    self.pgid
                ))
            }
        }
    }

    /// 检查独立 Unix 进程组是否仍包含存活成员。
    fn tree_has_exited(&self) -> Result<bool, String> {
        let result = unsafe { libc::kill(-self.pgid, 0) };
        if result == 0 {
            return Ok(false);
        }
        let error = std::io::Error::last_os_error();
        match error.raw_os_error() {
            Some(libc::ESRCH) => Ok(true),
            Some(libc::EPERM) => Ok(false),
            _ => Err(format!(
                "failed to query sidecar process group {}: {error}",
                self.pgid
            )),
        }
    }
}

#[cfg(not(any(unix, windows)))]
struct ProcessOwnership;

#[cfg(not(any(unix, windows)))]
impl ProcessOwnership {
    /// 在未实现进程组 API 的平台上创建直接子进程拥有关系。
    fn attach(_pid: u32) -> Result<Self, String> {
        Ok(Self)
    }

    /// 未实现平台由 SidecarProcess 的 Child::kill 提供兜底。
    fn force_kill_tree(&self) -> Result<(), String> {
        Ok(())
    }

    /// 未实现平台只能由直接子进程的退出状态决定树是否结束。
    fn tree_has_exited(&self) -> Result<bool, String> {
        Ok(true)
    }
}

/// 由 Tauri 持有并可在重试期间共享的 Node sidecar 句柄。
struct SidecarProcess {
    /// 官方 Node 子进程句柄。
    child: Mutex<Child>,
    /// 发给 sidecar 的控制管道。
    stdin: Mutex<Option<ChildStdin>>,
    /// 当前进程树的拥有关系。
    ownership: ProcessOwnership,
    /// 串行化停止请求，防止关闭和 Retry 同时强杀同一棵树。
    stop_lock: Mutex<()>,
}

impl ProcessControl for SidecarProcess {
    /// 通过 sidecar 控制协议请求优雅停止。
    fn request_graceful_stop(&self) -> Result<(), String> {
        let mut stdin = self
            .stdin
            .lock()
            .map_err(|_| "sidecar stdin lock poisoned".to_string())?;
        let Some(input) = stdin.as_mut() else {
            return Err("sidecar stdin is unavailable".into());
        };
        writeln!(input, "{{\"type\":\"stop\"}}").map_err(|error| error.to_string())?;
        input.flush().map_err(|error| error.to_string())
    }

    /// 查询官方 Node 子进程是否退出。
    fn has_exited(&self) -> Result<bool, String> {
        let mut child = self
            .child
            .lock()
            .map_err(|_| "sidecar child lock poisoned".to_string())?;
        let child_exited = child
            .try_wait()
            .map(|status| status.is_some())
            .map_err(|error| error.to_string())?;
        Ok(child_exited && self.ownership.tree_has_exited()?)
    }

    /// 终止拥有的整个进程树，并在必要时直接终止组长。
    fn force_kill_tree(&self) -> Result<(), String> {
        self.ownership.force_kill_tree()
    }

    /// 等待并回收官方 Node 子进程句柄。
    fn reap(&self) -> Result<(), String> {
        let mut child = self
            .child
            .lock()
            .map_err(|_| "sidecar child lock poisoned".to_string())?;
        child.wait().map_err(|error| error.to_string())?;
        Ok(())
    }
}

impl SidecarProcess {
    /// 仅检查直接 Node 子进程，用于 readiness 期间快速识别 Host 崩溃。
    fn child_has_exited(&self) -> Result<bool, String> {
        let mut child = self
            .child
            .lock()
            .map_err(|_| "sidecar child lock poisoned".to_string())?;
        child
            .try_wait()
            .map(|status| status.is_some())
            .map_err(|error| error.to_string())
    }
}

/// 在有界期限内确认并回收一个直接子进程。
fn wait_and_reap_child(child: &mut Child, timeout: Duration) -> Result<(), String> {
    let deadline = Instant::now() + timeout;
    loop {
        if child
            .try_wait()
            .map_err(|error| error.to_string())?
            .is_some()
        {
            return Ok(());
        }
        if Instant::now() >= deadline {
            return Err("sidecar child did not exit before cleanup deadline".into());
        }
        thread::sleep(Duration::from_millis(25));
    }
}

/// 在 Windows Job 接管失败时终止仍处于挂起状态且尚无后代的子进程。
#[cfg(windows)]
fn terminate_unowned_suspended_child(child: &mut Child) -> Result<(), String> {
    let pid = child.id().to_string();
    let taskkill_succeeded = Command::new("taskkill")
        .args(["/PID", &pid, "/T", "/F"])
        .status()
        .is_ok_and(|status| status.success());
    if !taskkill_succeeded {
        child.kill().map_err(|error| error.to_string())?;
    }
    wait_and_reap_child(child, SIDECAR_FORCE_CONFIRM_AFTER)
}

/// 在非 Windows 平台终止尚未完成拥有关系初始化的直接子进程。
#[cfg(not(windows))]
fn terminate_unowned_suspended_child(child: &mut Child) -> Result<(), String> {
    child.kill().map_err(|error| error.to_string())?;
    wait_and_reap_child(child, SIDECAR_FORCE_CONFIRM_AFTER)
}

/// 强制终止已接管的进程树并在有界期限内确认树和组长全部退出。
fn terminate_owned_child(ownership: &ProcessOwnership, child: &mut Child) -> Result<(), String> {
    ownership.force_kill_tree()?;
    let deadline = Instant::now() + SIDECAR_FORCE_CONFIRM_AFTER;
    let mut child_exited = false;
    loop {
        if !child_exited {
            child_exited = child
                .try_wait()
                .map_err(|error| error.to_string())?
                .is_some();
        }
        if child_exited && ownership.tree_has_exited()? {
            return Ok(());
        }
        if Instant::now() >= deadline {
            return Err("sidecar process tree did not exit before cleanup deadline".into());
        }
        thread::sleep(Duration::from_millis(25));
    }
}

/// Tauri shell 的共享运行时状态。
struct RuntimeState {
    snapshot: Mutex<LifecycleSnapshot>,
    process: Mutex<Option<Arc<SidecarProcess>>>,
    /// 串行化 spawn、Retry 和 shutdown，避免旧进程尚未回收时创建替代 Host。
    lifecycle_gate: Mutex<()>,
    host_origin: Mutex<Option<String>>,
    startup_url: Mutex<Option<String>>,
    generation: AtomicU64,
    retrying: AtomicBool,
    shutting_down: AtomicBool,
    /// 当前启动轮次开始时间，用于诊断而不暴露本机路径。
    attempt_started: Mutex<Option<Instant>>,
    /// 官方 Node 可执行文件来源和路径状态的脱敏描述。
    node_path_status: Mutex<String>,
    logs_dir: PathBuf,
    last_error: Mutex<Option<DiagnosticCode>>,
}

/// 解析官方 Node sidecar 的生命周期输出。
fn parse_sidecar_message(line: &str) -> Result<SidecarMessage, String> {
    serde_json::from_str(line).map_err(|error| format!("invalid sidecar message: {error}"))
}

/// 判断一个 URL 是否是当前 Desktop 允许的精确 loopback origin。
fn is_allowed_host_origin(origin: &str) -> bool {
    let Ok(url) = origin.parse::<tauri::Url>() else {
        return false;
    };
    url.scheme() == "http"
        && url.host_str() == Some("127.0.0.1")
        && url.port().is_some()
        && url.path() == "/"
        && url.query().is_none()
        && url.fragment().is_none()
}

/// 对窗口导航作出允许、交给系统浏览器或拒绝的决定。
fn decide_navigation(
    raw_url: &str,
    startup_url: &str,
    host_origin: Option<&str>,
) -> NavigationDecision {
    if raw_url == startup_url {
        return NavigationDecision::Allow;
    }
    let Ok(target) = raw_url.parse::<tauri::Url>() else {
        return NavigationDecision::Deny;
    };
    if host_origin.is_some_and(|origin| {
        target.origin().ascii_serialization() == origin && target.scheme() == "http"
    }) {
        return NavigationDecision::Allow;
    }
    if target.scheme() == "http" || target.scheme() == "https" {
        return NavigationDecision::External;
    }
    NavigationDecision::Deny
}

/// 导航策略的三种结果。
#[derive(Debug, PartialEq, Eq)]
enum NavigationDecision {
    Allow,
    External,
    Deny,
}

/// 返回当前构建目标使用的 Node 资源目录名。
fn platform_arch() -> &'static str {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("windows", "x86_64") => "windows-x86_64",
        ("windows", "aarch64") => "windows-aarch64",
        ("macos", "x86_64") => "macos-x86_64",
        ("macos", "aarch64") => "macos-aarch64",
        ("linux", "x86_64") => "linux-x86_64",
        ("linux", "aarch64") => "linux-aarch64",
        _ => "unsupported",
    }
}

/// 返回官方 Node 归档在 Unix 与 Windows 上的相对可执行文件路径。
fn bundled_node_relative_path() -> PathBuf {
    if cfg!(windows) {
        PathBuf::from("node.exe")
    } else {
        PathBuf::from("node")
    }
}

/// 返回官方 Node 可执行文件的脱敏来源，避免诊断文本泄露用户目录。
fn node_path_status(resource_dir: &Path) -> &'static str {
    if std::env::var_os("DSH_NODE_PATH").is_some_and(|value| !value.is_empty()) {
        return "override";
    }
    if resource_dir
        .join("node")
        .join(platform_arch())
        .join(bundled_node_relative_path())
        .is_file()
    {
        return "bundled";
    }
    "missing"
}

/// 解析开发态或打包态的官方 Node 可执行文件路径。
fn resolve_node_path(resource_dir: &Path) -> Result<PathBuf, String> {
    if let Some(path) = std::env::var_os("DSH_NODE_PATH").filter(|value| !value.is_empty()) {
        return Ok(PathBuf::from(path));
    }
    let bundled = resource_dir
        .join("node")
        .join(platform_arch())
        .join(bundled_node_relative_path());
    if bundled.is_file() {
        return Ok(bundled);
    }
    Err(format!(
        "official Node sidecar is missing: {}",
        bundled.display()
    ))
}

/// 发布一份生命周期快照，并通知当前 Webview。
fn publish_snapshot(app: &AppHandle, state: &RuntimeState, snapshot: LifecycleSnapshot) {
    if let Ok(mut current) = state.snapshot.lock() {
        *current = snapshot.clone();
    }
    let _ = app.emit_to("main", SNAPSHOT_EVENT, snapshot);
}

/// 生成并发布一个状态。
fn transition(
    app: &AppHandle,
    state: &RuntimeState,
    lifecycle: LifecycleState,
    message: impl Into<String>,
) {
    publish_snapshot(
        app,
        state,
        LifecycleSnapshot {
            state: lifecycle,
            message: message.into(),
            origin: state
                .host_origin
                .lock()
                .ok()
                .and_then(|value| value.clone()),
        },
    );
}

/// 判断某个启动轮次是否仍然有效。
fn is_current(state: &RuntimeState, generation: u64) -> bool {
    !state.shutting_down.load(Ordering::Acquire)
        && state.generation.load(Ordering::Acquire) == generation
}

/// 等待 Harness loopback listener；等待超过 30 秒只进入可恢复状态，不自动失败。
fn wait_for_web_listener(
    app: &AppHandle,
    state: &RuntimeState,
    generation: u64,
    process: &Arc<SidecarProcess>,
    origin: &str,
) -> Result<(), ReadinessWaitError> {
    let address = origin
        .strip_prefix("http://")
        .ok_or(ReadinessWaitError::ProbeFailed)?
        .parse::<SocketAddr>()
        .map_err(|_| ReadinessWaitError::ProbeFailed)?;
    wait_for_readiness(
        || is_current(state, generation),
        || process.child_has_exited(),
        || Ok(TcpStream::connect_timeout(&address, Duration::from_millis(500)).is_ok()),
        PROLONGED_STARTUP_AFTER,
        Duration::from_millis(100),
        || {
            transition(
                app,
                state,
                LifecycleState::ProlongedStartup,
                "Startup is taking longer than expected. You can retry when ready.",
            );
        },
    )
}

/// 启动一个官方 Node sidecar，并返回共享进程句柄与生命周期消息通道。
fn spawn_sidecar(
    app: &AppHandle,
    state: &RuntimeState,
    generation: u64,
) -> Result<(Arc<SidecarProcess>, mpsc::Receiver<SidecarMessage>), DiagnosticCode> {
    let _gate = state
        .lifecycle_gate
        .lock()
        .map_err(|_| DiagnosticCode::InternalFailure)?;
    if !is_current(state, generation) {
        return Err(DiagnosticCode::InternalFailure);
    }
    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|_| DiagnosticCode::ResourceUnavailable)?;
    if let Ok(mut status) = state.node_path_status.lock() {
        *status = node_path_status(&resource_dir).into();
    }
    let node_path =
        resolve_node_path(&resource_dir).map_err(|_| DiagnosticCode::NodeUnavailable)?;
    let script = if cfg!(debug_assertions) {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../dist/sidecar/index.js")
    } else {
        resource_dir.join("dist/sidecar/index.js")
    };
    if !script.is_file() {
        return Err(DiagnosticCode::BootstrapUnavailable);
    }
    let harness_home = app
        .path()
        .app_data_dir()
        .map_err(|_| DiagnosticCode::AppDataUnavailable)?;
    fs::create_dir_all(&harness_home).map_err(|_| DiagnosticCode::AppDataUnavailable)?;
    let mut command = Command::new(node_path);
    command
        .arg(script)
        .current_dir(&harness_home)
        .env("DSH_HOME", &harness_home)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit());
    #[cfg(windows)]
    command.creation_flags(CREATE_NEW_PROCESS_GROUP | CREATE_SUSPENDED);
    #[cfg(unix)]
    command.process_group(0);
    let mut child = command.spawn().map_err(|_| DiagnosticCode::SpawnFailed)?;
    let pid = child.id();
    let ownership = match ProcessOwnership::attach(pid) {
        Ok(ownership) => ownership,
        Err(_) => {
            return Err(if terminate_unowned_suspended_child(&mut child).is_ok() {
                DiagnosticCode::SpawnFailed
            } else {
                DiagnosticCode::CleanupFailed
            });
        }
    };
    #[cfg(windows)]
    if ownership.resume_suspended(pid).is_err() {
        return Err(if terminate_owned_child(&ownership, &mut child).is_ok() {
            DiagnosticCode::SpawnFailed
        } else {
            DiagnosticCode::CleanupFailed
        });
    }
    let stdin = match child.stdin.take() {
        Some(stdin) => stdin,
        None => {
            return Err(if terminate_owned_child(&ownership, &mut child).is_ok() {
                DiagnosticCode::SpawnFailed
            } else {
                DiagnosticCode::CleanupFailed
            });
        }
    };
    let stdout = match child.stdout.take() {
        Some(stdout) => stdout,
        None => {
            return Err(if terminate_owned_child(&ownership, &mut child).is_ok() {
                DiagnosticCode::SpawnFailed
            } else {
                DiagnosticCode::CleanupFailed
            });
        }
    };
    let process = Arc::new(SidecarProcess {
        ownership,
        child: Mutex::new(child),
        stdin: Mutex::new(Some(stdin)),
        stop_lock: Mutex::new(()),
    });
    if let Ok(mut current) = state.process.lock() {
        *current = Some(Arc::clone(&process));
    } else {
        let _ = stop_sidecar(&process);
        return Err(DiagnosticCode::InternalFailure);
    }
    if !is_current(state, generation) {
        return Err(DiagnosticCode::InternalFailure);
    }
    let (sender, receiver) = mpsc::channel();
    thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if let Ok(message) = parse_sidecar_message(line.trim()) {
                let _ = sender.send(message);
            }
        }
    });
    Ok((process, receiver))
}

/// 终止 sidecar，并在优雅停止超时后终止整个进程树。
fn stop_sidecar(process: &Arc<SidecarProcess>) -> Result<(), String> {
    let _stop_guard = process
        .stop_lock
        .lock()
        .map_err(|_| "sidecar stop lock poisoned".to_string())?;
    stop_process(
        process.as_ref(),
        SIDECAR_STOP_AFTER,
        SIDECAR_FORCE_CONFIRM_AFTER,
    )
    .map(|_| ())
}

/// 将窗口导航到打包启动页，供失败和崩溃恢复复用。
fn navigate_to_startup(app: &AppHandle, state: &RuntimeState) {
    let Some(raw_url) = state
        .startup_url
        .lock()
        .ok()
        .and_then(|value| value.clone())
    else {
        return;
    };
    let Ok(url) = raw_url.parse() else { return };
    let app = app.clone();
    let app_for_task = app.clone();
    let _ = app.run_on_main_thread(move || {
        if let Some(window) = app_for_task.get_webview_window("main") {
            let _ = window.navigate(url);
        }
    });
}

/// 将窗口导航到当前启动轮次的 Host 页面。
fn navigate_to_host(app: &AppHandle, origin: &str) {
    let Ok(url) = origin.parse() else { return };
    let app = app.clone();
    let app_for_task = app.clone();
    let _ = app.run_on_main_thread(move || {
        if let Some(window) = app_for_task.get_webview_window("main") {
            let _ = window.navigate(url);
        }
    });
}

/// 记录启动失败并恢复到统一启动页。
fn fail_attempt(app: &AppHandle, state: &RuntimeState, generation: u64, code: DiagnosticCode) {
    if !is_current(state, generation) {
        return;
    }
    if let Ok(mut origin) = state.host_origin.lock() {
        *origin = None;
    }
    if let Ok(mut last_error) = state.last_error.lock() {
        *last_error = Some(code);
    }
    transition(
        app,
        state,
        LifecycleState::Failed,
        "Startup failed. Retry, copy diagnostics, or open logs.",
    );
    navigate_to_startup(app, state);
}

/// 仅在状态仍指向同一个 sidecar 时清除共享句柄，避免误删替代轮次。
fn clear_process(state: &RuntimeState, process: &Arc<SidecarProcess>) {
    if let Ok(mut current) = state.process.lock() {
        if current
            .as_ref()
            .is_some_and(|candidate| Arc::ptr_eq(candidate, process))
        {
            *current = None;
        }
    }
}

/// 清理失败或崩溃的启动轮次，并在展示错误前确认进程树已经回收。
fn abort_attempt(
    app: &AppHandle,
    state: &RuntimeState,
    generation: u64,
    process: &Arc<SidecarProcess>,
    code: DiagnosticCode,
) {
    let cleanup = stop_sidecar(process);
    if cleanup.is_ok() {
        clear_process(state, process);
    }
    fail_attempt(
        app,
        state,
        generation,
        if cleanup.is_ok() {
            code
        } else {
            DiagnosticCode::CleanupFailed
        },
    );
}

/// 执行一个启动轮次，并在 sidecar 意外退出时回到启动失败页。
fn run_attempt(app: AppHandle, state: Arc<RuntimeState>, generation: u64) {
    transition(
        &app,
        &state,
        LifecycleState::StartingSidecar,
        "Starting local Host.",
    );
    let (process, receiver) = match spawn_sidecar(&app, &state, generation) {
        Ok(result) => result,
        Err(error) => {
            fail_attempt(&app, &state, generation, error);
            return;
        }
    };
    transition(
        &app,
        &state,
        LifecycleState::WaitingForClient,
        "Waiting for client to start.",
    );
    let started = Instant::now();
    let mut machine = LifecycleMachine::new();
    loop {
        if !is_current(&state, generation) {
            return;
        }
        if let Ok(message) = receiver.recv_timeout(Duration::from_millis(100)) {
            match message {
                SidecarMessage::Ready { origin } => {
                    if !is_allowed_host_origin(&origin) {
                        abort_attempt(
                            &app,
                            &state,
                            generation,
                            &process,
                            DiagnosticCode::InvalidOrigin,
                        );
                        return;
                    }
                    match machine.observe(SidecarEvent::Ready(origin.clone())) {
                        LifecycleAction::Ready(origin) => {
                            if let Ok(mut current) = state.host_origin.lock() {
                                *current = Some(origin.clone());
                            }
                            if let Err(error) =
                                wait_for_web_listener(&app, &state, generation, &process, &origin)
                            {
                                match error {
                                    ReadinessWaitError::Cancelled => {}
                                    ReadinessWaitError::ProcessExited => abort_attempt(
                                        &app,
                                        &state,
                                        generation,
                                        &process,
                                        DiagnosticCode::UnexpectedExit,
                                    ),
                                    ReadinessWaitError::ProbeFailed => abort_attempt(
                                        &app,
                                        &state,
                                        generation,
                                        &process,
                                        DiagnosticCode::InternalFailure,
                                    ),
                                }
                                return;
                            }
                            transition(&app, &state, LifecycleState::Ready, "Ready.");
                            navigate_to_host(&app, &origin);
                        }
                        LifecycleAction::Fail => {
                            abort_attempt(
                                &app,
                                &state,
                                generation,
                                &process,
                                DiagnosticCode::UnexpectedExit,
                            );
                            return;
                        }
                        LifecycleAction::Ignore => {}
                    }
                }
                SidecarMessage::StartupFailed { _error: _ } => {
                    if let LifecycleAction::Fail = machine.observe(SidecarEvent::StartupFailed) {
                        abort_attempt(
                            &app,
                            &state,
                            generation,
                            &process,
                            DiagnosticCode::StartupFailed,
                        );
                    }
                    return;
                }
                SidecarMessage::StopFailed { _error: _ } => {
                    if let LifecycleAction::Fail = machine.observe(SidecarEvent::StartupFailed) {
                        abort_attempt(
                            &app,
                            &state,
                            generation,
                            &process,
                            DiagnosticCode::StopFailed,
                        );
                    }
                    return;
                }
                SidecarMessage::Stopped => {
                    if let LifecycleAction::Fail = machine.observe(SidecarEvent::Stopped) {
                        abort_attempt(
                            &app,
                            &state,
                            generation,
                            &process,
                            DiagnosticCode::UnexpectedExit,
                        );
                    }
                    return;
                }
            }
        }
        if started.elapsed() >= PROLONGED_STARTUP_AFTER
            && state
                .snapshot
                .lock()
                .ok()
                .is_some_and(|snapshot| snapshot.state == LifecycleState::WaitingForClient)
        {
            transition(
                &app,
                &state,
                LifecycleState::ProlongedStartup,
                "Startup is taking longer than expected. You can retry when ready.",
            );
        }
        match process.child_has_exited() {
            Ok(true)
                if is_current(&state, generation)
                    && matches!(machine.observe(SidecarEvent::Exited), LifecycleAction::Fail) =>
            {
                abort_attempt(
                    &app,
                    &state,
                    generation,
                    &process,
                    DiagnosticCode::UnexpectedExit,
                );
                return;
            }
            Ok(true) => return,
            Ok(false) => {}
            Err(_) => {
                abort_attempt(
                    &app,
                    &state,
                    generation,
                    &process,
                    DiagnosticCode::InternalFailure,
                );
                return;
            }
        }
    }
}

/// 启动一个新的、唯一的 sidecar 启动轮次。
fn start_attempt(app: &AppHandle, state: &Arc<RuntimeState>) {
    let generation = state.generation.fetch_add(1, Ordering::AcqRel) + 1;
    if let Ok(mut started) = state.attempt_started.lock() {
        *started = Some(Instant::now());
    }
    if let Ok(mut origin) = state.host_origin.lock() {
        *origin = None;
    }
    transition(app, state, LifecycleState::Starting, "Starting.");
    let app = app.clone();
    let state = Arc::clone(state);
    thread::spawn(move || run_attempt(app, state, generation));
}

/// 请求一次串行重试；旧进程回收完成前绝不启动新 Host。
fn request_retry(app: &AppHandle, state: &Arc<RuntimeState>) {
    if state.shutting_down.load(Ordering::Acquire) || state.retrying.swap(true, Ordering::AcqRel) {
        return;
    }
    let cleanup_generation = state.generation.fetch_add(1, Ordering::AcqRel) + 1;
    transition(
        app,
        state,
        LifecycleState::Stopping,
        "Stopping the previous Host before retry.",
    );
    let app = app.clone();
    let state = Arc::clone(state);
    thread::spawn(move || {
        let Ok(_gate) = state.lifecycle_gate.lock() else {
            state.retrying.store(false, Ordering::Release);
            return;
        };
        let process = state
            .process
            .lock()
            .ok()
            .and_then(|mut current| current.take());
        let cleanup = cleanup_then_restart(
            process
                .as_deref()
                .map(|process| process as &dyn ProcessControl),
            SIDECAR_STOP_AFTER,
            SIDECAR_FORCE_CONFIRM_AFTER,
            || {
                state.retrying.store(false, Ordering::Release);
                if !state.shutting_down.load(Ordering::Acquire) {
                    start_attempt(&app, &state);
                }
            },
        );
        if cleanup.is_err() {
            if let Some(process) = process {
                if let Ok(mut current) = state.process.lock() {
                    *current = Some(process);
                }
            }
            state.retrying.store(false, Ordering::Release);
            fail_attempt(
                &app,
                &state,
                cleanup_generation,
                DiagnosticCode::CleanupFailed,
            );
        }
        drop(_gate);
    });
}

/// 请求应用退出，并保证 sidecar 进程树被回收。
fn request_shutdown(app: &AppHandle, state: &Arc<RuntimeState>) {
    if state.shutting_down.swap(true, Ordering::AcqRel) {
        return;
    }
    state.generation.fetch_add(1, Ordering::AcqRel);
    transition(app, state, LifecycleState::Stopping, "Stopping local Host.");
    let app = app.clone();
    let state = Arc::clone(state);
    thread::spawn(move || {
        let Ok(_gate) = state.lifecycle_gate.lock() else {
            app.exit(1);
            return;
        };
        let process = state
            .process
            .lock()
            .ok()
            .and_then(|mut current| current.take());
        let cleanup_failed = process
            .as_ref()
            .is_some_and(|process| stop_sidecar(process).is_err());
        drop(_gate);
        app.exit(if cleanup_failed { 1 } else { 0 });
    });
}

/// 返回当前启动页状态。
#[tauri::command]
fn startup_snapshot(state: State<'_, Arc<RuntimeState>>) -> LifecycleSnapshot {
    state
        .snapshot
        .lock()
        .map(|snapshot| snapshot.clone())
        .unwrap_or(LifecycleSnapshot {
            state: LifecycleState::Starting,
            message: "Starting.".into(),
            origin: None,
        })
}

/// 处理启动页的 Retry 命令。
#[tauri::command]
fn startup_retry(app: AppHandle, state: State<'_, Arc<RuntimeState>>) -> Result<(), String> {
    request_retry(&app, state.inner());
    Ok(())
}

/// 描述可复制到 issue 的脱敏启动诊断字段。
#[derive(Debug, Serialize)]
struct StartupDiagnostics {
    /// 当前桌面应用版本。
    app_version: String,
    /// 默认或覆盖的 Node 版本说明。
    node_version: String,
    /// 当前编译目标操作系统。
    platform: String,
    /// 当前编译目标 CPU 架构。
    arch: String,
    /// 当前生命周期状态。
    lifecycle_state: String,
    /// 当前轮次已经运行的毫秒数。
    lifecycle_elapsed_ms: u128,
    /// 官方 Node/sidecar 路径来源的脱敏状态。
    sidecar_path_status: String,
    /// 当前是否仍有被桌面端拥有的 sidecar。
    sidecar_process_status: String,
    /// 最近一次允许复制的稳定错误分类。
    error_code: Option<DiagnosticCode>,
}

/// 构造不包含本机绝对路径的启动诊断文本。
fn build_startup_diagnostics(state: &RuntimeState, snapshot: &LifecycleSnapshot) -> String {
    let elapsed = state
        .attempt_started
        .lock()
        .ok()
        .and_then(|started| started.map(|value| value.elapsed().as_millis()))
        .unwrap_or(0);
    let sidecar_process_status = state
        .process
        .lock()
        .ok()
        .map(|process| if process.is_some() { "running" } else { "none" })
        .unwrap_or("unknown");
    let error_code = state.last_error.lock().ok().and_then(|value| *value);
    let diagnostics = StartupDiagnostics {
        app_version: env!("CARGO_PKG_VERSION").into(),
        node_version: BUNDLED_NODE_VERSION.into(),
        platform: std::env::consts::OS.into(),
        arch: std::env::consts::ARCH.into(),
        lifecycle_state: serde_json::to_string(&snapshot.state)
            .unwrap_or_else(|_| "unknown".into()),
        lifecycle_elapsed_ms: elapsed,
        sidecar_path_status: state
            .node_path_status
            .lock()
            .map(|value| value.clone())
            .unwrap_or_else(|_| "unknown".into()),
        sidecar_process_status: sidecar_process_status.into(),
        error_code,
    };
    serde_json::to_string_pretty(&diagnostics).unwrap_or_else(|_| "diagnostics unavailable".into())
}

/// 复制经过脱敏的当前启动诊断信息。
#[tauri::command]
fn startup_copy_diagnostics(
    app: AppHandle,
    state: State<'_, Arc<RuntimeState>>,
) -> Result<(), String> {
    let snapshot = state
        .snapshot
        .lock()
        .map(|value| value.clone())
        .unwrap_or(LifecycleSnapshot {
            state: LifecycleState::Starting,
            message: "Starting.".into(),
            origin: None,
        });
    app.clipboard()
        .write_text(build_startup_diagnostics(state.inner(), &snapshot))
        .map_err(|error| error.to_string())
}

/// 在系统文件管理器中打开日志目录。
#[tauri::command]
fn startup_reveal_logs(app: AppHandle, state: State<'_, Arc<RuntimeState>>) -> Result<(), String> {
    fs::create_dir_all(&state.logs_dir).map_err(|error| error.to_string())?;
    app.opener()
        .open_path(state.logs_dir.to_string_lossy().to_string(), None::<String>)
        .map_err(|error| error.to_string())
}

/// 创建 startup window，注册 Tauri IPC，并启动 sidecar 生命周期监督线程。
fn setup(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let logs_dir = app.path().app_data_dir()?.join("logs");
    let state = Arc::new(RuntimeState {
        snapshot: Mutex::new(LifecycleSnapshot {
            state: LifecycleState::Starting,
            message: "Starting.".into(),
            origin: None,
        }),
        process: Mutex::new(None),
        lifecycle_gate: Mutex::new(()),
        host_origin: Mutex::new(None),
        startup_url: Mutex::new(None),
        generation: AtomicU64::new(0),
        retrying: AtomicBool::new(false),
        shutting_down: AtomicBool::new(false),
        attempt_started: Mutex::new(None),
        node_path_status: Mutex::new("not-checked".into()),
        logs_dir,
        last_error: Mutex::new(None),
    });
    app.manage(Arc::clone(&state));
    let app_handle = app.handle().clone();
    let startup_window =
        WebviewWindowBuilder::new(app.handle(), "main", WebviewUrl::App("index.html".into()))
            .title("DeepSeek Harness Desktop")
            .inner_size(1200.0, 800.0)
            .visible(true)
            .center()
            .on_navigation({
                let app = app.handle().clone();
                let state = Arc::clone(&state);
                move |url| {
                    let startup_url = state
                        .startup_url
                        .lock()
                        .ok()
                        .and_then(|value| value.clone())
                        .unwrap_or_default();
                    let host_origin = state
                        .host_origin
                        .lock()
                        .ok()
                        .and_then(|value| value.clone());
                    match decide_navigation(url.as_str(), &startup_url, host_origin.as_deref()) {
                        NavigationDecision::Allow => true,
                        NavigationDecision::External => {
                            let _ = app.opener().open_url(url.to_string(), None::<String>);
                            false
                        }
                        NavigationDecision::Deny => false,
                    }
                }
            })
            .on_new_window({
                let app = app.handle().clone();
                move |url, _features| {
                    if url.scheme() == "http" || url.scheme() == "https" {
                        let _ = app.opener().open_url(url.to_string(), None::<String>);
                    }
                    tauri::webview::NewWindowResponse::Deny
                }
            })
            .build()?;
    if let Ok(url) = startup_window.url() {
        if let Ok(mut startup_url) = state.startup_url.lock() {
            *startup_url = Some(url.to_string());
        }
    }
    let state_for_close = Arc::clone(&state);
    startup_window.on_window_event(move |event| {
        if let WindowEvent::CloseRequested { api, .. } = event {
            api.prevent_close();
            request_shutdown(&app_handle, &state_for_close);
        }
    });
    start_attempt(app.handle(), &state);
    Ok(())
}

/// 启动 Tauri 应用并安装单实例、外链和剪贴板插件。
fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(
            tauri_plugin_opener::Builder::new()
                .open_js_links_on_click(false)
                .build(),
        )
        .plugin(tauri_plugin_clipboard_manager::init())
        .invoke_handler(tauri::generate_handler![
            startup_snapshot,
            startup_retry,
            startup_copy_diagnostics,
            startup_reveal_logs
        ])
        .setup(setup)
        .run(tauri::generate_context!())
        .expect("error while running Tauri application");
}

#[cfg(test)]
mod tests {
    use super::{
        build_startup_diagnostics, bundled_node_relative_path, decide_navigation,
        is_allowed_host_origin, parse_sidecar_message, DiagnosticCode, LifecycleSnapshot,
        LifecycleState, NavigationDecision, RuntimeState, SidecarMessage,
    };
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicBool, AtomicU64};
    use std::sync::Mutex;
    /// 验证生命周期 ready 消息可解析。
    #[test]
    fn parses_ready_message() {
        let message =
            parse_sidecar_message(r#"{"type":"ready","origin":"http://127.0.0.1:1234/"}"#).unwrap();
        assert!(
            matches!(message, SidecarMessage::Ready { origin } if origin == "http://127.0.0.1:1234/")
        );
    }
    /// 验证 sidecar 错误载荷只用于分类，不会进入可复制诊断状态。
    #[test]
    fn parses_but_discards_sidecar_error_details() {
        let message = parse_sidecar_message(
            r#"{"type":"startup-failed","error":{"name":"Error","message":"token=secret"}}"#,
        )
        .unwrap();
        assert!(matches!(message, SidecarMessage::StartupFailed { .. }));
    }
    /// 验证生命周期保留可恢复状态。
    #[test]
    fn lifecycle_has_recoverable_states() {
        assert_ne!(LifecycleState::Failed, LifecycleState::Ready);
        assert_ne!(LifecycleState::Stopping, LifecycleState::Starting);
    }
    /// 验证只接受带端口的 127.0.0.1 HTTP origin。
    #[test]
    fn validates_host_origin() {
        assert!(is_allowed_host_origin("http://127.0.0.1:1234/"));
        assert!(!is_allowed_host_origin("http://localhost:1234/"));
        assert!(!is_allowed_host_origin("https://127.0.0.1:1234/"));
    }
    /// 验证启动页、当前 Host 和外链导航边界。
    #[test]
    fn applies_navigation_policy() {
        let startup = "http://tauri.localhost/index.html";
        let host = Some("http://127.0.0.1:1234");
        assert_eq!(
            decide_navigation(startup, startup, host),
            NavigationDecision::Allow
        );
        assert_eq!(
            decide_navigation("http://127.0.0.1:1234/", startup, host),
            NavigationDecision::Allow
        );
        assert_eq!(
            decide_navigation("https://example.com", startup, host),
            NavigationDecision::External
        );
        assert_eq!(
            decide_navigation("file:///tmp/private", startup, host),
            NavigationDecision::Deny
        );
    }

    /// 验证资源布局与 Node 官方归档在各平台的可执行文件位置一致。
    #[test]
    fn bundled_node_layout_matches_platform_archive() {
        let relative = bundled_node_relative_path();
        if cfg!(windows) {
            assert_eq!(relative.to_string_lossy(), "node.exe");
        } else {
            assert_eq!(relative.to_string_lossy(), "node");
        }
    }

    /// 验证复制诊断只序列化稳定字段，不包含错误消息、URL 或本机路径。
    #[test]
    fn diagnostics_use_a_safe_field_allowlist() {
        let state = RuntimeState {
            snapshot: Mutex::new(LifecycleSnapshot {
                state: LifecycleState::Failed,
                message: "ignored".into(),
                origin: None,
            }),
            process: Mutex::new(None),
            lifecycle_gate: Mutex::new(()),
            host_origin: Mutex::new(None),
            startup_url: Mutex::new(None),
            generation: AtomicU64::new(1),
            retrying: AtomicBool::new(false),
            shutting_down: AtomicBool::new(false),
            attempt_started: Mutex::new(None),
            node_path_status: Mutex::new("bundled".into()),
            logs_dir: PathBuf::from(r#"C:\Users\alice\secret"#),
            last_error: Mutex::new(Some(DiagnosticCode::SpawnFailed)),
        };
        let snapshot = LifecycleSnapshot {
            state: LifecycleState::Failed,
            message: "https://example.test/?token=secret C:\\Users\\alice".into(),
            origin: Some("http://127.0.0.1:1234/?token=secret".into()),
        };
        let diagnostics = build_startup_diagnostics(&state, &snapshot);
        assert!(diagnostics.contains("spawn_failed"));
        assert!(!diagnostics.contains("example.test"));
        assert!(!diagnostics.contains("token"));
        assert!(!diagnostics.contains("alice"));
    }
}
