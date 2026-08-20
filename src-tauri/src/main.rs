#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::{Deserialize, Serialize};
use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{mpsc, Arc, Mutex};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::thread;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_opener::OpenerExt;

const SNAPSHOT_EVENT: &str = "startup:snapshot";
const PROLONGED_STARTUP_AFTER: Duration = Duration::from_secs(30);
const SIDECAR_STOP_AFTER: Duration = Duration::from_secs(8);

/// Sidecar 生命周期消息的 JSON 表示。
#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "kebab-case", tag = "type")]
enum SidecarMessage {
    Ready { origin: String },
    StartupFailed { error: SidecarError },
    Stopped,
    StopFailed { error: SidecarError },
}

/// Sidecar 返回的可序列化错误。
#[derive(Debug, Deserialize, Serialize, Clone)]
struct SidecarError { name: String, message: String }

/// 生命周期状态，序列化后作为启动页的稳定协议。
#[derive(Debug, Serialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
enum LifecycleState { Starting, StartingSidecar, WaitingForClient, ProlongedStartup, Ready, Failed, Stopping }

/// 启动页可见的生命周期快照。
#[derive(Debug, Serialize, Clone)]
struct LifecycleSnapshot { state: LifecycleState, message: String, origin: Option<String> }

/// 由 Tauri 持有并可在重试期间共享的 Node sidecar 句柄。
struct SidecarProcess { child: Mutex<Child>, stdin: Mutex<Option<ChildStdin>> }

/// Tauri shell 的共享运行时状态。
struct RuntimeState {
    snapshot: Mutex<LifecycleSnapshot>,
    process: Mutex<Option<Arc<SidecarProcess>>>,
    host_origin: Mutex<Option<String>>,
    startup_url: Mutex<Option<String>>,
    generation: AtomicU64,
    retrying: AtomicBool,
    shutting_down: AtomicBool,
    logs_dir: PathBuf,
    last_error: Mutex<Option<String>>,
}

/// 解析官方 Node sidecar 的生命周期输出。
fn parse_sidecar_message(line: &str) -> Result<SidecarMessage, String> {
    serde_json::from_str(line).map_err(|error| format!("invalid sidecar message: {error}"))
}

/// 判断一个 URL 是否是当前 Desktop 允许的精确 loopback origin。
fn is_allowed_host_origin(origin: &str) -> bool {
    let Ok(url) = origin.parse::<tauri::Url>() else { return false };
    url.scheme() == "http" && url.host_str() == Some("127.0.0.1") && url.port().is_some()
        && url.path() == "/" && url.query().is_none() && url.fragment().is_none()
}

/// 对窗口导航作出允许、交给系统浏览器或拒绝的决定。
fn decide_navigation(raw_url: &str, startup_url: &str, host_origin: Option<&str>) -> NavigationDecision {
    if raw_url == startup_url { return NavigationDecision::Allow }
    let Ok(target) = raw_url.parse::<tauri::Url>() else { return NavigationDecision::Deny };
    if host_origin.is_some_and(|origin| target.origin().ascii_serialization() == origin && target.scheme() == "http") {
        return NavigationDecision::Allow;
    }
    if target.scheme() == "http" || target.scheme() == "https" { return NavigationDecision::External }
    NavigationDecision::Deny
}

/// 导航策略的三种结果。
#[derive(Debug, PartialEq, Eq)]
enum NavigationDecision { Allow, External, Deny }

/// 返回当前构建目标使用的 Node 资源目录名。
fn platform_arch() -> &'static str {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("windows", "x86_64") => "windows-x86_64", ("windows", "aarch64") => "windows-aarch64",
        ("macos", "x86_64") => "macos-x86_64", ("macos", "aarch64") => "macos-aarch64",
        ("linux", "x86_64") => "linux-x86_64", ("linux", "aarch64") => "linux-aarch64", _ => "unsupported",
    }
}

/// 解析开发态或打包态的官方 Node 可执行文件路径。
fn resolve_node_path(resource_dir: &Path) -> Result<PathBuf, String> {
    if let Some(path) = std::env::var_os("DSH_NODE_PATH").filter(|value| !value.is_empty()) { return Ok(PathBuf::from(path)); }
    let filename = if cfg!(windows) { "node.exe" } else { "node" };
    let bundled = resource_dir.join("node").join(platform_arch()).join(filename);
    if bundled.is_file() { return Ok(bundled) }
    if cfg!(debug_assertions) { return Ok(PathBuf::from(filename)) }
    Err(format!("official Node sidecar is missing: {}", bundled.display()))
}

