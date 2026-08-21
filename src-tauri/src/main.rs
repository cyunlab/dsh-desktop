#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[cfg(all(not(debug_assertions), feature = "wdio"))]
compile_error!("the wdio feature is test-only and cannot be enabled in release builds");

mod cli_supervisor;
mod lifecycle;

use cli_supervisor::{
    build_command_plan, spawn_cli, CliProcess, ExitReason, ProcessExit, StopReport,
    SupervisorError, HOST_ORIGIN,
};
use lifecycle::{wait_for_readiness, ReadinessWaitError};
use serde::Serialize;
#[cfg(all(debug_assertions, feature = "wdio"))]
use std::fs::OpenOptions;
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::process::ExitStatus;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use tauri::webview::PageLoadEvent;
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_opener::OpenerExt;

#[cfg(unix)]
use std::os::unix::process::ExitStatusExt;

const SNAPSHOT_EVENT: &str = "startup:snapshot";
const PROLONGED_STARTUP_AFTER: Duration = Duration::from_secs(30);
const HTTP_PROBE_TIMEOUT: Duration = Duration::from_millis(750);
const HTTP_RESPONSE_CAP: usize = 64 * 1024;
const CLI_STOP_AFTER: Duration = Duration::from_secs(8);
const CLI_FORCE_CONFIRM_AFTER: Duration = Duration::from_secs(5);
const BUNDLED_NODE_VERSION: &str = "24.19.0";

/// 生命周期状态，序列化后作为启动页的稳定协议。
#[derive(Debug, Serialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
enum LifecycleState {
    Starting,
    WaitingForClient,
    ProlongedStartup,
    Ready,
    Failed,
    Stopping,
}

#[cfg(test)]
impl LifecycleState {
    /// 列出 Startup 协议允许的全部 direct CLI 状态。
    const ALL: [Self; 6] = [
        Self::Starting,
        Self::WaitingForClient,
        Self::ProlongedStartup,
        Self::Ready,
        Self::Failed,
        Self::Stopping,
    ];
}

/// 启动页可见的生命周期快照。
#[derive(Debug, Serialize, Clone)]
struct LifecycleSnapshot {
    state: LifecycleState,
    message: String,
    origin: Option<String>,
}

/// 供后续 lifecycle 和 Windows 信号分类复用的稳定进程观察结果。
#[derive(Debug, Serialize, Clone)]
struct ProcessObservation {
    generation: u64,
    exit_code: Option<i32>,
    exit_signal: Option<i32>,
    exit_reason: String,
    cleanup_outcome: Option<String>,
}

/// 允许复制到诊断信息中的安全错误分类。
#[derive(Debug, Serialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum DiagnosticCode {
    /// 无法解析 Tauri 资源目录。
    ResourceUnavailable,
    /// 官方 Node 不存在且没有显式覆盖。
    NodeUnavailable,
    /// 发布 CLI 入口或 runtime closure 不存在。
    BootstrapUnavailable,
    /// 无法准备应用数据目录。
    AppDataUnavailable,
    /// 固定的 127.0.0.1:3080 已被其它进程占用。
    PortConflict,
    /// 无法创建或接管 CLI 进程树。
    SpawnFailed,
    /// CLI 在 ready 或 listener 等待期间退出。
    UnexpectedExit,
    /// 进程树清理没有得到确认。
    CleanupFailed,
    /// 内部状态或 listener 探测失败。
    InternalFailure,
}

/// Tauri shell 的共享运行时状态。
struct RuntimeState {
    snapshot: Mutex<LifecycleSnapshot>,
    process: Mutex<Option<Arc<CliProcess>>>,
    /// 串行 generation 切换与 generation-bound 事件发布。
    generation_event_gate: Mutex<()>,
    /// 串行主线程导航与 generation 切换，不在 WebView 回调期间持有。
    navigation_operation_gate: Mutex<()>,
    /// 串行化 spawn、Retry 和 shutdown，避免旧进程尚未回收时创建替代 Host。
    lifecycle_gate: Mutex<()>,
    host_origin: Mutex<Option<String>>,
    /// 当前 Host origin 所属的启动轮次，防止旧页面加载误报新轮次 Ready。
    host_generation: Mutex<Option<u64>>,
    /// 已调度到主线程的 Host 导航所属轮次。
    webview_navigation_generation: Mutex<Option<u64>>,
    /// 已调度 Host 导航的唯一 fragment URL。
    webview_navigation_url: Mutex<Option<String>>,
    /// 当前受控 Host 页面加载所属轮次。
    webview_load_generation: Mutex<Option<u64>>,
    /// Started 事件已确认的受控 fragment URL。
    webview_load_url: Mutex<Option<String>>,
    startup_url: Mutex<Option<String>>,
    generation: AtomicU64,
    retrying: AtomicBool,
    shutting_down: AtomicBool,
    /// 当前启动轮次开始时间，用于诊断而不暴露本机路径。
    attempt_started: Mutex<Option<Instant>>,
    /// 官方 Node 可执行文件来源和路径状态的脱敏描述。
    node_path_status: Mutex<String>,
    /// 最近一次 CLI 的真实退出分类与清理结果。
    last_process_observation: Mutex<Option<ProcessObservation>>,
    last_error: Mutex<Option<DiagnosticCode>>,
}

/// 判断 URL 是否是 Tauri 在不同 WebView 平台使用的精确打包启动入口。
fn is_packaged_startup_url(target: &tauri::Url) -> bool {
    let packaged_origin = (target.scheme() == "http"
        && target.host_str() == Some("tauri.localhost"))
        || (target.scheme() == "tauri" && target.host_str() == Some("localhost"));
    packaged_origin
        && matches!(target.path(), "" | "/" | "/index.html")
        && target.query().is_none()
        && target.fragment().is_none()
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
    if is_packaged_startup_url(&target) {
        return NavigationDecision::Allow;
    }
    if (target.scheme() == "http" && target.host_str() == Some("tauri.localhost"))
        || (target.scheme() == "tauri" && target.host_str() == Some("localhost"))
    {
        return NavigationDecision::Deny;
    }
    if host_origin.is_some_and(|origin| {
        target.origin().ascii_serialization() == origin.trim_end_matches('/')
            && target.scheme() == "http"
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
        "official Node executable is missing: {}",
        bundled.display()
    ))
}

/// 仅在 debug+wdio 构建中追加结构化测试事件。
#[cfg(all(debug_assertions, feature = "wdio"))]
fn record_wdio_event(event: serde_json::Value) {
    let Some(path) = std::env::var_os("DSH_TEST_RECORD_FILE").filter(|value| !value.is_empty())
    else {
        return;
    };
    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(file, "{event}");
    }
}

