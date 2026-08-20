#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::Deserialize;
use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent};

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
#[derive(Debug, Deserialize, Clone)]
struct SidecarError {
    name: String,
    message: String,
}

/// 由 Tauri 持有的 Node sidecar 进程句柄。
struct SidecarProcess {
    child: Child,
    stdin: ChildStdin,
    last_message: Arc<Mutex<Option<SidecarMessage>>>,
}

/// 解析官方 Node sidecar 的生命周期输出。
fn parse_sidecar_message(line: &str) -> Result<SidecarMessage, String> {
    serde_json::from_str(line).map_err(|error| format!("invalid sidecar message: {error}"))
}

/// 等待 Harness 的 loopback Web server 真实开始监听，避免 WebView 在端口就绪前缓存连接失败页。
fn wait_for_web_listener(origin: &str) -> Result<(), String> {
    let address = origin
        .strip_prefix("http://")
        .ok_or_else(|| format!("unexpected Harness origin: {origin}"))?
        .parse::<SocketAddr>()
        .map_err(|error| format!("invalid Harness origin: {error}"))?;
    let deadline = Instant::now() + Duration::from_secs(120);
    loop {
        if TcpStream::connect_timeout(&address, Duration::from_millis(500)).is_ok() {
            return Ok(());
        }
        if Instant::now() >= deadline {
            return Err(format!("Harness Web server did not listen at {origin} within 120 seconds"));
        }
        thread::sleep(Duration::from_millis(100));
    }
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

/// 解析开发态或打包态的官方 Node 可执行文件路径。
fn resolve_node_path(resource_dir: &Path) -> Result<PathBuf, String> {
    if let Some(path) = std::env::var_os("DSH_NODE_PATH").filter(|value| !value.is_empty()) {
        return Ok(PathBuf::from(path));
    }
    if cfg!(debug_assertions) {
        return Ok(PathBuf::from(if cfg!(windows) { "node.exe" } else { "node" }));
    }
    let filename = if cfg!(windows) { "node.exe" } else { "node" };
    let path = resource_dir.join("node").join(platform_arch()).join(filename);
    if path.is_file() {
        Ok(path)
    } else {
        Err(format!("official Node sidecar is missing: {}", path.display()))
    }
}

/// 启动官方 Node sidecar，并等待 Harness 报告 ready。
fn start_sidecar(app: &AppHandle) -> Result<(SidecarProcess, String), String> {
    let resource_dir = app.path().resource_dir().map_err(|error| error.to_string())?;
    let node_path = resolve_node_path(&resource_dir)?;
    let script = if cfg!(debug_assertions) {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../dist/sidecar/index.js")
    } else {
        resource_dir.join("dist/sidecar/index.js")
    };
    if !script.is_file() {
        return Err(format!("sidecar bootstrap is missing: {}", script.display()));
    }
    let harness_home = app.path().app_data_dir().map_err(|error| error.to_string())?;
    fs::create_dir_all(&harness_home).map_err(|error| error.to_string())?;
    let mut command = Command::new(node_path);
    command
        .arg(script)
        .current_dir(&harness_home)
        .env("DSH_HOME", &harness_home)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit());
    let mut child = command.spawn().map_err(|error| format!("failed to spawn Node sidecar: {error}"))?;
    let stdin = child.stdin.take().ok_or_else(|| "Node sidecar stdin unavailable".to_string())?;
    let stdout = child.stdout.take().ok_or_else(|| "Node sidecar stdout unavailable".to_string())?;
    let mut reader = BufReader::new(stdout);
    let mut line = String::new();
    let message = loop {
        line.clear();
        let bytes = reader.read_line(&mut line).map_err(|error| format!("failed to read sidecar ready message: {error}"))?;
        if bytes == 0 {
            return Err("Node sidecar exited before reporting readiness".into());
        }
        if let Ok(message) = parse_sidecar_message(line.trim()) {
            break message;
        }
    };
    let origin = match message.clone() {
        SidecarMessage::Ready { origin } => origin,
        SidecarMessage::StartupFailed { error } => return Err(format!("{}: {}", error.name, error.message)),
        other => return Err(format!("unexpected sidecar startup message: {other:?}")),
    };
    let last_message = Arc::new(Mutex::new(Some(message)));
    let messages = Arc::clone(&last_message);
    thread::spawn(move || {
        for line in reader.lines().flatten() {
            if let Ok(message) = parse_sidecar_message(&line) {
                if let SidecarMessage::StopFailed { ref error } = message {
                    eprintln!("Node sidecar stop failed: {}: {}", error.name, error.message);
                }
                if let Ok(mut latest) = messages.lock() {
                    *latest = Some(message);
                }
            }
        }
    });
    Ok((SidecarProcess { child, stdin, last_message }, origin))
}