/// 发布一份生命周期快照，并通知当前 Webview。
fn publish_snapshot(app: &AppHandle, state: &RuntimeState, snapshot: LifecycleSnapshot) {
    if let Ok(mut current) = state.snapshot.lock() { *current = snapshot.clone(); }
    let _ = app.emit_to("main", SNAPSHOT_EVENT, snapshot);
}

/// 生成并发布一个状态。
fn transition(app: &AppHandle, state: &RuntimeState, lifecycle: LifecycleState, message: impl Into<String>) {
    publish_snapshot(app, state, LifecycleSnapshot { state: lifecycle, message: message.into(), origin: state.host_origin.lock().ok().and_then(|value| value.clone()) });
}

/// 判断某个启动轮次是否仍然有效。
fn is_current(state: &RuntimeState, generation: u64) -> bool {
    !state.shutting_down.load(Ordering::Acquire) && state.generation.load(Ordering::Acquire) == generation
}

/// 等待 Harness loopback listener；等待超过 30 秒只进入可恢复状态，不自动失败。
fn wait_for_web_listener(app: &AppHandle, state: &RuntimeState, generation: u64, origin: &str) -> Result<(), String> {
    let address = origin.strip_prefix("http://").ok_or_else(|| format!("unexpected Harness origin: {origin}"))?.parse::<SocketAddr>().map_err(|error| format!("invalid Harness origin: {error}"))?;
    let started = Instant::now();
    let mut prolonged = false;
    loop {
        if !is_current(state, generation) { return Err("startup attempt cancelled".into()) }
        if TcpStream::connect_timeout(&address, Duration::from_millis(500)).is_ok() { return Ok(()) }
        if !prolonged && started.elapsed() >= PROLONGED_STARTUP_AFTER { prolonged = true; transition(app, state, LifecycleState::ProlongedStartup, "Startup is taking longer than expected. You can retry when ready."); }
        thread::sleep(Duration::from_millis(100));
    }
}

/// 启动一个官方 Node sidecar，并返回共享进程句柄与生命周期消息通道。
fn spawn_sidecar(app: &AppHandle, state: &RuntimeState) -> Result<(Arc<SidecarProcess>, mpsc::Receiver<SidecarMessage>), String> {
    let resource_dir = app.path().resource_dir().map_err(|error| error.to_string())?;
    let node_path = resolve_node_path(&resource_dir)?;
    let script = if cfg!(debug_assertions) { PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../dist/sidecar/index.js") } else { resource_dir.join("dist/sidecar/index.js") };
    if !script.is_file() { return Err(format!("sidecar bootstrap is missing: {}", script.display())); }
    let harness_home = app.path().app_data_dir().map_err(|error| error.to_string())?;
    fs::create_dir_all(&harness_home).map_err(|error| error.to_string())?;
    let mut command = Command::new(node_path);
    command.arg(script).current_dir(&harness_home).env("DSH_HOME", &harness_home).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::inherit());
    let mut child = command.spawn().map_err(|error| format!("failed to spawn Node sidecar: {error}"))?;
    let stdin = child.stdin.take().ok_or_else(|| "Node sidecar stdin unavailable".to_string())?;
    let stdout = child.stdout.take().ok_or_else(|| "Node sidecar stdout unavailable".to_string())?;
    let process = Arc::new(SidecarProcess { child: Mutex::new(child), stdin: Mutex::new(Some(stdin)) });
    if let Ok(mut current) = state.process.lock() { *current = Some(Arc::clone(&process)); }
    let (sender, receiver) = mpsc::channel();
    thread::spawn(move || { for line in BufReader::new(stdout).lines().flatten() { if let Ok(message) = parse_sidecar_message(line.trim()) { let _ = sender.send(message); } } });
    Ok((process, receiver))
}

