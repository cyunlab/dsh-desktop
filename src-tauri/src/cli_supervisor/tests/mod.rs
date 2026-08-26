#[cfg(any(unix, windows))]
use super::spawn_owned_command_with_graceful_action;
#[cfg(windows)]
use super::{
    assign_then_resume, merge_windows_environment, open_inheritable_null, quote_windows_argument,
    unique_handle_allowlist, windows_launch_contract, CREATE_NEW_CONSOLE_FLAG,
    CREATE_SUSPENDED_FLAG, SW_HIDE_VALUE,
};
use super::{
    classify_exit, classify_exit_with_code, preflight_address, prepend_node_path,
    resolve_dsh_cli_entry, spawn_owned_command, CliCommandPlan, ExitReason, SupervisorError,
    HOST_ADDRESS,
};
use crate::lifecycle::StopOutcome;
use std::ffi::{OsStr, OsString};
use std::fs;
use std::io;
use std::net::{Ipv4Addr, TcpListener};
#[cfg(windows)]
use std::os::windows::ffi::OsStringExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
#[cfg(unix)]
use std::sync::atomic::AtomicBool;
#[cfg(unix)]
use std::sync::atomic::Ordering;
use std::thread;
use std::time::Duration;
#[cfg(unix)]
use std::time::Instant;
use std::time::{SystemTime, UNIX_EPOCH};
#[cfg(windows)]
use windows_sys::Win32::Foundation::{
    CloseHandle, GetHandleInformation, GENERIC_READ, HANDLE, WAIT_OBJECT_0,
};
#[cfg(windows)]
use windows_sys::Win32::System::Threading::{
    OpenProcess, WaitForSingleObject, PROCESS_QUERY_LIMITED_INFORMATION,
};

#[cfg(unix)]
static HELPER_SHUTDOWN_REQUESTED: AtomicBool = AtomicBool::new(false);

#[cfg(windows)]
const CREATE_NEW_PROCESS_GROUP_FLAG: u32 = 0x0000_0200;
#[cfg(windows)]
const CREATE_NO_WINDOW_FLAG: u32 = 0x0800_0000;

/// POSIX helper 的信号处理器只设置原子标志，实际清理留在普通控制流。
#[cfg(unix)]
extern "C" fn request_helper_shutdown(_signal: i32) {
    HELPER_SHUTDOWN_REQUESTED.store(true, Ordering::Release);
}

/// 注入一个确定失败的平台优雅动作，验证真实监督器 fallback。
#[cfg(any(unix, windows))]
fn fail_graceful_action(_pid: u32) -> Result<(), String> {
    Err("injected graceful action failure".into())
}

/// 创建不会与并行测试冲突的临时目录。
fn temporary_directory(label: &str) -> PathBuf {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let directory = std::env::temp_dir().join(format!(
        "dsh-desktop-cli-supervisor-{label}-{}-{nonce}",
        std::process::id()
    ));
    fs::create_dir_all(&directory).unwrap();
    directory
}

/// 写入最小的固定版本发布包和 CLI 入口。
fn write_cli_fixture(root: &Path, declared_entry: &str) -> PathBuf {
    let package = root.join("@deepseek-ai/dsh");
    fs::create_dir_all(package.join("lib")).unwrap();
    let entry = package.join("lib/bin.js");
    fs::write(&entry, "process.exit(0)\n").unwrap();
    fs::write(
        package.join("package.json"),
        format!(
            r#"{{"name":"@deepseek-ai/dsh","version":"0.1.0-rc.6","bin":{{"dsh":"{declared_entry}"}}}}"#
        ),
    )
    .unwrap();
    entry
}

/// 验证入口只由固定版本发布包的 `bin.dsh` 决定。
#[test]
fn resolves_manifest_declared_cli_entry() {
    let root = temporary_directory("manifest");
    let expected = write_cli_fixture(&root, "lib/bin.js");
    assert_eq!(
        resolve_dsh_cli_entry(&root).unwrap(),
        expected.canonicalize().unwrap()
    );
    fs::remove_dir_all(root).unwrap();
}

