#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[cfg(all(not(debug_assertions), feature = "wdio"))]
compile_error!("the wdio feature is test-only and cannot be enabled in release builds");

mod cli_supervisor;
mod desktop_capabilities;
mod lifecycle;

use cli_supervisor::{
    build_command_plan, spawn_cli, CliProcess, ExitReason, ProcessExit, StopReport,
    SupervisorError, HOST_ORIGIN,
};
use desktop_capabilities::app_update::tauri_adapter::TauriUpdateRuntime;
use desktop_capabilities::app_update::{UpdateInput, UpdateSnapshot};
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
use tauri::menu::{CheckMenuItemBuilder, MenuBuilder, MenuItemBuilder, SubmenuBuilder};
use tauri::webview::PageLoadEvent;
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_opener::OpenerExt;

#[cfg(unix)]
use std::os::unix::process::ExitStatusExt;

const SNAPSHOT_EVENT: &str = "startup:snapshot";
const PROLONGED_STARTUP_AFTER: Duration = Duration::from_secs(30);
const HTTP_PROBE_TIMEOUT: Duration = Duration::from_millis(750);
const HTTP_BODY_CAP: usize = 64 * 1024;
const HTTP_METADATA_CAP: usize = 16 * 1024;
const HTTP_WIRE_CAP: usize = HTTP_BODY_CAP + HTTP_METADATA_CAP;
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

/// 判断调用方是否是精确的 Desktop 打包更新页面，拒绝 Host origin 冒充确认界面。
fn is_packaged_update_url(target: &tauri::Url) -> bool {
    let packaged_origin = (target.scheme() == "http"
        && target.host_str() == Some("tauri.localhost"))
        || (target.scheme() == "tauri" && target.host_str() == Some("localhost"));
    packaged_origin
        && target.path() == "/update.html"
        && target.query().is_none()
        && target.fragment().is_none()
}

/// 判断 URL 是否属于 Tauri CLI 在 debug 模式提供的固定本地启动页 origin。
fn is_development_startup_origin(target: &tauri::Url) -> bool {
    cfg!(debug_assertions)
        && target.scheme() == "http"
        && target.host_str() == Some("127.0.0.1")
        && target.port_or_known_default() == Some(1430)
}

/// 判断 URL 是否是当前构建模式允许承载 Startup page 的精确入口。
fn is_startup_url(target: &tauri::Url) -> bool {
    is_packaged_startup_url(target)
        || (is_development_startup_origin(target)
            && matches!(target.path(), "" | "/" | "/index.html")
            && target.query().is_none()
            && target.fragment().is_none())
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
    if is_startup_url(&target) {
        return NavigationDecision::Allow;
    }
    if (target.scheme() == "http" && target.host_str() == Some("tauri.localhost"))
        || (target.scheme() == "tauri" && target.host_str() == Some("localhost"))
        || is_development_startup_origin(&target)
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
    if let Some(updater) = app.try_state::<Arc<TauriUpdateRuntime>>() {
        updater.inner().dispatch(app, UpdateInput::Ready);
    }
}

/// HTTP 响应在有界读取中的严格 framing 判定。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum HttpResponseState {
    NeedMore,
    Ready,
    Reject,
}

/// 判断一个字节是否属于 RFC 9110 token 字符。
fn is_http_token_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric()
        || matches!(
            byte,
            b'!' | b'#'
                | b'$'
                | b'%'
                | b'&'
                | b'\''
                | b'*'
                | b'+'
                | b'-'
                | b'.'
                | b'^'
                | b'_'
                | b'`'
                | b'|'
                | b'~'
        )
}

/// 判断字节串是否为非空 RFC 9110 token。
fn is_http_token(value: &[u8]) -> bool {
    !value.is_empty() && value.iter().copied().all(is_http_token_byte)
}