/// 将允许的 HTTP(S) URL 交给系统；测试构建仅记录调用。
fn open_external(app: &AppHandle, url: String) {
    #[cfg(all(debug_assertions, feature = "wdio"))]
    if std::env::var_os("DSH_TEST_RECORD_FILE").is_some() {
        record_wdio_event(serde_json::json!({ "event": "external-open", "url": url }));
        return;
    }
    let _ = app.opener().open_url(url, None::<String>);
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
    #[cfg(all(debug_assertions, feature = "wdio"))]
    record_wdio_event(serde_json::json!({ "event": "lifecycle-transition", "state": lifecycle }));
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

/// 仅当 generation 仍处于等待阶段时发布计时器状态，拒绝迟到 timer。
fn transition_waiting_generation(
    app: &AppHandle,
    state: &RuntimeState,
    generation: u64,
    lifecycle: LifecycleState,
    message: impl Into<String>,
) -> bool {
    let Ok(_gate) = state.generation_event_gate.lock() else {
        return false;
    };
    if !is_current(state, generation) {
        return false;
    }
    let waiting = state.snapshot.lock().ok().is_some_and(|snapshot| {
        matches!(
            snapshot.state,
            LifecycleState::WaitingForClient | LifecycleState::ProlongedStartup
        )
    });
    if !waiting || !is_current(state, generation) {
        return false;
    }
    transition(app, state, lifecycle, message);
    true
}

/// 仅为当前 generation 发布生命周期快照，拒绝迟到进程事件。
fn transition_generation(
    app: &AppHandle,
    state: &RuntimeState,
    generation: u64,
    lifecycle: LifecycleState,
    message: impl Into<String>,
) -> bool {
    let Ok(_gate) = state.generation_event_gate.lock() else {
        return false;
    };
    if !is_current(state, generation) {
        return false;
    }
    transition(app, state, lifecycle, message);
    true
}

/// 判断某个启动轮次是否仍然有效。
fn is_current(state: &RuntimeState, generation: u64) -> bool {
    !state.shutting_down.load(Ordering::Acquire)
        && state.generation.load(Ordering::Acquire) == generation
}

/// 将带可选尾斜杠的 Harness HTTP origin 转换为 HTTP 探测地址。
fn parse_loopback_address(origin: &str) -> Result<SocketAddr, ReadinessWaitError> {
    origin
        .strip_prefix("http://")
        .ok_or(ReadinessWaitError::ProbeFailed)?
        .trim_end_matches('/')
        .parse::<SocketAddr>()
        .map_err(|_| ReadinessWaitError::ProbeFailed)
}

/// 清除 Host readiness 与 WebView 观察令牌，使迟到事件无法穿过 Retry 边界。
fn reset_host_observation(state: &RuntimeState) {
    if let Ok(mut current) = state.host_origin.lock() {
        *current = None;
    }
    if let Ok(mut current) = state.host_generation.lock() {
        *current = None;
    }
    if let Ok(mut current) = state.webview_navigation_generation.lock() {
        *current = None;
    }
    if let Ok(mut current) = state.webview_navigation_url.lock() {
        *current = None;
    }
    if let Ok(mut current) = state.webview_load_generation.lock() {
        *current = None;
    }
    if let Ok(mut current) = state.webview_load_url.lock() {
        *current = None;
    }
}

/// 在 HTTP readiness 二次确认后才公布当前 Host origin。
fn set_ready_host_origin(state: &RuntimeState, generation: u64, origin: String) -> bool {
    let Ok(_gate) = state.generation_event_gate.lock() else {
        return false;
    };
    if !current_cli_is_alive(state, generation) {
        return false;
    }
    if let Ok(mut current) = state.host_origin.lock() {
        *current = Some(origin);
    } else {
        return false;
    }
    if let Ok(mut current) = state.host_generation.lock() {
        *current = Some(generation);
        true
    } else {
        reset_host_observation(state);
        false
    }
}

/// 确认该 generation 仍是当前轮次，且拥有的 CLI leader 尚未退出。
fn current_cli_is_alive(state: &RuntimeState, generation: u64) -> bool {
    if !is_current(state, generation) {
        return false;
    }
    let process = state
        .process
        .lock()
        .ok()
        .and_then(|current| current.as_ref().map(Arc::clone));
    process.is_some_and(|process| {
        process.generation() == generation
            && process
                .try_exit(generation)
                .is_ok_and(|exit| exit.is_none())
    })
}

/// 判断 Started 事件是否精确命中当前 generation 的 fragment URL。
fn navigation_event_matches(
    current_generation: u64,
    pending_generation: Option<u64>,
    pending_url: Option<&str>,
    loaded_url: &str,
) -> bool {
    pending_generation == Some(current_generation) && pending_url == Some(loaded_url)
}

/// 用纯值判断 WebView Finished 是否属于当前受控 fragment 加载。
fn is_current_host_page_event(
    current_generation: u64,
    host_generation: Option<u64>,
    load_generation: Option<u64>,
    lifecycle: LifecycleState,
    cli_alive: bool,
    load_url: Option<&str>,
    loaded_url: &tauri::Url,
) -> bool {
    host_generation == Some(current_generation)
        && load_generation == Some(current_generation)
        && cli_alive
        && matches!(
            lifecycle,
            LifecycleState::WaitingForClient | LifecycleState::ProlongedStartup
        )
        && load_url == Some(loaded_url.as_str())
}

/// 把 Host Started 绑定到受控 fragment URL；应用在 Ready 前改 hash 不能替代该精确 token。
fn begin_client_page_load(state: &RuntimeState, loaded_url: &tauri::Url) {
    let Ok(_gate) = state.generation_event_gate.lock() else {
        return;
    };
    let generation = state.generation.load(Ordering::Acquire);
    let expected = state
        .webview_navigation_generation
        .lock()
        .ok()
        .and_then(|value| *value);
    let expected_url = state
        .webview_navigation_url
        .lock()
        .ok()
        .and_then(|value| value.clone());
    if !navigation_event_matches(
        generation,
        expected,
        expected_url.as_deref(),
        loaded_url.as_str(),
    ) || !current_cli_is_alive(state, generation)
    {
        return;
    }
    if let Ok(mut loading) = state.webview_load_generation.lock() {
        *loading = Some(generation);
    }
    if let Ok(mut loading_url) = state.webview_load_url.lock() {
        *loading_url = Some(loaded_url.to_string());
    }
}

/// 判断实际完成加载的页面是否属于当前启动轮次等待中的 Host 客户端。
fn is_current_host_page(state: &RuntimeState, loaded_url: &tauri::Url) -> bool {
    let generation = state.generation.load(Ordering::Acquire);
    let host_generation = state.host_generation.lock().ok().and_then(|value| *value);
    let load_generation = state
        .webview_load_generation
        .lock()
        .ok()
        .and_then(|value| *value);
    let load_url = state
        .webview_load_url
        .lock()
        .ok()
        .and_then(|value| value.clone());
    let lifecycle = state
        .snapshot
        .lock()
        .map(|snapshot| snapshot.state)
        .unwrap_or(LifecycleState::Failed);
    is_current_host_page_event(
        generation,
        host_generation,
        load_generation,
        lifecycle,
        current_cli_is_alive(state, generation),
        load_url.as_deref(),
        loaded_url,
    )
}

/// 仅在 WebView 完成页面加载后推进 client readiness，避免 Started 事件过早宣告 Ready。
fn is_finished_page_load(event: PageLoadEvent) -> bool {
    event == PageLoadEvent::Finished
}

/// 在主 WebView 确认当前 Host 页面加载完成后，才对启动页发布客户端 Ready。
fn mark_client_page_loaded(app: &AppHandle, state: &RuntimeState, loaded_url: &tauri::Url) {
    let Ok(_gate) = state.generation_event_gate.lock() else {
        return;
    };
    if !is_current_host_page(state, loaded_url) {
        return;
    }
    #[cfg(all(debug_assertions, feature = "wdio"))]
    record_wdio_event(serde_json::json!({
        "event": "client-page-loaded",
        "url": loaded_url.as_str()
    }));
    if let Ok(mut navigation) = state.webview_navigation_generation.lock() {
        *navigation = None;
    }
    if let Ok(mut loading) = state.webview_load_generation.lock() {
        *loading = None;
    }
    if let Ok(mut navigation_url) = state.webview_navigation_url.lock() {
        *navigation_url = None;
    }
    if let Ok(mut loading_url) = state.webview_load_url.lock() {
        *loading_url = None;
    }
    transition(app, state, LifecycleState::Ready, "Ready.");
}

/// HTTP 响应在有界读取中的严格 framing 判定。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum HttpResponseState {
    NeedMore,
    Ready,
    Reject,
}