/// 终止 sidecar，并在优雅停止超时后终止整个进程树。
fn stop_sidecar(process: &Arc<SidecarProcess>) {
    if let Ok(mut stdin) = process.stdin.lock() { if let Some(mut input) = stdin.take() { let _ = writeln!(input, "{{\"type\":\"stop\"}}"); } }
    let deadline = Instant::now() + SIDECAR_STOP_AFTER;
    loop {
        let exited = process.child.lock().ok().and_then(|mut child| child.try_wait().ok()).flatten().is_some();
        if exited { return }
        if Instant::now() >= deadline { break }
        thread::sleep(Duration::from_millis(100));
    }
    let pid = process.child.lock().ok().map(|child| child.id());
    #[cfg(windows)] if let Some(pid) = pid { let _ = Command::new("taskkill").args(["/PID", &pid.to_string(), "/T", "/F"]).status(); }
    #[cfg(not(windows))] if let Ok(mut child) = process.child.lock() { let _ = child.kill(); }
}

/// 将窗口导航到打包启动页，供失败和崩溃恢复复用。
fn navigate_to_startup(app: &AppHandle, state: &RuntimeState) {
    let Some(raw_url) = state.startup_url.lock().ok().and_then(|value| value.clone()) else { return };
    let Ok(url) = raw_url.parse() else { return };
    let app = app.clone();
    let app_for_task = app.clone();
    let _ = app.run_on_main_thread(move || { if let Some(window) = app_for_task.get_webview_window("main") { let _ = window.navigate(url); } });
}

/// 将窗口导航到当前启动轮次的 Host 页面。
fn navigate_to_host(app: &AppHandle, origin: &str) {
    let Ok(url) = origin.parse() else { return };
    let app = app.clone();
    let app_for_task = app.clone();
    let _ = app.run_on_main_thread(move || { if let Some(window) = app_for_task.get_webview_window("main") { let _ = window.navigate(url); } });
}

/// 记录启动失败并恢复到统一启动页。
fn fail_attempt(app: &AppHandle, state: &RuntimeState, generation: u64, error: impl Into<String>) {
    if !is_current(state, generation) { return }
    let message = error.into();
    if let Ok(mut last_error) = state.last_error.lock() { *last_error = Some(message); }
    transition(app, state, LifecycleState::Failed, "Startup failed. Retry, copy diagnostics, or open logs.");
    navigate_to_startup(app, state);
}

/// 执行一个启动轮次，并在 sidecar 意外退出时回到启动失败页。
fn run_attempt(app: AppHandle, state: Arc<RuntimeState>, generation: u64) {
    transition(&app, &state, LifecycleState::StartingSidecar, "Starting local Host.");
    let (process, receiver) = match spawn_sidecar(&app, &state) { Ok(result) => result, Err(error) => { fail_attempt(&app, &state, generation, error); return; } };
    transition(&app, &state, LifecycleState::WaitingForClient, "Waiting for client to start.");
    let started = Instant::now();
    let mut ready_origin: Option<String> = None;
    loop {
        if !is_current(&state, generation) { return }
        if let Ok(message) = receiver.recv_timeout(Duration::from_millis(100)) {
            match message {
                SidecarMessage::Ready { origin } => {
                    if !is_allowed_host_origin(&origin) { fail_attempt(&app, &state, generation, "Host reported an invalid loopback origin"); return; }
                    ready_origin = Some(origin.clone());
                    if let Ok(mut current) = state.host_origin.lock() { *current = Some(origin.clone()); }
                    if let Err(error) = wait_for_web_listener(&app, &state, generation, &origin) { if is_current(&state, generation) { fail_attempt(&app, &state, generation, error); } return; }
                    transition(&app, &state, LifecycleState::Ready, "Ready.");
                    navigate_to_host(&app, &origin);
                }
                SidecarMessage::StartupFailed { error } => { fail_attempt(&app, &state, generation, format!("{}: {}", error.name, error.message)); return; }
                SidecarMessage::StopFailed { error } => { fail_attempt(&app, &state, generation, format!("{}: {}", error.name, error.message)); return; }
                SidecarMessage::Stopped => { if ready_origin.is_none() { fail_attempt(&app, &state, generation, "Host stopped before becoming ready"); } return; }
            }
        }
        if started.elapsed() >= PROLONGED_STARTUP_AFTER && ready_origin.is_none() && state.snapshot.lock().ok().is_some_and(|snapshot| snapshot.state == LifecycleState::WaitingForClient) { transition(&app, &state, LifecycleState::ProlongedStartup, "Startup is taking longer than expected. You can retry when ready."); }
        if let Some(status) = process.child.lock().ok().and_then(|mut child| child.try_wait().ok()).flatten() { if is_current(&state, generation) { fail_attempt(&app, &state, generation, format!("Host exited unexpectedly ({status})")); } return; }
    }
}