/// 按 grammar 扫描 chunk extensions，支持 quoted-string 内的分号和安全转义。
fn valid_chunk_extensions(extensions: &[u8]) -> bool {
    let mut offset = 0_usize;
    while offset < extensions.len() {
        if extensions[offset] != b';' {
            return false;
        }
        offset += 1;
        let name_start = offset;
        while offset < extensions.len() && is_http_token_byte(extensions[offset]) {
            offset += 1;
        }
        if offset == name_start {
            return false;
        }
        if offset == extensions.len() || extensions[offset] == b';' {
            continue;
        }
        if extensions[offset] != b'=' {
            return false;
        }
        offset += 1;
        if offset == extensions.len() {
            return false;
        }
        if extensions[offset] != b'"' {
            let value_start = offset;
            while offset < extensions.len() && is_http_token_byte(extensions[offset]) {
                offset += 1;
            }
            if offset == value_start || (offset < extensions.len() && extensions[offset] != b';') {
                return false;
            }
            continue;
        }
        offset += 1;
        let mut closed = false;
        while offset < extensions.len() {
            let byte = extensions[offset];
            offset += 1;
            if byte == b'"' {
                closed = true;
                break;
            }
            if byte == b'\\' {
                if offset == extensions.len()
                    || !extensions[offset].is_ascii()
                    || extensions[offset].is_ascii_control()
                {
                    return false;
                }
                offset += 1;
            } else if byte.is_ascii_control() {
                return false;
            }
        }
        if !closed || (offset < extensions.len() && extensions[offset] != b';') {
            return false;
        }
    }
    true
}

/// 解析合法的十六进制 chunk size，并保守校验可选 extension。
fn parse_chunk_size(line: &[u8]) -> Option<usize> {
    if line.is_empty() || line.len() > HTTP_METADATA_CAP {
        return None;
    }
    let extension_offset = line
        .iter()
        .position(|byte| *byte == b';')
        .unwrap_or(line.len());
    let raw_size = &line[..extension_offset];
    if raw_size.is_empty() || raw_size.len() > 16 || !raw_size.iter().all(u8::is_ascii_hexdigit) {
        return None;
    }
    if !valid_chunk_extensions(&line[extension_offset..]) {
        return None;
    }
    usize::from_str_radix(std::str::from_utf8(raw_size).ok()?, 16).ok()
}

/// 校验 trailer 行，拒绝折行、控制字符和会改变 framing 的字段。
fn valid_chunk_trailer(line: &[u8]) -> bool {
    let Some(separator) = line.iter().position(|byte| *byte == b':') else {
        return false;
    };
    let name = &line[..separator];
    let value = &line[separator + 1..];
    is_http_token(name)
        && !name.eq_ignore_ascii_case(b"content-length")
        && !name.eq_ignore_ascii_case(b"transfer-encoding")
        && value
            .iter()
            .all(|byte| *byte == b'\t' || !byte.is_ascii_control())
}

/// 在不分配解码缓冲区的前提下严格解析完整 chunked body。
fn inspect_chunked_body(body: &[u8], eof: bool) -> HttpResponseState {
    let incomplete = || {
        if eof || body.len() == HTTP_WIRE_CAP {
            HttpResponseState::Reject
        } else {
            HttpResponseState::NeedMore
        }
    };
    let mut offset = 0_usize;
    let mut decoded = 0_usize;
    let mut nonempty = false;
    loop {
        let Some(line_end) = body[offset..]
            .windows(2)
            .position(|bytes| bytes == b"\r\n")
            .map(|relative| offset + relative)
        else {
            return incomplete();
        };
        if line_end - offset > HTTP_METADATA_CAP {
            return HttpResponseState::Reject;
        }
        let Some(chunk_size) = parse_chunk_size(&body[offset..line_end]) else {
            return HttpResponseState::Reject;
        };
        offset = line_end + 2;
        if chunk_size == 0 {
            let trailer_start = offset;
            loop {
                let Some(trailer_end) = body[offset..]
                    .windows(2)
                    .position(|bytes| bytes == b"\r\n")
                    .map(|relative| offset + relative)
                else {
                    return incomplete();
                };
                if trailer_end - trailer_start > HTTP_METADATA_CAP {
                    return HttpResponseState::Reject;
                }
                if trailer_end == offset {
                    offset += 2;
                    return if offset == body.len() && nonempty {
                        HttpResponseState::Ready
                    } else {
                        HttpResponseState::Reject
                    };
                }
                if !valid_chunk_trailer(&body[offset..trailer_end]) {
                    return HttpResponseState::Reject;
                }
                offset = trailer_end + 2;
            }
        }
        let Some(next_decoded) = decoded.checked_add(chunk_size) else {
            return HttpResponseState::Reject;
        };
        if next_decoded > HTTP_BODY_CAP {
            return HttpResponseState::Reject;
        }
        let Some(data_end) = offset.checked_add(chunk_size) else {
            return HttpResponseState::Reject;
        };
        let Some(framed_end) = data_end.checked_add(2) else {
            return HttpResponseState::Reject;
        };
        if framed_end > body.len() {
            return incomplete();
        }
        if &body[data_end..framed_end] != b"\r\n" {
            return HttpResponseState::Reject;
        }
        nonempty |= body[offset..data_end]
            .iter()
            .any(|byte| !byte.is_ascii_whitespace());
        decoded = next_decoded;
        offset = framed_end;
    }
}