/// 判断已读响应是否具有完整、有界且非空的 HTML body。
fn inspect_http_client_response(response: &[u8], eof: bool) -> HttpResponseState {
    if response.len() > HTTP_RESPONSE_CAP {
        return HttpResponseState::Reject;
    }
    let Some(header_offset) = response.windows(4).position(|bytes| bytes == b"\r\n\r\n") else {
        return if eof || response.len() == HTTP_RESPONSE_CAP {
            HttpResponseState::Reject
        } else {
            HttpResponseState::NeedMore
        };
    };
    let body_offset = header_offset + 4;
    let Ok(headers) = std::str::from_utf8(&response[..header_offset]) else {
        return HttpResponseState::Reject;
    };
    let mut lines = headers.lines();
    let Some(status) = lines.next() else {
        return HttpResponseState::Reject;
    };
    let successful_status = status
        .split_whitespace()
        .nth(1)
        .and_then(|code| code.parse::<u16>().ok())
        .is_some_and(|code| (200..300).contains(&code));
    if !successful_status {
        return HttpResponseState::Reject;
    }
    let mut content_types = Vec::new();
    let mut content_lengths = Vec::new();
    let mut has_transfer_encoding = false;
    for line in lines {
        let Some((name, value)) = line.split_once(':') else {
            return HttpResponseState::Reject;
        };
        if name.eq_ignore_ascii_case("content-type") {
            content_types.push(value.trim());
        } else if name.eq_ignore_ascii_case("content-length") {
            content_lengths.push(value.trim());
        } else if name.eq_ignore_ascii_case("transfer-encoding") {
            has_transfer_encoding = true;
        }
    }
    let html_type = content_types.len() == 1
        && content_types[0]
            .split(';')
            .next()
            .is_some_and(|media_type| media_type.trim().eq_ignore_ascii_case("text/html"));
    if !html_type || has_transfer_encoding || content_lengths.len() > 1 {
        return HttpResponseState::Reject;
    }
    let body_nonempty = |body: &[u8]| body.iter().any(|byte| !byte.is_ascii_whitespace());
    if let Some(raw_length) = content_lengths.first() {
        let Ok(length) = raw_length.parse::<usize>() else {
            return HttpResponseState::Reject;
        };
        let Some(expected_total) = body_offset.checked_add(length) else {
            return HttpResponseState::Reject;
        };
        if length == 0 || expected_total > HTTP_RESPONSE_CAP || response.len() > expected_total {
            return HttpResponseState::Reject;
        }
        if response.len() < expected_total {
            return if eof {
                HttpResponseState::Reject
            } else {
                HttpResponseState::NeedMore
            };
        }
        return if body_nonempty(&response[body_offset..expected_total]) {
            HttpResponseState::Ready
        } else {
            HttpResponseState::Reject
        };
    }
    if !eof {
        return HttpResponseState::NeedMore;
    }
    if body_nonempty(&response[body_offset..]) {
        HttpResponseState::Ready
    } else {
        HttpResponseState::Reject
    }
}

/// 兼容已有纯值测试，把输入视为已经 EOF 的完整响应。
#[cfg(test)]
fn is_html_client_response(response: &[u8]) -> bool {
    inspect_http_client_response(response, true) == HttpResponseState::Ready
}

/// 在一个绝对 deadline 内读取并严格验证根页面响应。
fn probe_client_page_with_timeout(address: SocketAddr, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    let Ok(mut stream) = TcpStream::connect_timeout(&address, timeout) else {
        return false;
    };
    let request = format!(
        "GET / HTTP/1.1\r\nHost: {address}\r\nAccept: text/html\r\nConnection: close\r\n\r\n"
    );
    let Some(remaining) = deadline.checked_duration_since(Instant::now()) else {
        return false;
    };
    let _ = stream.set_write_timeout(Some(remaining));
    if stream.write_all(request.as_bytes()).is_err() {
        return false;
    }
    let mut response = Vec::with_capacity(4096);
    let mut buffer = [0_u8; 4096];
    loop {
        match inspect_http_client_response(&response, false) {
            HttpResponseState::Ready => return true,
            HttpResponseState::Reject => return false,
            HttpResponseState::NeedMore => {}
        }
        let Some(remaining) = deadline.checked_duration_since(Instant::now()) else {
            return false;
        };
        if remaining.is_zero() || response.len() == HTTP_RESPONSE_CAP {
            return false;
        }
        let _ = stream.set_read_timeout(Some(remaining));
        let available = (HTTP_RESPONSE_CAP - response.len()).min(buffer.len());
        match stream.read(&mut buffer[..available]) {
            Ok(0) => {
                return inspect_http_client_response(&response, true) == HttpResponseState::Ready;
            }
            Ok(read) => response.extend_from_slice(&buffer[..read]),
            Err(error)
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                ) =>
            {
                return false;
            }
            Err(_) => return false,
        }
    }
}

/// 使用生产小上限执行一次根页面探测。
fn probe_client_page(address: SocketAddr) -> bool {
    probe_client_page_with_timeout(address, HTTP_PROBE_TIMEOUT)
}

/// 生产始终使用 30 秒，仅 debug+wdio 允许缩短 Prolonged 门槛以消除 E2E 固定等待。
fn prolonged_startup_after() -> Duration {
    #[cfg(all(debug_assertions, feature = "wdio"))]
    if let Ok(milliseconds) = std::env::var("DSH_TEST_PROLONGED_AFTER_MS") {
        if let Ok(milliseconds) = milliseconds.parse::<u64>() {
            return Duration::from_millis(milliseconds.max(1));
        }
    }
    PROLONGED_STARTUP_AFTER
}