/// 启动一个新的、唯一的 sidecar 启动轮次。
fn start_attempt(app: &AppHandle, state: &Arc<RuntimeState>) {
    let generation = state.generation.fetch_add(1, Ordering::AcqRel) + 1;
    if let Ok(mut origin) = state.host_origin.lock() { *origin = None; }
    transition(app, state, LifecycleState::Starting, "Starting.");
    let app = app.clone(); let state = Arc::clone(state);
    thread::spawn(move || run_attempt(app, state, generation));
}

/// 请求一次串行重试；旧进程回收完成前绝不启动新 Host。
fn request_retry(app: &AppHandle, state: &Arc<RuntimeState>) {
    if state.shutting_down.load(Ordering::Acquire) || state.retrying.swap(true, Ordering::AcqRel) { return }
    state.generation.fetch_add(1, Ordering::AcqRel);
    transition(app, state, LifecycleState::Stopping, "Stopping the previous Host before retry.");
    let process = state.process.lock().ok().and_then(|mut current| current.take());
    let app = app.clone(); let state = Arc::clone(state);
    thread::spawn(move || { if let Some(process) = process { stop_sidecar(&process); } state.retrying.store(false, Ordering::Release); if !state.shutting_down.load(Ordering::Acquire) { start_attempt(&app, &state); } });
}

/// 请求应用退出，并保证 sidecar 进程树被回收。
fn request_shutdown(app: &AppHandle, state: &Arc<RuntimeState>) {
    if state.shutting_down.swap(true, Ordering::AcqRel) { return }
    state.generation.fetch_add(1, Ordering::AcqRel);
    transition(app, state, LifecycleState::Stopping, "Stopping local Host.");
    let process = state.process.lock().ok().and_then(|mut current| current.take());
    let app = app.clone();
    thread::spawn(move || { if let Some(process) = process { stop_sidecar(&process); } let _ = app.exit(0); });
}