/// 验证越出发布包目录的入口会被拒绝。
#[test]
fn rejects_cli_entry_outside_published_package() {
    let root = temporary_directory("escape");
    write_cli_fixture(&root, "../../outside.js");
    fs::write(root.join("outside.js"), "process.exit(0)\n").unwrap();
    assert!(resolve_dsh_cli_entry(&root).is_err());
    fs::remove_dir_all(root).unwrap();
}

/// 验证命令使用官方 Node、发布入口、固定参数、隔离 Home 和独立 cwd。
#[test]
fn constructs_exact_dsh_web_command() {
    let plan = CliCommandPlan {
        node_executable: PathBuf::from("/desktop/node/bin/node"),
        cli_entry: PathBuf::from("/desktop/runtime/@deepseek-ai/dsh/lib/bin.js"),
        harness_home: PathBuf::from("/desktop/data/harness-home"),
        working_directory: PathBuf::from("/desktop/data/working-directory"),
        path: std::env::join_paths([
            PathBuf::from("/desktop/node/bin"),
            PathBuf::from("/usr/bin"),
        ])
        .unwrap(),
    };
    let command = plan.command();
    assert_eq!(command.get_program(), OsStr::new("/desktop/node/bin/node"));
    assert_eq!(
        command.get_args().collect::<Vec<_>>(),
        [
            OsStr::new("/desktop/runtime/@deepseek-ai/dsh/lib/bin.js"),
            OsStr::new("web"),
            OsStr::new("--host"),
            OsStr::new(HOST_ADDRESS),
            OsStr::new("--port"),
            OsStr::new("3080"),
        ]
    );
    assert_eq!(
        command.get_current_dir(),
        Some(Path::new("/desktop/data/working-directory"))
    );
    let environment = command.get_envs().collect::<Vec<_>>();
    assert!(environment
        .iter()
        .any(|(name, value)| *name == OsStr::new("DSH_HOME")
            && *value == Some(OsStr::new("/desktop/data/harness-home"))));
    assert!(environment
        .iter()
        .any(|(name, value)| *name == OsStr::new("PATH") && *value == Some(plan.path.as_os_str())));
    assert!(!command
        .get_args()
        .any(|value| value == OsStr::new("--patch")));
}

/// 验证打包 Node 目录始终位于继承 PATH 首位。
#[test]
fn prepends_packaged_node_directory() {
    let inherited =
        std::env::join_paths([PathBuf::from("/system/bin"), PathBuf::from("/tools")]).unwrap();
    let path = prepend_node_path(Path::new("/desktop/node/bin/node"), Some(inherited)).unwrap();
    assert_eq!(
        std::env::split_paths(&path).collect::<Vec<_>>(),
        [
            PathBuf::from("/desktop/node/bin"),
            PathBuf::from("/system/bin"),
            PathBuf::from("/tools")
        ]
    );
}

/// 验证 requested、stale 和 unexpected 三种退出不会互相混淆。
#[test]
fn classifies_exit_against_owned_generation() {
    assert_eq!(classify_exit(7, 7, Some(7)), ExitReason::Requested);
    assert_eq!(classify_exit(7, 8, Some(7)), ExitReason::Requested);
    assert_eq!(classify_exit(7, 8, None), ExitReason::StaleGeneration);
    assert_eq!(classify_exit(7, 7, None), ExitReason::Unexpected);
    assert_eq!(classify_exit(7, 8, Some(8)), ExitReason::StaleGeneration);
}

/// 验证 Windows CLI 必须在隐藏的专属 console 中以挂起态创建。
#[cfg(windows)]
#[test]
fn windows_launch_contract_uses_hidden_dedicated_console() {
    let contract = windows_launch_contract();
    assert_ne!(contract.creation_flags & CREATE_NEW_CONSOLE_FLAG, 0);
    assert_ne!(contract.creation_flags & CREATE_SUSPENDED_FLAG, 0);
    assert_eq!(contract.creation_flags & CREATE_NEW_PROCESS_GROUP_FLAG, 0);
    assert_eq!(contract.creation_flags & CREATE_NO_WINDOW_FLAG, 0);
    assert_eq!(contract.show_window, SW_HIDE_VALUE);
}