/// 等待 Harness 根页面可通过 HTTP 提供 HTML；超过 30 秒只进入可恢复状态，不自动失败。
fn wait_for_web_listener(
    app: &AppHandle,
    state: &RuntimeState,
    generation: u64,
    process: &Arc<CliProcess>,
    origin: &str,
    attempt_started: Instant,
) -> Result<(), ReadinessWaitError> {
    let address = parse_loopback_address(origin)?;
    wait_for_readiness(
        || is_current(state, generation),
        || {
            process
                .try_exit(state.generation.load(Ordering::Acquire))
                .map(|exit| exit.is_some())
        },
        || Ok(probe_client_page(address)),
        attempt_started,
        prolonged_startup_after(),
        Duration::from_millis(100),
        || {
            transition_waiting_generation(
                app,
                state,
                generation,
                LifecycleState::ProlongedStartup,
                "Startup is taking longer than expected. You can retry when ready.",
            );
        },
    )
}

/// 返回当前构建中物化的 production runtime closure 根目录。
fn runtime_closure_root(resource_dir: &Path) -> PathBuf {
    if cfg!(debug_assertions) {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../dist/node_modules")
    } else {
        resource_dir.join("dist/node_modules")
    }
}

/// 解析固定 Node、发布 CLI 入口、隔离 Home 与独立工作目录。
fn resolve_cli_plan(
    app: &AppHandle,
    state: &RuntimeState,
) -> Result<cli_supervisor::CliCommandPlan, DiagnosticCode> {
    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|_| DiagnosticCode::ResourceUnavailable)?;
    if let Ok(mut status) = state.node_path_status.lock() {
        *status = node_path_status(&resource_dir).into();
    }
    let node_path =
        resolve_node_path(&resource_dir).map_err(|_| DiagnosticCode::NodeUnavailable)?;
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|_| DiagnosticCode::AppDataUnavailable)?;
    let plan = build_command_plan(
        node_path,
        &runtime_closure_root(&resource_dir),
        app_data.join("harness-home"),
        app_data.join("working-directory"),
    )
    .map_err(|_| DiagnosticCode::BootstrapUnavailable)?;
    #[cfg(all(debug_assertions, feature = "wdio"))]
    let plan = if let Some(test_entry) =
        std::env::var_os("DSH_TEST_SIDECAR").filter(|value| !value.is_empty())
    {
        let test_entry = PathBuf::from(test_entry);
        if !test_entry.is_file() {
            return Err(DiagnosticCode::BootstrapUnavailable);
        }
        plan.with_test_entry(test_entry)
    } else {
        plan
    };
    Ok(plan)
}

/// 把 supervisor 的稳定错误映射到 Desktop 诊断分类。
fn map_supervisor_error(error: SupervisorError) -> DiagnosticCode {
    match error {
        SupervisorError::RuntimeUnavailable => DiagnosticCode::AppDataUnavailable,
        SupervisorError::PortConflict => DiagnosticCode::PortConflict,
        SupervisorError::PreflightFailed => DiagnosticCode::InternalFailure,
        SupervisorError::SpawnFailed => DiagnosticCode::SpawnFailed,
        SupervisorError::CleanupFailed => DiagnosticCode::CleanupFailed,
    }
}

/// 在生命周期门禁内启动当前 generation 的官方 CLI。
fn spawn_direct_cli(
    app: &AppHandle,
    state: &RuntimeState,
    generation: u64,
) -> Result<Arc<CliProcess>, DiagnosticCode> {
    let _gate = state
        .lifecycle_gate
        .lock()
        .map_err(|_| DiagnosticCode::InternalFailure)?;
    if !is_current(state, generation) {
        return Err(DiagnosticCode::InternalFailure);
    }
    let plan = resolve_cli_plan(app, state)?;
    let process = spawn_cli(&plan, generation).map_err(map_supervisor_error)?;
    #[cfg(all(debug_assertions, feature = "wdio"))]
    record_wdio_event(serde_json::json!({
        "event": "cli-spawned",
        "generation": generation,
        "pid": process.pid().ok(),
        "nodePathPrepended": true
    }));
    if !is_current(state, generation) {
        let _ = stop_cli(state, &process);
        return Err(DiagnosticCode::InternalFailure);
    }
    let Ok(mut current) = state.process.lock() else {
        return Err(if stop_cli(state, &process).is_ok() {
            DiagnosticCode::InternalFailure
        } else {
            DiagnosticCode::CleanupFailed
        });
    };
    if current.is_some() {
        drop(current);
        return Err(if stop_cli(state, &process).is_ok() {
            DiagnosticCode::InternalFailure
        } else {
            DiagnosticCode::CleanupFailed
        });
    }
    *current = Some(Arc::clone(&process));
    Ok(process)
}

/// 返回跨平台稳定的退出 signal；Windows ExitStatus 没有 POSIX signal。
#[cfg(unix)]
fn exit_signal(status: &ExitStatus) -> Option<i32> {
    status.signal()
}

/// 返回跨平台稳定的退出 signal；非 Unix 平台固定为空。
#[cfg(not(unix))]
fn exit_signal(_status: &ExitStatus) -> Option<i32> {
    None
}

/// 保存真实 ExitStatus、generation、原因和可选 cleanup outcome。
fn record_process_observation(
    state: &RuntimeState,
    process: &CliProcess,
    exit: &ProcessExit,
    cleanup_outcome: Option<&str>,
) {
    let reason = match exit.reason {
        ExitReason::Requested => "requested",
        ExitReason::Unexpected => "unexpected",
        ExitReason::StaleGeneration => "stale_generation",
    };
    if let Ok(mut observation) = state.last_process_observation.lock() {
        *observation = Some(ProcessObservation {
            generation: process.generation(),
            exit_code: exit.status.code(),
            exit_signal: exit_signal(&exit.status),
            exit_reason: reason.into(),
            cleanup_outcome: cleanup_outcome.map(str::to_owned),
        });
    }
}

/// 在无法确认回收时保留 cleanup failure，而不伪造 ExitStatus。
fn record_cleanup_failure(state: &RuntimeState, process: &CliProcess) {
    if let Ok(mut observation) = state.last_process_observation.lock() {
        if let Some(existing) = observation
            .as_mut()
            .filter(|existing| existing.generation == process.generation())
        {
            existing.cleanup_outcome = Some("failed".into());
        } else {
            *observation = Some(ProcessObservation {
                generation: process.generation(),
                exit_code: None,
                exit_signal: None,
                exit_reason: "unknown".into(),
                cleanup_outcome: Some("failed".into()),
            });
        }
    }
}

