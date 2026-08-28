use super::{
    build_startup_diagnostics, bundled_node_relative_path, decide_navigation,
    exit_requires_failure, inspect_http_client_response, is_current_host_page_event,
    is_finished_page_load, is_packaged_startup_url, is_packaged_update_url,
    navigation_event_matches, parse_loopback_address, probe_client_page_with_timeout,
    retry_allowed, DiagnosticCode, ExitReason, HttpResponseState, LifecycleSnapshot,
    LifecycleState, NavigationDecision, PageLoadEvent, ProcessObservation, RuntimeState,
    HTTP_BODY_CAP,
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
            b"HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nTransfer-Encoding: chunked\r\n\r\nd;node=\"yes;ok\"\r\n<html></html>\r\n0\r\nX-Node: yes\r\n\r\n",
            true,
        ),
        HttpResponseState::Ready
    );
    for invalid in [
        b"HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nTransfer-Encoding: chunked\r\n\r\nz\r\n<html>\r\n0\r\n\r\n".as_slice(),
        b"HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nTransfer-Encoding: chunked\r\n\r\n6\r\n<html>\r\n0\r\n".as_slice(),
        b"HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: 6\r\nTransfer-Encoding: chunked\r\n\r\n6\r\n<html>\r\n0\r\n\r\n".as_slice(),
        b"HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nTransfer-Encoding: gzip, chunked\r\n\r\n6\r\n<html>\r\n0\r\n\r\n".as_slice(),
        b"HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nTransfer-Encoding: chunked, gzip\r\n\r\n6\r\n<html>\r\n0\r\n\r\n".as_slice(),
        b"HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nTransfer-Encoding: chunked\r\nTransfer-Encoding: chunked\r\n\r\n6\r\n<html>\r\n0\r\n\r\n".as_slice(),
    ] {
        assert_eq!(
            inspect_http_client_response(invalid, true),
            HttpResponseState::Reject
        );
    }
    let mut oversized = b"HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nTransfer-Encoding: chunked\r\n\r\n10001\r\n".to_vec();
    oversized.extend(std::iter::repeat_n(b'x', HTTP_BODY_CAP + 1));
    oversized.extend_from_slice(b"\r\n0\r\n\r\n");
    assert_eq!(
        inspect_http_client_response(&oversized, true),
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
        stream
            .write_all(
                b"HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nTransfer-Encoding: chunked\r\n\r\n",
            )
            .unwrap();
        for byte in b"6\r\n<html>\r\n0\r\n\r\n" {
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
        decide_navigation("http://127.0.0.1:1430/", "", host),
        NavigationDecision::Allow
    );
    assert_eq!(
        decide_navigation("http://127.0.0.1:1430/private", "", host),
        NavigationDecision::Deny
    );
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
    let diagnostics_value: serde_json::Value = serde_json::from_str(&diagnostics).unwrap();
    assert_eq!(diagnostics_value["lifecycle_state"], "failed");
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

/// 兼容已有纯值测试，把输入视为已经 EOF 的完整响应。
fn is_html_client_response(response: &[u8]) -> bool {
    inspect_http_client_response(response, true) == HttpResponseState::Ready
}

/// 只有精确的打包 update.html 可以提交重启确认。
#[test]
fn update_confirmation_requires_packaged_update_page() {
    assert!(is_packaged_update_url(
        &tauri::Url::parse("tauri://localhost/update.html").unwrap()
    ));
    assert!(is_packaged_update_url(
        &tauri::Url::parse("http://tauri.localhost/update.html").unwrap()
    ));
    assert!(!is_packaged_update_url(
        &tauri::Url::parse("http://127.0.0.1:3080/update.html").unwrap()
    ));
    assert!(!is_packaged_update_url(
        &tauri::Url::parse("tauri://localhost/update.html?url=https://evil.example").unwrap()
    ));
}