/// 验证生产消费的接管 seam 始终先 Assign Job，再 Resume 初始线程。
#[cfg(windows)]
#[test]
fn windows_takeover_sequence_assigns_before_resume() {
    let calls = std::cell::RefCell::new(Vec::new());
    let mut child = ();
    let ownership = assign_then_resume(
        &mut child,
        |_| {
            calls.borrow_mut().push("assign");
            Ok::<_, ()>("job")
        },
        |_| {
            calls.borrow_mut().push("resume");
            Ok::<_, ()>(())
        },
    )
    .unwrap();
    assert_eq!(ownership, "job");
    assert_eq!(calls.into_inner(), ["assign", "resume"]);
}

/// 验证 Windows 继承 allowlist 会过滤无效句柄并保持唯一。
#[cfg(windows)]
#[test]
fn windows_handle_allowlist_contains_only_unique_valid_handles() {
    assert_eq!(unique_handle_allowlist([0, 41, -1, 42, 41]), [41, 42]);
}

/// 验证 CreateProcessW 命令行对空白、引号、Unicode 和结尾反斜杠正确转义。
#[cfg(windows)]
#[test]
fn quotes_windows_arguments_without_changing_argv_values() {
    let quote = |value: &str| {
        String::from_utf16(&quote_windows_argument(
            &value.encode_utf16().collect::<Vec<_>>(),
        ))
        .unwrap()
    };
    assert_eq!(quote("hello"), "hello");
    assert_eq!(quote(""), r#""""#);
    assert_eq!(quote("two words"), r#""two words""#);
    assert_eq!(quote("深度 搜索"), r#""深度 搜索""#);
    assert_eq!(quote(r#"a\"b"#), r#""a\\\"b""#);
    assert_eq!(quote(r#"C:\Program Files\"#), r#""C:\Program Files\\""#);
}

/// 验证 Windows 环境继承与覆盖会忽略变量名大小写、删除项并稳定排序。
#[cfg(windows)]
#[test]
fn merges_windows_environment_without_case_duplicates() {
    let unpaired_upper = OsString::from_wide(&[0xd800, b'X' as u16]);
    let unpaired_lower = OsString::from_wide(&[0xd800, b'x' as u16]);
    let environment = merge_windows_environment(
        [
            (OsString::from("Path"), OsString::from("old")),
            (OsString::from("ÄVAR"), OsString::from("old-nonascii")),
            (unpaired_upper, OsString::from("old-unpaired")),
        ],
        [
            (OsString::from("PATH"), Some(OsString::from("owned"))),
            (OsString::from("Path"), None),
            (OsString::from("ävar"), Some(OsString::from("new-nonascii"))),
            (unpaired_lower, Some(OsString::from("new-unpaired"))),
            (OsString::from("DSH_HOME"), Some(OsString::from("home"))),
        ],
    );
    assert_eq!(environment.len(), 4);
    assert!(environment
        .iter()
        .any(|(name, value)| name == "PATH" && value == "owned"));
    assert!(environment
        .iter()
        .any(|(name, value)| name == "ävar" && value == "new-nonascii"));
    assert!(environment.iter().any(|(name, value)| name
        == &OsString::from_wide(&[0xd800, b'x' as u16])
        && value == "new-unpaired"));
    assert!(environment
        .iter()
        .any(|(name, value)| name == "DSH_HOME" && value == "home"));
}

/// 验证 code 130 只有在同一 owned generation 已登记停止请求时才是 requested。
#[test]
fn code_130_requires_an_owned_generation_request() {
    let exit_code = Some(130);
    assert_eq!(
        classify_exit_with_code(7, 7, Some(7), exit_code),
        ExitReason::Requested
    );
    assert_eq!(
        classify_exit_with_code(7, 7, None, exit_code),
        ExitReason::Unexpected
    );
    assert_eq!(
        classify_exit_with_code(7, 8, Some(8), exit_code),
        ExitReason::Unexpected
    );
}

/// 验证 PATH 缺失时仍能提供仅包含官方 Node 的有效值。
#[test]
fn constructs_path_without_parent_value() {
    let path = prepend_node_path(Path::new("/desktop/node/bin/node"), None::<OsString>).unwrap();
    assert_eq!(
        std::env::split_paths(&path).collect::<Vec<_>>(),
        [PathBuf::from("/desktop/node/bin")]
    );
}

/// 验证预检会稳定报告一个已经被当前进程占用的地址。
#[test]
fn detects_port_conflict_before_spawn() {
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
    let address = match listener.local_addr().unwrap() {
        std::net::SocketAddr::V4(address) => address,
        std::net::SocketAddr::V6(_) => unreachable!(),
    };
    assert!(preflight_address(address).is_err());
}

/// 验证注入的地址占用错误只映射为稳定端口冲突。
#[test]
fn maps_only_injected_address_in_use_to_port_conflict() {
    let command = Command::new("/definitely/missing/dsh-desktop-node");
    assert!(matches!(
        spawn_owned_command(command, 8, || Err(io::Error::from(
            io::ErrorKind::AddrInUse
        ))),
        Err(SupervisorError::PortConflict)
    ));
}

/// 验证注入的非冲突预检错误不会伪装成端口占用。
#[test]
fn maps_other_injected_bind_errors_to_preflight_failure() {
    let command = Command::new("/definitely/missing/dsh-desktop-node");
    assert!(matches!(
        spawn_owned_command(command, 8, || Err(io::Error::from(
            io::ErrorKind::PermissionDenied
        ))),
        Err(SupervisorError::PreflightFailed)
    ));
}

/// 验证 executable 不存在时返回稳定 spawn failure，而非伪造进程状态。
#[test]
fn reports_spawn_failure() {
    let command = Command::new("/definitely/missing/dsh-desktop-node");
    assert!(matches!(
        spawn_owned_command(command, 9, || Ok(())),
        Err(SupervisorError::SpawnFailed)
    ));
}

/// 等待监督进程产生真实退出状态。
#[cfg(unix)]
fn wait_for_exit(process: &super::CliProcess, generation: u64) -> super::ProcessExit {
    for _ in 0..200 {
        if let Some(exit) = process.try_exit(generation).unwrap() {
            return exit;
        }
        thread::sleep(Duration::from_millis(10));
    }
    panic!("CLI process did not exit");
}

/// 只轮询并缓存真实 Child 状态，不提前冻结退出原因。
#[cfg(unix)]
fn wait_for_unclassified_status(process: &super::CliProcess) {
    for _ in 0..2_000 {
        if process.observe_child_status().unwrap().is_some() {
            assert_eq!(process.requested_generation.load(Ordering::Acquire), 0);
            assert!(process.classified_reason.lock().unwrap().is_none());
            return;
        }
        thread::sleep(Duration::from_millis(1));
    }
    panic!("CLI child status was not observable");
}

/// 验证未被轮询的真实非零退出在随后 stop 时仍保持 unexpected。
#[cfg(unix)]
#[test]
fn stop_observes_prior_unexpected_exit_before_marking_requested() {
    let mut command = Command::new("/bin/sh");
    command
        .args(["-c", "exit 17"])
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    let process = spawn_owned_command(command, 11, || Ok(())).unwrap();
    wait_for_unclassified_status(&process);
    let report = process
        .stop(11, Duration::from_secs(1), Duration::from_secs(1))
        .unwrap();
    let exit = report.exit.unwrap();
    assert_eq!(exit.status.code(), Some(17));
    assert_eq!(exit.reason, ExitReason::Unexpected);
    assert_eq!(wait_for_exit(&process, 12).reason, ExitReason::Unexpected);
}

/// 验证 generation 推进后 stop 仍存活的旧进程仍属于 owned requested。
#[cfg(unix)]
#[test]
fn stop_requests_active_process_after_generation_advances() {
    let mut command = Command::new("/bin/sh");
    command
        .args(["-c", "exec sleep 60"])
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    let process = spawn_owned_command(command, 12, || Ok(())).unwrap();
    let report = process
        .stop(13, Duration::from_secs(2), Duration::from_secs(1))
        .unwrap();
    assert_eq!(report.exit.unwrap().reason, ExitReason::Requested);
}

/// 验证未收到 stop 的旧进程在替代 generation 中首次观察为 stale。
#[cfg(unix)]
#[test]
fn stop_observes_prior_exit_as_stale_after_generation_advances() {
    let mut command = Command::new("/bin/sh");
    command
        .args(["-c", "exit 23"])
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    let process = spawn_owned_command(command, 12, || Ok(())).unwrap();
    wait_for_unclassified_status(&process);
    let report = process
        .stop(13, Duration::from_secs(1), Duration::from_secs(1))
        .unwrap();
    let exit = report.exit.unwrap();
    assert_eq!(exit.status.code(), Some(23));
    assert_eq!(exit.reason, ExitReason::StaleGeneration);
}

/// 验证真实 CliProcess 在平台动作失败并强制回收后仍分类为 requested。
#[cfg(unix)]
#[test]
fn injected_graceful_failure_forces_real_owned_process_as_requested() {
    let mut command = Command::new("/bin/sh");
    command
        .args(["-c", "exec sleep 60"])
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    let process =
        spawn_owned_command_with_graceful_action(command, 19, || Ok(()), fail_graceful_action)
            .unwrap();
    let report = process
        .stop(20, Duration::ZERO, Duration::from_secs(2))
        .unwrap();
    assert_eq!(report.outcome, StopOutcome::Forced);
    assert_eq!(report.exit.unwrap().reason, ExitReason::Requested);
}

/// 子进程 helper 在 SIGTERM 后主动关闭 listener 和后代，模拟官方 CLI disposal。
#[cfg(unix)]
#[test]
#[ignore]
fn posix_listener_helper() {
    if std::env::var_os("DSH_CLI_SUPERVISOR_HELPER").is_none() {
        return;
    }
    HELPER_SHUTDOWN_REQUESTED.store(false, Ordering::Release);
    unsafe { libc::signal(libc::SIGTERM, request_helper_shutdown as *const () as usize) };
    let address = std::env::var("DSH_CLI_SUPERVISOR_ADDRESS").unwrap();
    let listener = TcpListener::bind(&address).unwrap();
    fs::write(
        std::env::var_os("DSH_CLI_SUPERVISOR_READY").unwrap(),
        b"ready",
    )
    .unwrap();
    let mut descendant = Command::new("/bin/sh")
        .args(["-c", "sleep 60"])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    while !HELPER_SHUTDOWN_REQUESTED.load(Ordering::Acquire) {
        thread::sleep(Duration::from_millis(10));
    }
    descendant.kill().unwrap();
    descendant.wait().unwrap();
    drop(listener);
}

/// 验证 POSIX 正常停止只给 leader SIGTERM，并等待其释放 listener 和进程树。
#[cfg(unix)]
#[test]
fn posix_sigterm_reclaims_listener_and_process_tree() {
    let probe = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
    let address = probe.local_addr().unwrap();
    drop(probe);
    let root = temporary_directory("posix-helper");
    let ready = root.join("ready");
    let mut command = Command::new(std::env::current_exe().unwrap());
    command
        .args([
            "--exact",
            "cli_supervisor::tests::posix_listener_helper",
            "--ignored",
        ])
        .env("DSH_CLI_SUPERVISOR_HELPER", "1")
        .env("DSH_CLI_SUPERVISOR_ADDRESS", address.to_string())
        .env("DSH_CLI_SUPERVISOR_READY", &ready)
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    let process = spawn_owned_command(command, 21, || Ok(())).unwrap();
    for _ in 0..200 {
        if ready.is_file() {
            break;
        }
        thread::sleep(Duration::from_millis(10));
    }
    assert!(ready.is_file());
    let report = process
        .stop(21, Duration::from_secs(3), Duration::from_secs(2))
        .unwrap();
    assert_eq!(report.outcome, StopOutcome::Graceful);
    assert_eq!(report.exit.unwrap().reason, ExitReason::Requested);
    assert!(TcpListener::bind(address).is_ok());
    fs::remove_dir_all(root).unwrap();
}

/// 验证不响应 SIGTERM 的 CLI 会在宽限期后由进程组强制回收。
#[cfg(unix)]
#[test]
fn posix_forces_stubborn_process_group_cleanup() {
    let root = temporary_directory("posix-stubborn-helper");
    let ready = root.join("ready");
    let mut command = Command::new("/bin/sh");
    command
        .args([
            "-c",
            "trap '' TERM; sleep 60 & printf ready > \"$DSH_CLI_SUPERVISOR_READY\"; wait",
        ])
        .env("DSH_CLI_SUPERVISOR_READY", &ready)
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    let process = spawn_owned_command(command, 22, || Ok(())).unwrap();
    let deadline = Instant::now() + Duration::from_secs(2);
    while !ready.is_file() {
        assert!(
            Instant::now() < deadline,
            "stubborn helper did not install TERM trap and spawn descendant"
        );
        thread::yield_now();
    }
    let report = process
        .stop(22, Duration::ZERO, Duration::from_secs(2))
        .unwrap();
    assert_eq!(report.outcome, StopOutcome::Forced);
    assert_eq!(report.exit.unwrap().reason, ExitReason::Requested);
    fs::remove_dir_all(root).unwrap();
}

/// 持有 Windows 后代进程的独立等待句柄，避免 PID 复用影响清理断言。
#[cfg(windows)]
struct WindowsTestProcessHandle(HANDLE);

#[cfg(windows)]
impl WindowsTestProcessHandle {
    /// 在停止前打开后代句柄，供停止后明确等待该后代退出。
    fn open(pid_file: &Path) -> Self {
        for _ in 0..200 {
            let pid = fs::read_to_string(pid_file)
                .ok()
                .and_then(|value| value.trim().parse::<u32>().ok());
            if let Some(pid) = pid {
                let handle =
                    unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | 0x0010_0000, 0, pid) };
                if !handle.is_null() {
                    return Self(handle);
                }
            }
            thread::sleep(Duration::from_millis(10));
        }
        panic!("cannot open descendant process from {}", pid_file.display());
    }

    /// 断言监督停止后该后代进程句柄已进入 signalled 状态。
    fn assert_exited(&self) {
        assert_eq!(unsafe { WaitForSingleObject(self.0, 2_000) }, WAIT_OBJECT_0);
    }
}

#[cfg(windows)]
impl Drop for WindowsTestProcessHandle {
    /// 关闭测试持有的后代等待句柄。
    fn drop(&mut self) {
        unsafe { CloseHandle(self.0) };
    }
}

/// 子测试检查一个不在 allowlist 中的父进程可继承句柄是否泄漏。
#[cfg(windows)]
#[test]
#[ignore]
fn windows_inherited_handle_probe_helper() {
    let Some(raw_handle) = std::env::var_os("DSH_WINDOWS_SENTINEL_HANDLE") else {
        return;
    };
    let handle = raw_handle.to_string_lossy().parse::<isize>().unwrap() as HANDLE;
    let mut flags = 0;
    let inherited = unsafe { GetHandleInformation(handle, &mut flags) } != 0;
    fs::write(
        std::env::var_os("DSH_WINDOWS_SENTINEL_RESULT").unwrap(),
        if inherited {
            b"inherited".as_slice()
        } else {
            b"closed".as_slice()
        },
    )
    .unwrap();
}

/// 验证 STARTUPINFOEX allowlist 不会把额外 inheritable sentinel 泄漏给 child。
#[cfg(windows)]
#[test]
fn windows_child_does_not_inherit_unlisted_handle() {
    let root = temporary_directory("windows-handle-allowlist");
    let result = root.join("result");
    let sentinel = open_inheritable_null(GENERIC_READ).unwrap();
    let mut command = Command::new(std::env::current_exe().unwrap());
    command
        .args([
            "--exact",
            "cli_supervisor::tests::windows_inherited_handle_probe_helper",
            "--ignored",
        ])
        .env(
            "DSH_WINDOWS_SENTINEL_HANDLE",
            (sentinel as isize).to_string(),
        )
        .env("DSH_WINDOWS_SENTINEL_RESULT", &result);
    let process = spawn_owned_command(command, 30, || Ok(())).unwrap();
    for _ in 0..200 {
        if result.is_file() {
            break;
        }
        thread::sleep(Duration::from_millis(10));
    }
    assert_eq!(fs::read(&result).unwrap(), b"closed");
    for _ in 0..200 {
        if process.try_exit(30).unwrap().is_some() {
            break;
        }
        thread::sleep(Duration::from_millis(10));
    }
    assert!(process.try_exit(30).unwrap().is_some());
    unsafe { CloseHandle(sentinel) };
    fs::remove_dir_all(root).unwrap();
}

/// 定位当前 Windows 架构随包交付的官方 Node executable。
#[cfg(windows)]
fn packaged_windows_node() -> PathBuf {
    let resource = match std::env::consts::ARCH {
        "x86_64" => "windows-x86_64",
        "aarch64" => "windows-aarch64",
        architecture => panic!("unsupported Windows test architecture: {architecture}"),
    };
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join("resources/node")
        .join(resource)
        .join("node.exe")
}

/// 运行一轮官方 Node Ctrl+C 集成场景，并独立确认 leader listener 与后代句柄均退出。
#[cfg(windows)]
fn run_windows_ctrl_c_round(round: u64) {
    let node = packaged_windows_node();
    assert!(
        node.is_file(),
        "run pnpm ensure:official-node for the Windows target before this test"
    );
    let probe = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
    let address = probe.local_addr().unwrap();
    drop(probe);
    let root = temporary_directory(&format!("windows-ctrl-c-深度-{round}"));
    let script = root.join("sigint-helper.cjs");
    let ready = root.join("ready");
    fs::write(
        &script,
        r#"const fs = require('node:fs')
const net = require('node:net')
const { spawn } = require('node:child_process')
if (fs.realpathSync(process.cwd()) !== fs.realpathSync(process.env.DSH_WINDOWS_EXPECTED_CWD)) process.exit(42)
const descendant = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
const [host, port] = process.env.DSH_WINDOWS_CTRL_C_ADDRESS.split(':')
const server = net.createServer((socket) => socket.end('ok'))
let stopping = false
process.on('SIGINT', () => {
  if (stopping) return
  stopping = true
  descendant.kill()
  server.close(() => process.exit(130))
  setTimeout(() => process.exit(131), 5000).unref()
})
server.listen(Number(port), host, () => fs.writeFileSync(process.env.DSH_WINDOWS_CTRL_C_READY, String(descendant.pid)))
"#,
    )
    .unwrap();
    let mut command = Command::new(node);
    command
        .arg(&script)
        .env("DSH_WINDOWS_CTRL_C_ADDRESS", address.to_string())
        .env("DSH_WINDOWS_CTRL_C_READY", &ready)
        .env("DSH_WINDOWS_EXPECTED_CWD", &root)
        .current_dir(&root)
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    let process = spawn_owned_command(command, 31 + round, || Ok(())).unwrap();
    for _ in 0..400 {
        if ready.is_file() {
            break;
        }
        thread::sleep(Duration::from_millis(25));
    }
    assert!(ready.is_file(), "Node SIGINT helper did not become ready");
    let descendant = WindowsTestProcessHandle::open(&ready);
    let report = process
        .stop(31 + round, Duration::from_secs(8), Duration::from_secs(2))
        .unwrap();
    assert_eq!(report.outcome, StopOutcome::Graceful);
    let exit = report.exit.unwrap();
    assert_eq!(exit.status.code(), Some(130));
    assert_eq!(exit.reason, ExitReason::Requested);
    descendant.assert_exited();
    assert!(TcpListener::bind(address).is_ok());
    fs::remove_dir_all(root).unwrap();
}

/// 连续两轮验证 Desktop ignore 状态已撤销，下一代 Node 仍能收到真实 Ctrl+C。
#[cfg(windows)]
#[test]
fn windows_ctrl_c_reaches_node_across_consecutive_spawns() {
    run_windows_ctrl_c_round(0);
    run_windows_ctrl_c_round(1);
}

/// 验证 Windows console 发送失败会立即转入 Job Object 强制回收。
#[cfg(windows)]
#[test]
fn windows_console_failure_forces_job_tree_cleanup() {
    let node = packaged_windows_node();
    assert!(node.is_file());
    let probe = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
    let address = probe.local_addr().unwrap();
    drop(probe);
    let root = temporary_directory("windows-console-failure");
    let ready = root.join("descendant-ready");
    let script = root.join("failure-tree.cjs");
    fs::write(
        &script,
        r#"const { spawn } = require('node:child_process')
spawn(process.execPath, ['-e', `const fs=require('node:fs');const net=require('node:net');const [host,port]=process.env.DSH_WINDOWS_DESCENDANT_ADDRESS.split(':');net.createServer(()=>{}).listen(Number(port),host,()=>fs.writeFileSync(process.env.DSH_WINDOWS_DESCENDANT_READY,String(process.pid)));setInterval(()=>{},1000)`], { stdio: 'ignore', env: process.env })
setInterval(() => {}, 1000)
"#,
    )
    .unwrap();
    let mut command = Command::new(node);
    command
        .arg(script)
        .env("DSH_WINDOWS_DESCENDANT_ADDRESS", address.to_string())
        .env("DSH_WINDOWS_DESCENDANT_READY", &ready);
    let process =
        spawn_owned_command_with_graceful_action(command, 32, || Ok(()), fail_graceful_action)
            .unwrap();
    for _ in 0..400 {
        if ready.is_file() {
            break;
        }
        thread::sleep(Duration::from_millis(25));
    }
    assert!(ready.is_file(), "failure descendant did not become ready");
    let descendant = WindowsTestProcessHandle::open(&ready);
    let report = process
        .stop(32, Duration::from_secs(8), Duration::from_secs(2))
        .unwrap();
    assert_eq!(report.outcome, StopOutcome::Forced);
    assert_eq!(report.exit.unwrap().reason, ExitReason::Requested);
    descendant.assert_exited();
    assert!(TcpListener::bind(address).is_ok());
    fs::remove_dir_all(root).unwrap();
}

/// 验证 Windows CLI 忽略 Ctrl+C 时会在宽限期后由 Job Object 回收完整进程树。
#[cfg(windows)]
#[test]
fn windows_ctrl_c_timeout_forces_job_tree_cleanup() {
    let node = packaged_windows_node();
    assert!(node.is_file());
    let root = temporary_directory("windows-ctrl-c-timeout");
    let ready = root.join("ready");
    let script = root.join("stubborn-sigint.cjs");
    let probe = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
    let address = probe.local_addr().unwrap();
    drop(probe);
    fs::write(
        &script,
        r#"const fs = require('node:fs')
const { spawn } = require('node:child_process')
spawn(process.execPath, ['-e', `const fs=require('node:fs');const net=require('node:net');const [host,port]=process.env.DSH_WINDOWS_DESCENDANT_ADDRESS.split(':');net.createServer(()=>{}).listen(Number(port),host,()=>fs.writeFileSync(process.env.DSH_WINDOWS_CTRL_C_READY,String(process.pid)));setInterval(()=>{},1000)`], { stdio: 'ignore', env: process.env })
process.on('SIGINT', () => {})
setInterval(() => {}, 1000)
"#,
    )
    .unwrap();
    let mut command = Command::new(node);
    command
        .arg(script)
        .env("DSH_WINDOWS_CTRL_C_READY", &ready)
        .env("DSH_WINDOWS_DESCENDANT_ADDRESS", address.to_string());
    let process = spawn_owned_command(command, 33, || Ok(())).unwrap();
    for _ in 0..400 {
        if ready.is_file() {
            break;
        }
        thread::sleep(Duration::from_millis(25));
    }
    assert!(ready.is_file(), "stubborn Node helper did not become ready");
    let descendant = WindowsTestProcessHandle::open(&ready);
    let report = process
        .stop(33, Duration::ZERO, Duration::from_secs(2))
        .unwrap();
    assert_eq!(report.outcome, StopOutcome::Forced);
    assert_eq!(report.exit.unwrap().reason, ExitReason::Requested);
    descendant.assert_exited();
    assert!(TcpListener::bind(address).is_ok());
    fs::remove_dir_all(root).unwrap();
}