/// 判断已读响应是否具有完整、有界且非空的 HTML body。
fn inspect_http_client_response(response: &[u8], eof: bool) -> HttpResponseState {
    if response.len() > HTTP_WIRE_CAP {
        return HttpResponseState::Reject;
    }
    let Some(header_offset) = response.windows(4).position(|bytes| bytes == b"\r\n\r\n") else {
        return if eof || response.len() > HTTP_METADATA_CAP {
            HttpResponseState::Reject
        } else {
            HttpResponseState::NeedMore
        };
    };
    if header_offset > HTTP_METADATA_CAP {
        return HttpResponseState::Reject;
    }
    let body_offset = header_offset + 4;
    let Ok(headers) = std::str::from_utf8(&response[..header_offset]) else {
        return HttpResponseState::Reject;
    };
    let mut lines = headers.split("\r\n");
    let Some(status) = lines.next() else {
        return HttpResponseState::Reject;
    };
    let mut status_fields = status.split_ascii_whitespace();
    let successful_status = status_fields.next() == Some("HTTP/1.1")
        && status_fields
            .next()
            .filter(|code| code.len() == 3 && code.bytes().all(|byte| byte.is_ascii_digit()))
            .and_then(|code| code.parse::<u16>().ok())
            .is_some_and(|code| (200..300).contains(&code));
    if !successful_status {
        return HttpResponseState::Reject;
    }
    let mut content_types = Vec::new();
    let mut content_lengths = Vec::new();
    let mut transfer_encodings = Vec::new();
    for line in lines {
        let Some((name, value)) = line.split_once(':') else {
            return HttpResponseState::Reject;
        };
        if !is_http_token(name.as_bytes())
            || value
                .bytes()
                .any(|byte| byte != b'\t' && byte.is_ascii_control())
        {
            return HttpResponseState::Reject;
        }
        if name.eq_ignore_ascii_case("content-type") {
            content_types.push(value.trim());
        } else if name.eq_ignore_ascii_case("content-length") {
            content_lengths.push(value.trim());
        } else if name.eq_ignore_ascii_case("transfer-encoding") {
            transfer_encodings.push(value.trim());
        }
    }
    let html_type = content_types.len() == 1
        && content_types[0]
            .split(';')
            .next()
            .is_some_and(|media_type| media_type.trim().eq_ignore_ascii_case("text/html"));
    if !html_type || content_lengths.len() > 1 || transfer_encodings.len() > 1 {
        return HttpResponseState::Reject;
    }
    if let Some(transfer_encoding) = transfer_encodings.first() {
        let mut codings = transfer_encoding.split(',').map(str::trim);
        if !content_lengths.is_empty()
            || !codings
                .next()
                .is_some_and(|coding| coding.eq_ignore_ascii_case("chunked"))
            || codings.next().is_some()
        {
            return HttpResponseState::Reject;
        }
        return inspect_chunked_body(&response[body_offset..], eof);
    }
    let body_nonempty = |body: &[u8]| body.iter().any(|byte| !byte.is_ascii_whitespace());
    if let Some(raw_length) = content_lengths.first() {
        if raw_length.is_empty() || !raw_length.bytes().all(|byte| byte.is_ascii_digit()) {
            return HttpResponseState::Reject;
        }
        let Ok(length) = raw_length.parse::<usize>() else {
            return HttpResponseState::Reject;
        };
        let Some(expected_total) = body_offset.checked_add(length) else {
            return HttpResponseState::Reject;
        };
        if length == 0 || length > HTTP_BODY_CAP || response.len() > expected_total {
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
    if response.len() - body_offset > HTTP_BODY_CAP {
        return HttpResponseState::Reject;
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
        if remaining.is_zero() || response.len() == HTTP_WIRE_CAP {
            return false;
        }
        let _ = stream.set_read_timeout(Some(remaining));
        let available = (HTTP_WIRE_CAP - response.len()).min(buffer.len());
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
        std::env::var_os("DSH_TEST_CLI_ENTRY").filter(|value| !value.is_empty())
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
    #[cfg(all(debug_assertions, feature = "wdio"))]
    record_wdio_event(serde_json::json!({
        "event": "cli-cleaned",
        "generation": process.generation(),
        "pid": process.pid().ok()
    }));
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

/// 标识触发应用退出的真实原生窗口事件。
#[derive(Clone, Copy)]
enum ShutdownSource {
    /// 最终窗口收到关闭请求。
    CloseRequested,
    /// 最终窗口已被销毁后的兜底事件。
    Destroyed,
    /// 开发终端发出的 SIGINT 或 SIGTERM。
    TerminalSignal,
    /// 打包来源更新界面请求安装后重启。
    UpdateRestart,
}

#[cfg(all(debug_assertions, feature = "wdio"))]
impl ShutdownSource {
    /// 返回结构化测试记录使用的 shutdown 来源。
    fn as_str(self) -> &'static str {
        match self {
            Self::CloseRequested => "close-requested",
            Self::Destroyed => "destroyed",
            Self::TerminalSignal => "terminal-signal",
            Self::UpdateRestart => "update-restart",
        }
    }
}

/// 请求应用退出，并保证 CLI 进程树被回收。
fn request_shutdown(app: &AppHandle, state: &Arc<RuntimeState>, source: ShutdownSource) {
    if state.shutting_down.swap(true, Ordering::AcqRel) {
        return;
    }
    #[cfg(all(debug_assertions, feature = "wdio"))]
    let shutdown_generation = state
        .process
        .lock()
        .ok()
        .and_then(|process| process.as_ref().map(|process| process.generation()))
        .unwrap_or_else(|| state.generation.load(Ordering::Acquire));
    #[cfg(all(debug_assertions, feature = "wdio"))]
    record_wdio_event(serde_json::json!({
        "event": "native-shutdown-requested",
        "generation": shutdown_generation,
        "source": source.as_str()
    }));
    #[cfg(not(all(debug_assertions, feature = "wdio")))]
    let _ = source;
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
        let update_requested = matches!(
            source,
            ShutdownSource::CloseRequested | ShutdownSource::UpdateRestart
        ) && app
            .try_state::<Arc<TauriUpdateRuntime>>()
            .is_some_and(|updater| updater.has_staged());
        let install_failed = !cleanup_failed
            && update_requested
            && app
                .try_state::<Arc<TauriUpdateRuntime>>()
                .is_none_or(|updater| updater.install_staged(&app).is_err());
        #[cfg(all(debug_assertions, feature = "wdio"))]
        record_wdio_event(serde_json::json!({
            "event": "native-shutdown-completed",
            "generation": shutdown_generation,
            "cleanupSucceeded": !cleanup_failed
        }));
        if !cleanup_failed && !install_failed && matches!(source, ShutdownSource::UpdateRestart) {
            app.restart();
        } else {
            app.exit(if cleanup_failed || install_failed {
                1
            } else {
                0
            });
        }
    });
}

/// 开发构建捕获终端退出信号，先回收 CLI 进程树再退出 Desktop。
#[cfg(all(debug_assertions, unix))]
fn register_development_shutdown_signals(
    app: AppHandle,
    state: Arc<RuntimeState>,
) -> Result<(), std::io::Error> {
    use signal_hook::consts::signal::{SIGINT, SIGTERM};
    use signal_hook::iterator::Signals;

    let mut signals = Signals::new([SIGINT, SIGTERM])?;
    thread::spawn(move || {
        let mut shutdown_requested = false;
        for _signal in signals.forever() {
            if shutdown_requested {
                std::process::exit(130);
            }
            shutdown_requested = true;
            request_shutdown(&app, &state, ShutdownSource::TerminalSignal);
        }
    });
    Ok(())
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
    lifecycle_state: LifecycleState,
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
        lifecycle_state: snapshot.state,
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

/// 返回 Rust 所有的完整更新快照，不接受任何更新资源参数。
#[tauri::command]
fn app_update_snapshot(state: State<'_, Arc<TauriUpdateRuntime>>) -> UpdateSnapshot {
    state.snapshot()
}

/// 只请求打开 Desktop 打包来源的更新界面，不接受 URL、路径或安装参数。
#[tauri::command]
fn app_update_open_surface(app: AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("app-update") {
        window
            .show()
            .map_err(|_| "update surface unavailable".to_string())?;
        window
            .set_focus()
            .map_err(|_| "update surface unavailable".to_string())?;
        return Ok(());
    }
    WebviewWindowBuilder::new(&app, "app-update", WebviewUrl::App("update.html".into()))
        .title("DeepSeek Harness Desktop Update")
        .inner_size(520.0, 440.0)
        .resizable(false)
        .center()
        .build()
        .map(|_| ())
        .map_err(|_| "update surface unavailable".to_string())
}

/// 接受打包来源界面的无参数重启确认；包选择和安装原语仍完全由 Rust 所有。
#[tauri::command]
fn app_update_restart(
    app: AppHandle,
    window: tauri::WebviewWindow,
    lifecycle: State<'_, Arc<RuntimeState>>,
) -> Result<(), String> {
    let trusted_surface = window.label() == "app-update"
        && window.url().is_ok_and(|url| is_packaged_update_url(&url));
    if !trusted_surface {
        return Err("Update confirmation requires the Desktop update surface.".into());
    }
    let staged = app
        .try_state::<Arc<TauriUpdateRuntime>>()
        .is_some_and(|updater| updater.has_staged());
    if !staged {
        return Err("No staged update is available.".into());
    }
    request_shutdown(&app, lifecycle.inner(), ShutdownSource::UpdateRestart);
    Ok(())
}

/// 安装原生更新菜单，并把菜单意图直接送入 Rust controller。
fn install_update_menu(app: &tauri::App, updater: &Arc<TauriUpdateRuntime>) -> tauri::Result<()> {
    let check = MenuItemBuilder::with_id("app-update-check", "Check for Updates").build(app)?;
    let automatic = CheckMenuItemBuilder::with_id(
        "app-update-automatic-download",
        "Automatically Download Updates",
    )
    .checked(updater.snapshot().automatic_download)
    .build(app)?;
    let submenu = SubmenuBuilder::new(app, "Updates")
        .item(&check)
        .item(&automatic)
        .build()?;
    let menu = MenuBuilder::new(app).item(&submenu).build()?;
    app.set_menu(menu)?;
    let updater = Arc::clone(updater);
    app.on_menu_event(move |app, event| match event.id().as_ref() {
        "app-update-check" => updater.dispatch(app, UpdateInput::ManualCheck),
        "app-update-automatic-download" => {
            let enabled = !updater.snapshot().automatic_download;
            updater.dispatch(app, UpdateInput::SetAutomaticDownload(enabled));
        }
        _ => {}
    });
    Ok(())
}

/// 创建 Startup window，注册 Tauri IPC，并启动 direct CLI 生命周期监督线程。
fn setup(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    #[cfg(all(debug_assertions, feature = "wdio"))]
    record_wdio_event(serde_json::json!({
        "event": "backend-started",
        "pid": std::process::id()
    }));
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
    let update_runtime = TauriUpdateRuntime::new(app.handle())?;
    install_update_menu(app, &update_runtime)?;
    app.manage(update_runtime);
    let app_handle = app.handle().clone();
    #[cfg(all(debug_assertions, unix))]
    register_development_shutdown_signals(app_handle.clone(), Arc::clone(&state))?;
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
                    let is_app_page = is_startup_url(url);
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
        if is_startup_url(&url) {
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
            request_shutdown(
                &app_handle,
                &state_for_close,
                ShutdownSource::CloseRequested,
            );
        }
        WindowEvent::Destroyed => {
            request_shutdown(&app_handle, &state_for_close, ShutdownSource::Destroyed)
        }
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
        .plugin(
            tauri_plugin_updater::Builder::new()
                .pubkey(option_env!("DSH_UPDATER_PUBLIC_KEY").unwrap_or(""))
                .build(),
        );
    let builder = builder.invoke_handler(tauri::generate_handler![
        startup_snapshot,
        startup_retry,
        startup_copy_diagnostics,
        app_update_snapshot,
        app_update_open_surface,
        app_update_restart
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
mod tests;