/// 对一个 CLI generation 执行八秒宽限停止并持久保留监督结果。
fn stop_cli(state: &RuntimeState, process: &Arc<CliProcess>) -> Result<StopReport, String> {
    let current_generation = state.generation.load(Ordering::Acquire);
    let report = match process.stop(current_generation, CLI_STOP_AFTER, CLI_FORCE_CONFIRM_AFTER) {
        Ok(report) => report,
        Err(error) => {
            record_cleanup_failure(state, process);
            return Err(error);
        }
    };
    if let Some(exit) = report.exit.as_ref() {
        let outcome = match report.outcome {
            lifecycle::StopOutcome::Graceful => "graceful",
            lifecycle::StopOutcome::Forced => "forced",
        };
        record_process_observation(state, process, exit, Some(outcome));
    }
    Ok(report)
}
/// 将窗口导航到打包启动页，主线程执行前再次校验 generation。
fn navigate_to_startup(app: &AppHandle, state: &RuntimeState, generation: u64) {
    let Some(raw_url) = state
        .startup_url
        .lock()
        .ok()
        .and_then(|value| value.clone())
    else {
        return;
    };
    let Ok(url) = raw_url.parse::<tauri::Url>() else {
        return;
    };
    let app = app.clone();
    let app_for_task = app.clone();
    let _ = app.run_on_main_thread(move || {
        let state = app_for_task.state::<Arc<RuntimeState>>();
        let Ok(_navigation_gate) = state.navigation_operation_gate.lock() else {
            return;
        };
        let Ok(_gate) = state.generation_event_gate.lock() else {
            return;
        };
        if !is_current(&state, generation) {
            return;
        }
        reset_host_observation(&state);
        drop(_gate);
        if let Some(window) = app_for_task.get_webview_window("main") {
            let result = window.navigate(url.clone());
            #[cfg(not(all(debug_assertions, feature = "wdio")))]
            let _ = result;
            #[cfg(all(debug_assertions, feature = "wdio"))]
            record_wdio_event(serde_json::json!({
                "event": "startup-navigation",
                "url": url.as_str(),
                "ok": result.is_ok()
            }));
        }
    });
}

/// 将窗口导航到当前启动轮次的 Host 页面，拒绝迟到主线程任务。
fn navigate_to_host(app: &AppHandle, generation: u64, origin: &str) {
    let Ok(mut url) = origin.parse::<tauri::Url>() else {
        return;
    };
    url.set_fragment(Some(&format!("dsh-desktop-generation={generation}")));
    let navigation_url = url.to_string();
    let app = app.clone();
    let app_for_task = app.clone();
    let _ = app.run_on_main_thread(move || {
        let state = app_for_task.state::<Arc<RuntimeState>>();
        let Ok(_navigation_gate) = state.navigation_operation_gate.lock() else {
            return;
        };
        let Ok(_gate) = state.generation_event_gate.lock() else {
            return;
        };
        let host_generation = state.host_generation.lock().ok().and_then(|value| *value);
        if host_generation != Some(generation) || !current_cli_is_alive(&state, generation) {
            return;
        }
        if let Ok(mut expected) = state.webview_navigation_generation.lock() {
            *expected = Some(generation);
        } else {
            return;
        }
        if let Ok(mut expected_url) = state.webview_navigation_url.lock() {
            *expected_url = Some(navigation_url.clone());
        } else {
            reset_host_observation(&state);
            return;
        }
        if let Ok(mut loading) = state.webview_load_generation.lock() {
            *loading = None;
        }
        if let Ok(mut loading_url) = state.webview_load_url.lock() {
            *loading_url = None;
        }
        drop(_gate);
        if let Some(window) = app_for_task.get_webview_window("main") {
            let result = window.navigate(url.clone());
            if result.is_err() {
                if let Ok(mut expected) = state.webview_navigation_generation.lock() {
                    *expected = None;
                }
                if let Ok(mut expected_url) = state.webview_navigation_url.lock() {
                    *expected_url = None;
                }
            }
            #[cfg(not(all(debug_assertions, feature = "wdio")))]
            let _ = result;
            #[cfg(all(debug_assertions, feature = "wdio"))]
            record_wdio_event(serde_json::json!({
                "event": "host-navigation",
                "url": url.as_str(),
                "ok": result.is_ok()
            }));
        }
    });
}

/// 记录启动失败并恢复到统一启动页。
fn fail_attempt(app: &AppHandle, state: &RuntimeState, generation: u64, code: DiagnosticCode) {
    let Ok(_gate) = state.generation_event_gate.lock() else {
        return;
    };
    if !is_current(state, generation) {
        return;
    }
    reset_host_observation(state);
    if let Ok(mut last_error) = state.last_error.lock() {
        *last_error = Some(code);
    }
    transition(
        app,
        state,
        LifecycleState::Failed,
        "Startup failed. Retry or copy diagnostics.",
    );
    drop(_gate);
    navigate_to_startup(app, state, generation);
}