/// 返回当前启动页状态。
#[tauri::command]
fn startup_snapshot(state: State<'_, Arc<RuntimeState>>) -> LifecycleSnapshot { state.snapshot.lock().map(|snapshot| snapshot.clone()).unwrap_or(LifecycleSnapshot { state: LifecycleState::Starting, message: "Starting.".into(), origin: None }) }

/// 处理启动页的 Retry 命令。
#[tauri::command]
fn startup_retry(app: AppHandle, state: State<'_, Arc<RuntimeState>>) -> Result<(), String> { request_retry(&app, state.inner()); Ok(()) }

/// 复制经过脱敏的当前启动诊断信息。
#[tauri::command]
fn startup_copy_diagnostics(app: AppHandle, state: State<'_, Arc<RuntimeState>>) -> Result<(), String> {
    let snapshot = state.snapshot.lock().map(|value| value.clone()).unwrap_or(LifecycleSnapshot { state: LifecycleState::Starting, message: "Starting.".into(), origin: None });
    let last_error = state.last_error.lock().ok().and_then(|error| error.clone()).unwrap_or_else(|| "none".into());
    app.clipboard().write_text(format!("DeepSeek Harness Desktop\nstate: {:?}\nmessage: {}\nerror: {}", snapshot.state, snapshot.message, last_error)).map_err(|error| error.to_string())
}

/// 在系统文件管理器中打开日志目录。
#[tauri::command]
fn startup_reveal_logs(app: AppHandle, state: State<'_, Arc<RuntimeState>>) -> Result<(), String> { fs::create_dir_all(&state.logs_dir).map_err(|error| error.to_string())?; app.opener().open_path(state.logs_dir.to_string_lossy().to_string(), None::<String>).map_err(|error| error.to_string()) }

/// 创建 startup window，注册 Tauri IPC，并启动 sidecar 生命周期监督线程。
fn setup(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let logs_dir = app.path().app_data_dir()?.join("logs");
    let state = Arc::new(RuntimeState { snapshot: Mutex::new(LifecycleSnapshot { state: LifecycleState::Starting, message: "Starting.".into(), origin: None }), process: Mutex::new(None), host_origin: Mutex::new(None), startup_url: Mutex::new(None), generation: AtomicU64::new(0), retrying: AtomicBool::new(false), shutting_down: AtomicBool::new(false), logs_dir, last_error: Mutex::new(None) });
    app.manage(Arc::clone(&state));
    let app_handle = app.handle().clone();
    let startup_window = WebviewWindowBuilder::new(app.handle(), "main", WebviewUrl::App("index.html".into())).title("DeepSeek Harness Desktop").inner_size(1200.0, 800.0).visible(true).center()
        .on_navigation({ let app = app.handle().clone(); let state = Arc::clone(&state); move |url| { let startup_url = state.startup_url.lock().ok().and_then(|value| value.clone()).unwrap_or_default(); let host_origin = state.host_origin.lock().ok().and_then(|value| value.clone()); match decide_navigation(url.as_str(), &startup_url, host_origin.as_deref()) { NavigationDecision::Allow => true, NavigationDecision::External => { let _ = app.opener().open_url(url.to_string(), None::<String>); false }, NavigationDecision::Deny => false } } })
        .on_new_window({ let app = app.handle().clone(); move |url, _features| { if url.scheme() == "http" || url.scheme() == "https" { let _ = app.opener().open_url(url.to_string(), None::<String>); } tauri::webview::NewWindowResponse::Deny } }).build()?;
    if let Ok(url) = startup_window.url() { if let Ok(mut startup_url) = state.startup_url.lock() { *startup_url = Some(url.to_string()); } }
    let state_for_close = Arc::clone(&state);
    startup_window.on_window_event(move |event| { if let WindowEvent::CloseRequested { api, .. } = event { api.prevent_close(); request_shutdown(&app_handle, &state_for_close); } });
    start_attempt(&app.handle(), &state);
    Ok(())
}

/// 启动 Tauri 应用并安装单实例、外链和剪贴板插件。
fn main() {
    tauri::Builder::default().plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| { if let Some(window) = app.get_webview_window("main") { let _ = window.unminimize(); let _ = window.show(); let _ = window.set_focus(); } })).plugin(tauri_plugin_opener::Builder::new().open_js_links_on_click(false).build()).plugin(tauri_plugin_clipboard_manager::init()).invoke_handler(tauri::generate_handler![startup_snapshot, startup_retry, startup_copy_diagnostics, startup_reveal_logs]).setup(setup).run(tauri::generate_context!()).expect("error while running Tauri application");
}

#[cfg(test)]
mod tests {
    use super::{decide_navigation, is_allowed_host_origin, parse_sidecar_message, LifecycleState, NavigationDecision, SidecarMessage};
    /// 验证生命周期 ready 消息可解析。
    #[test] fn parses_ready_message() { let message = parse_sidecar_message(r#"{"type":"ready","origin":"http://127.0.0.1:1234/"}"#).unwrap(); assert!(matches!(message, SidecarMessage::Ready { origin } if origin == "http://127.0.0.1:1234/")); }
    /// 验证生命周期保留可恢复状态。
    #[test] fn lifecycle_has_recoverable_states() { assert_ne!(LifecycleState::Failed, LifecycleState::Ready); assert_ne!(LifecycleState::Stopping, LifecycleState::Starting); }
    /// 验证只接受带端口的 127.0.0.1 HTTP origin。
    #[test] fn validates_host_origin() { assert!(is_allowed_host_origin("http://127.0.0.1:1234/")); assert!(!is_allowed_host_origin("http://localhost:1234/")); assert!(!is_allowed_host_origin("https://127.0.0.1:1234/")); }
    /// 验证启动页、当前 Host 和外链导航边界。
    #[test] fn applies_navigation_policy() { let startup = "http://tauri.localhost/index.html"; let host = Some("http://127.0.0.1:1234"); assert_eq!(decide_navigation(startup, startup, host), NavigationDecision::Allow); assert_eq!(decide_navigation("http://127.0.0.1:1234/", startup, host), NavigationDecision::Allow); assert_eq!(decide_navigation("https://example.com", startup, host), NavigationDecision::External); assert_eq!(decide_navigation("file:///tmp/private", startup, host), NavigationDecision::Deny); }
}