/// 优雅停止 sidecar，超时后终止进程树。
fn stop_sidecar(mut process: SidecarProcess) {
    let _ = writeln!(process.stdin, "{{\"type\":\"stop\"}}");
    let deadline = Instant::now() + Duration::from_secs(8);
    loop {
        match process.child.try_wait() {
            Ok(Some(_)) => {
                let _ = process.last_message.lock().ok();
                return;
            }
            Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(100)),
            _ => break,
        }
    }
    #[cfg(windows)]
    {
        let _ = Command::new("taskkill")
            .args(["/PID", &process.child.id().to_string(), "/T", "/F"])
            .status();
    }
    #[cfg(not(windows))]
    {
        let _ = process.child.kill();
    }
}

/// 创建窗口、启动 sidecar 并在关闭时回收进程。
fn setup(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let process = Arc::new(Mutex::new(None));
    app.manage(Arc::clone(&process));
    let app_handle = app.handle().clone();
    let window = WebviewWindowBuilder::new(app.handle(), "main", WebviewUrl::App("index.html".into()))
        .title("DeepSeek Harness Desktop")
        .inner_size(1200.0, 800.0)
        .visible(true)
        .center()
        .build()?;
    let process_for_start = Arc::clone(&process);
    let window_for_start = window.clone();
    let app_for_start = app.handle().clone();
    thread::spawn(move || {
        match start_sidecar(&app_for_start) {
            Ok((sidecar, origin)) => {
                let _ = window_for_start.set_title("DeepSeek Harness Desktop — Host ready");
                if let Ok(mut guard) = process_for_start.lock() {
                    *guard = Some(sidecar);
                }
                if let Err(error) = wait_for_web_listener(&origin) {
                    let _ = window_for_start.set_title("DeepSeek Harness Desktop — Host web server failed");
                    eprintln!("failed to wait for Harness Web server: {error}");
                    return;
                }
                let _ = window_for_start.set_title(&format!("DeepSeek Harness Desktop — {origin}"));
                let app_for_navigation = app_for_start.clone();
                let window_for_navigation = window_for_start.clone();
                if let Err(error) = app_for_navigation.run_on_main_thread(move || {
                    match origin.parse() {
                        Ok(url) => {
                            if let Err(error) = window_for_navigation.navigate(url) {
                                let _ = window_for_navigation.set_title("DeepSeek Harness Desktop — Host navigation failed");
                                eprintln!("failed to navigate Harness Web UI: {error}");
                            }
                        }
                        Err(error) => {
                            let _ = window_for_navigation.set_title("DeepSeek Harness Desktop — Invalid host URL");
                            eprintln!("invalid Harness Web UI origin: {error}");
                        }
                    }
                }) {
                    let _ = window_for_start.set_title("DeepSeek Harness Desktop — Navigation scheduling failed");
                    eprintln!("failed to schedule Harness Web UI navigation: {error}");
                }
            }
            Err(error) => {
                let _ = window_for_start.set_title("DeepSeek Harness Desktop — Host startup failed");
                eprintln!("failed to start Node sidecar: {error}");
            }
        }
    });
    let process_for_close = Arc::clone(&process);
    window.on_window_event(move |event| {
        if let WindowEvent::CloseRequested { api, .. } = event {
            api.prevent_close();
            if let Some(process) = process_for_close.lock().ok().and_then(|mut guard| guard.take()) {
                let app_handle = app_handle.clone();
                thread::spawn(move || {
                    stop_sidecar(process);
                    let _ = app_handle.exit(0);
                });
            } else {
                let _ = app_handle.exit(0);
            }
        }
    });
    Ok(())
}

/// 启动 Tauri 应用。
fn main() {
    tauri::Builder::default().setup(setup).run(tauri::generate_context!()).expect("error while running Tauri application");
}

#[cfg(test)]
mod tests {
    use super::{parse_sidecar_message, platform_arch, SidecarMessage};

    /// 验证生命周期 ready 消息可解析。
    #[test]
    fn parses_ready_message() {
        let message = parse_sidecar_message(r#"{"type":"ready","origin":"http://127.0.0.1:1234"}"#).unwrap();
        assert!(matches!(message, SidecarMessage::Ready { origin } if origin == "http://127.0.0.1:1234"));
    }

    /// 验证 sidecar 的 kebab-case 启动失败消息可解析。
    #[test]
    fn parses_startup_failed_message() {
        let message = parse_sidecar_message(r#"{"type":"startup-failed","error":{"name":"Error","message":"boom"}}"#).unwrap();
        assert!(matches!(message, SidecarMessage::StartupFailed { error } if error.message == "boom"));
    }

    /// 验证平台架构目录名非空。
    #[test]
    fn platform_directory_is_known() {
        assert_ne!(platform_arch(), "unsupported");
    }
}