/// 仅在状态仍指向同一个 CLI 时清除共享句柄，避免误删替代轮次。
fn clear_process(state: &RuntimeState, process: &Arc<CliProcess>) {
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
    process: &Arc<CliProcess>,
    code: DiagnosticCode,
) {
    let cleanup = stop_cli(state, process);
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

/// 只有当前 generation 的非预期退出才应转入 Failed。
fn exit_requires_failure(
    process_generation: u64,
    current_generation: u64,
    reason: ExitReason,
) -> bool {
    process_generation == current_generation && reason == ExitReason::Unexpected
}

/// 执行 direct CLI 启动轮次，并只从进程、固定 HTTP 与 WebView 观察生命周期。
fn run_attempt(app: AppHandle, state: Arc<RuntimeState>, generation: u64) {
    let attempt_started = state
        .attempt_started
        .lock()
        .ok()
        .and_then(|started| *started)
        .unwrap_or_else(Instant::now);
    let process = match spawn_direct_cli(&app, &state, generation) {
        Ok(process) => process,
        Err(error) => {
            fail_attempt(&app, &state, generation, error);
            return;
        }
    };
    if !transition_generation(
        &app,
        &state,
        generation,
        LifecycleState::WaitingForClient,
        "Waiting for client to start.",
    ) {
        return;
    }
    match wait_for_web_listener(
        &app,
        &state,
        generation,
        &process,
        HOST_ORIGIN,
        attempt_started,
    ) {
        Ok(()) => {
            if !set_ready_host_origin(&state, generation, HOST_ORIGIN.into()) {
                if is_current(&state, generation) {
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
            #[cfg(all(debug_assertions, feature = "wdio"))]
            record_wdio_event(serde_json::json!({
                "event": "client-page-served",
                "origin": HOST_ORIGIN
            }));
            navigate_to_host(&app, generation, HOST_ORIGIN);
        }
        Err(ReadinessWaitError::Cancelled) => return,
        Err(ReadinessWaitError::ProcessExited) => {
            if !is_current(&state, generation) {
                return;
            }
            match process.try_exit(state.generation.load(Ordering::Acquire)) {
                Ok(Some(exit)) => {
                    record_process_observation(&state, &process, &exit, None);
                    if !exit_requires_failure(
                        process.generation(),
                        state.generation.load(Ordering::Acquire),
                        exit.reason,
                    ) {
                        return;
                    }
                    abort_attempt(
                        &app,
                        &state,
                        generation,
                        &process,
                        DiagnosticCode::UnexpectedExit,
                    );
                }
                _ => abort_attempt(
                    &app,
                    &state,
                    generation,
                    &process,
                    DiagnosticCode::UnexpectedExit,
                ),
            }
            return;
        }
        Err(ReadinessWaitError::ProbeFailed) => {
            if !is_current(&state, generation) {
                return;
            }
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

    loop {
        if !is_current(&state, generation) {
            return;
        }
        match process.try_exit(state.generation.load(Ordering::Acquire)) {
            Ok(Some(exit)) => {
                record_process_observation(&state, &process, &exit, None);
                if !exit_requires_failure(
                    process.generation(),
                    state.generation.load(Ordering::Acquire),
                    exit.reason,
                ) {
                    return;
                }
                abort_attempt(
                    &app,
                    &state,
                    generation,
                    &process,
                    DiagnosticCode::UnexpectedExit,
                );
                return;
            }
            Ok(None) => thread::sleep(Duration::from_millis(100)),
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
/// 启动一个新的、唯一的 CLI 启动轮次。
fn start_attempt(app: &AppHandle, state: &Arc<RuntimeState>) {
    let Ok(_navigation_gate) = state.navigation_operation_gate.lock() else {
        return;
    };
    let Ok(_gate) = state.generation_event_gate.lock() else {
        return;
    };
    let generation = state.generation.fetch_add(1, Ordering::AcqRel) + 1;
    if let Ok(mut started) = state.attempt_started.lock() {
        *started = Some(Instant::now());
    }
    reset_host_observation(state);
    transition(app, state, LifecycleState::Starting, "Starting.");
    drop(_gate);
    let app = app.clone();
    let state = Arc::clone(state);
    thread::spawn(move || run_attempt(app, state, generation));
}

/// 只允许用户在失败或超时但仍可恢复的状态发起 Retry。
fn retry_allowed(lifecycle: LifecycleState) -> bool {
    matches!(
        lifecycle,
        LifecycleState::Failed | LifecycleState::ProlongedStartup
    )
}

/// 请求一次串行重试；旧进程回收完成前绝不启动新 Host。
fn request_retry(app: &AppHandle, state: &Arc<RuntimeState>) {
    if state.shutting_down.load(Ordering::Acquire)
        || !state
            .snapshot
            .lock()
            .ok()
            .is_some_and(|snapshot| retry_allowed(snapshot.state))
        || state.retrying.swap(true, Ordering::AcqRel)
    {
        return;
    }
    let Ok(_navigation_gate) = state.navigation_operation_gate.lock() else {
        state.retrying.store(false, Ordering::Release);
        return;
    };
    let Ok(_event_gate) = state.generation_event_gate.lock() else {
        state.retrying.store(false, Ordering::Release);
        return;
    };
    if !state
        .snapshot
        .lock()
        .ok()
        .is_some_and(|snapshot| retry_allowed(snapshot.state))
    {
        state.retrying.store(false, Ordering::Release);
        return;
    }
    let cleanup_generation = state.generation.fetch_add(1, Ordering::AcqRel) + 1;
    reset_host_observation(state);
    transition(
        app,
        state,
        LifecycleState::Stopping,
        "Stopping the previous Host before retry.",
    );
    drop(_event_gate);
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
        let cleanup = process
            .as_ref()
            .map(|process| stop_cli(&state, process))
            .transpose();
        if cleanup.is_ok() {
            state.retrying.store(false, Ordering::Release);
            if !state.shutting_down.load(Ordering::Acquire) {
                start_attempt(&app, &state);
            }
        } else {
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

/// 请求应用退出，并保证 CLI 进程树被回收。
fn request_shutdown(app: &AppHandle, state: &Arc<RuntimeState>) {
    if state.shutting_down.swap(true, Ordering::AcqRel) {
        return;
    }
    let Ok(_navigation_gate) = state.navigation_operation_gate.lock() else {
        app.exit(1);
        return;
    };
    let Ok(_event_gate) = state.generation_event_gate.lock() else {
        app.exit(1);
        return;
    };
    state.generation.fetch_add(1, Ordering::AcqRel);
    reset_host_observation(state);
    transition(app, state, LifecycleState::Stopping, "Stopping local Host.");
    drop(_event_gate);
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
            .is_some_and(|process| stop_cli(&state, process).is_err());
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
    if !state
        .snapshot
        .lock()
        .ok()
        .is_some_and(|snapshot| retry_allowed(snapshot.state))
    {
        return Err("Retry is only available after failure or prolonged startup.".into());
    }
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
    /// 官方 Node/CLI 路径来源的脱敏状态。
    cli_path_status: String,
    /// 当前是否仍有被桌面端拥有的 CLI。
    cli_process_status: String,
    /// 最近一次 CLI 退出与 cleanup 的稳定监督结果。
    process_observation: Option<ProcessObservation>,
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
    let cli_process_status = state
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
        cli_path_status: state
            .node_path_status
            .lock()
            .map(|value| value.clone())
            .unwrap_or_else(|_| "unknown".into()),
        cli_process_status: cli_process_status.into(),
        process_observation: state
            .last_process_observation
            .lock()
            .ok()
            .and_then(|value| value.clone()),
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
    let diagnostics = build_startup_diagnostics(state.inner(), &snapshot);
    #[cfg(all(debug_assertions, feature = "wdio"))]
    if std::env::var_os("DSH_TEST_RECORD_FILE").is_some() {
        record_wdio_event(serde_json::json!({
            "event": "diagnostics-copied",
            "diagnostics": diagnostics
        }));
        return Ok(());
    }
    app.clipboard()
        .write_text(diagnostics)
        .map_err(|error| error.to_string())
}

/// 创建 Startup window，注册 Tauri IPC，并启动 direct CLI 生命周期监督线程。
fn setup(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let state = Arc::new(RuntimeState {
        snapshot: Mutex::new(LifecycleSnapshot {
            state: LifecycleState::Starting,
            message: "Starting.".into(),
            origin: None,
        }),
        process: Mutex::new(None),
        generation_event_gate: Mutex::new(()),
        navigation_operation_gate: Mutex::new(()),
        lifecycle_gate: Mutex::new(()),
        host_origin: Mutex::new(None),
        host_generation: Mutex::new(None),
        webview_navigation_generation: Mutex::new(None),
        webview_navigation_url: Mutex::new(None),
        webview_load_generation: Mutex::new(None),
        webview_load_url: Mutex::new(None),
        startup_url: Mutex::new(None),
        generation: AtomicU64::new(0),
        retrying: AtomicBool::new(false),
        shutting_down: AtomicBool::new(false),
        attempt_started: Mutex::new(None),
        node_path_status: Mutex::new("not-checked".into()),
        last_process_observation: Mutex::new(None),
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
            .on_page_load({
                let state = Arc::clone(&state);
                let app = app.handle().clone();
                move |_window, payload| {
                    let url = payload.url();
                    if payload.event() == PageLoadEvent::Started {
                        begin_client_page_load(&state, url);
                        return;
                    }
                    if !is_finished_page_load(payload.event()) {
                        return;
                    }
                    let is_app_page = (url.scheme() == "http"
                        && url.host_str() == Some("tauri.localhost"))
                        || (url.scheme() == "tauri" && url.host_str() == Some("localhost"));
                    if is_app_page {
                        if let Ok(mut startup_url) = state.startup_url.lock() {
                            *startup_url = Some(url.to_string());
                        }
                        #[cfg(all(debug_assertions, feature = "wdio"))]
                        record_wdio_event(serde_json::json!({
                            "event": "startup-page-loaded",
                            "url": url.as_str()
                        }));
                    }
                    mark_client_page_loaded(&app, &state, url);
                }
            })
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
                            open_external(&app, url.to_string());
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
                        open_external(&app, url.to_string());
                    }
                    tauri::webview::NewWindowResponse::Deny
                }
            })
            .build()?;
    if let Ok(url) = startup_window.url() {
        if is_packaged_startup_url(&url) {
            if let Ok(mut startup_url) = state.startup_url.lock() {
                *startup_url = Some(url.to_string());
            }
        }
        #[cfg(all(debug_assertions, feature = "wdio"))]
        record_wdio_event(serde_json::json!({
            "event": "startup-window-created",
            "url": url.as_str()
        }));
    }
    let state_for_close = Arc::clone(&state);
    startup_window.on_window_event(move |event| match event {
        WindowEvent::CloseRequested { api, .. } => {
            api.prevent_close();
            request_shutdown(&app_handle, &state_for_close);
        }
        WindowEvent::Destroyed => request_shutdown(&app_handle, &state_for_close),
        _ => {}
    });
    start_attempt(app.handle(), &state);
    Ok(())
}

/// 恢复并聚焦已有单实例窗口，同时为测试记录可验证结果。
fn activate_existing_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let before_minimized = window.is_minimized().unwrap_or(false);
        let unminimize_ok = window.unminimize().is_ok();
        let show_ok = window.show().is_ok();
        let focus_ok = window.set_focus().is_ok();
        #[cfg(all(debug_assertions, feature = "wdio"))]
        {
            let observed_window = window.clone();
            thread::spawn(move || {
                thread::sleep(Duration::from_millis(250));
                record_wdio_event(serde_json::json!({
                    "event": "single-instance-activated",
                    "beforeMinimized": before_minimized,
                    "unminimizeOk": unminimize_ok,
                    "showOk": show_ok,
                    "focusOk": focus_ok,
                    "afterMinimized": observed_window.is_minimized().unwrap_or(true),
                    "visible": observed_window.is_visible().unwrap_or(false),
                    "focused": observed_window.is_focused().unwrap_or(false)
                }));
            });
        }
        #[cfg(not(all(debug_assertions, feature = "wdio")))]
        let _ = (before_minimized, unminimize_ok, show_ok, focus_ok);
    }
}

/// 启动 Tauri 应用并安装单实例、外链和剪贴板插件。
fn main() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            activate_existing_window(app);
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
            startup_copy_diagnostics
        ]);
    #[cfg(feature = "wdio")]
    let builder = builder
        .plugin(tauri_plugin_wdio::init())
        .plugin(tauri_plugin_wdio_webdriver::init());
    builder
        .setup(setup)
        .run(tauri::generate_context!())
        .expect("error while running Tauri application");
}

#[cfg(test)]
mod tests {
    use super::{
        build_startup_diagnostics, bundled_node_relative_path, decide_navigation,
        exit_requires_failure, inspect_http_client_response, is_current_host_page_event,
        is_finished_page_load, is_html_client_response, is_packaged_startup_url,
        navigation_event_matches, parse_loopback_address, probe_client_page_with_timeout,
        retry_allowed, DiagnosticCode, ExitReason, HttpResponseState, LifecycleSnapshot,
        LifecycleState, NavigationDecision, PageLoadEvent, ProcessObservation, RuntimeState,
    };
    use std::io::Write;
    use std::net::TcpListener;
    use std::sync::atomic::{AtomicBool, AtomicU64};
    use std::sync::Mutex;
    use std::thread;
    use std::time::{Duration, Instant};
    /// 验证生命周期保留可恢复状态。
    #[test]
    fn lifecycle_has_recoverable_states() {
        assert_ne!(LifecycleState::Failed, LifecycleState::Ready);
        assert_ne!(LifecycleState::Stopping, LifecycleState::Starting);
        assert_eq!(
            LifecycleState::ALL,
            [
                LifecycleState::Starting,
                LifecycleState::WaitingForClient,
                LifecycleState::ProlongedStartup,
                LifecycleState::Ready,
                LifecycleState::Failed,
                LifecycleState::Stopping,
            ]
        );
    }
    /// 验证固定 origin 的尾斜杠不会破坏 TCP readiness 探测。
    #[test]
    fn parses_loopback_origin_with_trailing_slash() {
        assert_eq!(
            parse_loopback_address("http://127.0.0.1:1234/").unwrap(),
            "127.0.0.1:1234".parse().unwrap()
        );
    }

    /// 验证只有成功的 HTML 根页面响应才会通过客户端页面 readiness 探测。
    #[test]
    fn validates_html_client_response() {
        assert!(is_html_client_response(
            b"HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\n\r\n<html></html>"
        ));
        assert!(!is_html_client_response(
            b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n{}"
        ));
        assert!(!is_html_client_response(
            b"HTTP/1.1 503 Service Unavailable\r\nContent-Type: text/html\r\n\r\n<html></html>"
        ));
        assert!(!is_html_client_response(
            b"HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1:3080/login\r\nContent-Type: text/html\r\n\r\n<html></html>"
        ));
        assert!(!is_html_client_response(
            b"HTTP/1.1 200 OK\r\nContent-Type: text/html\r\n\r\n   \n"
        ));
        assert!(!is_html_client_response(
            b"HTTP/1.1 200 OK\r\nContent-Type: text/htmlfoo\r\nContent-Length: 6\r\n\r\n<html>"
        ));
        assert_eq!(
            inspect_http_client_response(
                b"HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: 12\r\n\r\n<html>",
                true,
            ),
            HttpResponseState::Reject
        );
        assert_eq!(
            inspect_http_client_response(
                b"HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nTransfer-Encoding: chunked\r\n\r\n6\r\n<html>\r\n0\r\n\r\n",
                true,
            ),
            HttpResponseState::Reject
        );
    }

    /// 验证 slow-drip 响应无法通过重置单次 read timeout 超过绝对截止时间。
    #[test]
    fn client_probe_has_an_absolute_deadline() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            for byte in b"HTTP/1.1 200 OK\r\nContent-Type: text/html\r\n\r\n<html>" {
                if stream.write_all(&[*byte]).is_err() {
                    break;
                }
                thread::sleep(Duration::from_millis(20));
            }
        });
        let started = Instant::now();
        assert!(!probe_client_page_with_timeout(
            address,
            Duration::from_millis(100)
        ));
        assert!(started.elapsed() < Duration::from_millis(400));
        server.join().unwrap();
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
            decide_navigation("http://tauri.localhost/private", startup, host),
            NavigationDecision::Deny
        );
        assert_eq!(
            decide_navigation("tauri://localhost/private", startup, host),
            NavigationDecision::Deny
        );
        assert!(is_packaged_startup_url(
            &"http://tauri.localhost/".parse().unwrap()
        ));
        assert!(is_packaged_startup_url(
            &"tauri://localhost/index.html".parse().unwrap()
        ));
        assert!(is_packaged_startup_url(
            &"tauri://localhost".parse().unwrap()
        ));
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
            generation_event_gate: Mutex::new(()),
            navigation_operation_gate: Mutex::new(()),
            lifecycle_gate: Mutex::new(()),
            host_origin: Mutex::new(None),
            host_generation: Mutex::new(None),
            webview_navigation_generation: Mutex::new(None),
            webview_navigation_url: Mutex::new(None),
            webview_load_generation: Mutex::new(None),
            webview_load_url: Mutex::new(None),
            startup_url: Mutex::new(None),
            generation: AtomicU64::new(1),
            retrying: AtomicBool::new(false),
            shutting_down: AtomicBool::new(false),
            attempt_started: Mutex::new(None),
            node_path_status: Mutex::new("bundled".into()),
            last_process_observation: Mutex::new(Some(ProcessObservation {
                generation: 1,
                exit_code: None,
                exit_signal: Some(9),
                exit_reason: "unexpected".into(),
                cleanup_outcome: Some("forced".into()),
            })),
            last_error: Mutex::new(Some(DiagnosticCode::SpawnFailed)),
        };
        let snapshot = LifecycleSnapshot {
            state: LifecycleState::Failed,
            message: "https://example.test/?token=secret C:\\Users\\alice".into(),
            origin: Some("http://127.0.0.1:1234/?token=secret".into()),
        };
        let diagnostics = build_startup_diagnostics(&state, &snapshot);
        assert!(diagnostics.contains("spawn_failed"));
        assert!(diagnostics.contains("stale_generation") || diagnostics.contains("unexpected"));
        assert!(diagnostics.contains("forced"));
        assert!(!diagnostics.contains("example.test"));
        assert!(!diagnostics.contains("token"));
        assert!(!diagnostics.contains("alice"));
    }

    /// 验证旧轮次或非等待状态的 Host 页面加载不会将桌面端误标为 Ready。
    #[test]
    fn only_current_waiting_host_page_is_client_ready() {
        let current = "http://127.0.0.1:3080/#dsh-desktop-generation=3"
            .parse()
            .unwrap();
        let stale = "http://127.0.0.1:3080/#dsh-desktop-generation=2"
            .parse()
            .unwrap();
        assert!(is_current_host_page_event(
            3,
            Some(3),
            Some(3),
            LifecycleState::WaitingForClient,
            true,
            Some("http://127.0.0.1:3080/#dsh-desktop-generation=3"),
            &current,
        ));
        assert!(!is_current_host_page_event(
            4,
            Some(3),
            Some(3),
            LifecycleState::WaitingForClient,
            true,
            Some("http://127.0.0.1:3080/#dsh-desktop-generation=3"),
            &current,
        ));
        assert!(!is_current_host_page_event(
            3,
            Some(3),
            Some(2),
            LifecycleState::WaitingForClient,
            true,
            Some("http://127.0.0.1:3080/#dsh-desktop-generation=3"),
            &current,
        ));
        assert!(!is_current_host_page_event(
            3,
            Some(3),
            Some(3),
            LifecycleState::WaitingForClient,
            false,
            Some("http://127.0.0.1:3080/#dsh-desktop-generation=3"),
            &current,
        ));
        assert!(!is_current_host_page_event(
            3,
            Some(3),
            Some(3),
            LifecycleState::Ready,
            true,
            Some("http://127.0.0.1:3080/#dsh-desktop-generation=3"),
            &current,
        ));
        assert!(!is_current_host_page_event(
            3,
            Some(3),
            Some(3),
            LifecycleState::WaitingForClient,
            true,
            Some("http://127.0.0.1:3080/#dsh-desktop-generation=3"),
            &stale,
        ));
    }

    /// 验证新导航已 arm 后，旧 fragment 的 Started/Finished 都不能借用当前 generation 发布 Ready。
    #[test]
    fn stale_page_events_cannot_claim_a_new_navigation_token() {
        let old = "http://127.0.0.1:3080/#dsh-desktop-generation=2";
        let current = "http://127.0.0.1:3080/#dsh-desktop-generation=3";
        assert!(!navigation_event_matches(3, Some(3), Some(current), old));
        assert!(!is_current_host_page_event(
            3,
            Some(3),
            None,
            LifecycleState::WaitingForClient,
            true,
            Some(current),
            &old.parse().unwrap(),
        ));
        assert!(navigation_event_matches(3, Some(3), Some(current), current));
        assert!(is_current_host_page_event(
            3,
            Some(3),
            Some(3),
            LifecycleState::WaitingForClient,
            true,
            Some(current),
            &current.parse().unwrap(),
        ));
    }

    /// 验证只有 Failed 和 Prolonged startup 允许 IPC Retry。
    #[test]
    fn retry_is_limited_to_recoverable_states() {
        assert!(retry_allowed(LifecycleState::Failed));
        assert!(retry_allowed(LifecycleState::ProlongedStartup));
        assert!(!retry_allowed(LifecycleState::Starting));
        assert!(!retry_allowed(LifecycleState::WaitingForClient));
        assert!(!retry_allowed(LifecycleState::Ready));
        assert!(!retry_allowed(LifecycleState::Stopping));
    }

    /// 验证 WebView Started 事件不会提前满足 client readiness。
    #[test]
    fn client_readiness_requires_finished_page_load() {
        assert!(!is_finished_page_load(PageLoadEvent::Started));
        assert!(is_finished_page_load(PageLoadEvent::Finished));
    }

    /// 验证 Ready 后当前 CLI 的非预期退出会失败，而预期或旧轮次退出被忽略。
    #[test]
    fn classifies_runtime_exit_against_current_generation() {
        assert!(exit_requires_failure(3, 3, ExitReason::Unexpected));
        assert!(!exit_requires_failure(3, 3, ExitReason::Requested));
        assert!(!exit_requires_failure(2, 3, ExitReason::Unexpected));
        assert!(!exit_requires_failure(2, 3, ExitReason::StaleGeneration));
    }
}
