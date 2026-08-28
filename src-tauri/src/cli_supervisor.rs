//! 官方 `dsh web` CLI 的命令构造与进程树监督边界。

use crate::lifecycle::{stop_process, ProcessControl, StopOutcome};
use serde::Deserialize;
use std::ffi::OsString;
use std::fs;
use std::io;
use std::net::{Ipv4Addr, SocketAddrV4, TcpListener};
use std::path::{Path, PathBuf};
use std::process::{Command, ExitStatus, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

#[cfg(unix)]
use std::os::unix::process::CommandExt;
#[cfg(windows)]
use std::os::windows::ffi::OsStrExt;
#[cfg(windows)]
use std::os::windows::process::ExitStatusExt;
#[cfg(not(windows))]
use std::process::Child;

#[cfg(windows)]
use windows_sys::Win32::Foundation::{
    CloseHandle, DuplicateHandle, DUPLICATE_SAME_ACCESS, GENERIC_READ, GENERIC_WRITE, HANDLE,
    INVALID_HANDLE_VALUE, STILL_ACTIVE, WAIT_FAILED, WAIT_OBJECT_0, WAIT_TIMEOUT,
};
#[cfg(windows)]
use windows_sys::Win32::Globalization::{
    CompareStringOrdinal, CSTR_EQUAL, CSTR_GREATER_THAN, CSTR_LESS_THAN,
};
#[cfg(windows)]
use windows_sys::Win32::Security::SECURITY_ATTRIBUTES;
#[cfg(windows)]
use windows_sys::Win32::Storage::FileSystem::{
    CreateFileW, FILE_ATTRIBUTE_NORMAL, FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING,
};
#[cfg(windows)]
use windows_sys::Win32::System::Console::{
    AttachConsole, FreeConsole, GenerateConsoleCtrlEvent, GetConsoleCP, GetStdHandle,
    SetConsoleCtrlHandler, ATTACH_PARENT_PROCESS, CTRL_C_EVENT, STD_ERROR_HANDLE,
    STD_OUTPUT_HANDLE,
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
    CreateProcessW, DeleteProcThreadAttributeList, GetCurrentProcess, GetExitCodeProcess,
    InitializeProcThreadAttributeList, ResumeThread, TerminateProcess, UpdateProcThreadAttribute,
    WaitForSingleObject, CREATE_UNICODE_ENVIRONMENT, EXTENDED_STARTUPINFO_PRESENT, INFINITE,
    PROCESS_INFORMATION, PROC_THREAD_ATTRIBUTE_HANDLE_LIST, STARTF_USESHOWWINDOW,
    STARTF_USESTDHANDLES, STARTUPINFOEXW,
};
pub(crate) const HOST_ADDRESS: &str = "127.0.0.1";
pub(crate) const HOST_PORT: u16 = 3080;
pub(crate) const HOST_ORIGIN: &str = "http://127.0.0.1:3080/";
const DESKTOP_UPDATE_PATCH: &str = "@cyunlab/dsh-desktop-update-client/cordis.patch.yml";
const PINNED_DSH_VERSION: &str = "0.1.0-rc.6";
#[cfg(windows)]
const CREATE_NEW_CONSOLE_FLAG: u32 = 0x0000_0010;
#[cfg(windows)]
const CREATE_SUSPENDED_FLAG: u32 = 0x0000_0004;
#[cfg(windows)]
const SW_HIDE_VALUE: u16 = 0;

/// 描述 Windows CLI 创建标志和窗口可见性。
#[cfg(windows)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct WindowsLaunchContract {
    creation_flags: u32,
    show_window: u16,
}

/// 返回 Windows direct CLI 的稳定创建契约，供实现与跨平台测试共用。
#[cfg(windows)]
fn windows_launch_contract() -> WindowsLaunchContract {
    WindowsLaunchContract {
        creation_flags: CREATE_NEW_CONSOLE_FLAG | CREATE_SUSPENDED_FLAG,
        show_window: SW_HIDE_VALUE,
    }
}

/// 用生产相同控制流保证挂起进程先接管 Job，再恢复初始线程。
#[cfg(windows)]
fn assign_then_resume<C, O, E>(
    child: &mut C,
    assign: impl FnOnce(&C) -> Result<O, E>,
    resume: impl FnOnce(&mut C) -> Result<(), E>,
) -> Result<O, (Option<O>, E)> {
    let ownership = assign(child).map_err(|error| (None, error))?;
    match resume(child) {
        Ok(()) => Ok(ownership),
        Err(error) => Err((Some(ownership), error)),
    }
}

#[cfg(windows)]
static WINDOWS_CONSOLE_CONTROL: Mutex<()> = Mutex::new(());

/// 按 CommandLineToArgvW 兼容规则引用一个 Windows UTF-16 参数。
#[cfg(windows)]
fn quote_windows_argument(argument: &[u16]) -> Vec<u16> {
    let needs_quotes = argument.is_empty()
        || argument.iter().any(|character| {
            *character == b' ' as u16 || *character == b'\t' as u16 || *character == b'"' as u16
        });
    if !needs_quotes {
        return argument.to_vec();
    }
    let mut quoted = vec![b'"' as u16];
    let mut backslashes = 0;
    for character in argument.iter().copied() {
        if character == b'\\' as u16 {
            backslashes += 1;
            continue;
        }
        if character == b'"' as u16 {
            quoted.extend(std::iter::repeat_n(b'\\' as u16, backslashes * 2 + 1));
            quoted.push(character);
        } else {
            quoted.extend(std::iter::repeat_n(b'\\' as u16, backslashes));
            quoted.push(character);
        }
        backslashes = 0;
    }
    quoted.extend(std::iter::repeat_n(b'\\' as u16, backslashes * 2));
    quoted.push(b'"' as u16);
    quoted
}

#[cfg(not(windows))]
type PlatformChild = Child;

/// 持有 CreateProcessW 返回的 Windows leader 与初始线程句柄。
#[cfg(windows)]
struct PlatformChild {
    process: isize,
    primary_thread: isize,
    pid: u32,
}

#[cfg(windows)]
impl PlatformChild {
    /// 返回 Windows CLI leader 的进程标识。
    fn id(&self) -> u32 {
        self.pid
    }

    /// 在 Job Object 接管后恢复 CreateProcessW 挂起的唯一初始线程。
    fn resume_initial_thread(&mut self) -> Result<(), String> {
        if self.primary_thread == 0 {
            return Err("CLI primary thread handle is unavailable".into());
        }
        let result = unsafe { ResumeThread(self.primary_thread as HANDLE) };
        unsafe { CloseHandle(self.primary_thread as HANDLE) };
        self.primary_thread = 0;
        if result == u32::MAX {
            Err("failed to resume suspended CLI primary thread".into())
        } else {
            Ok(())
        }
    }

    /// 非阻塞读取 Windows leader 的真实退出状态。
    fn try_wait(&mut self) -> io::Result<Option<ExitStatus>> {
        match unsafe { WaitForSingleObject(self.process as HANDLE, 0) } {
            WAIT_OBJECT_0 => self.exit_status().map(Some),
            WAIT_TIMEOUT => Ok(None),
            WAIT_FAILED => Err(io::Error::last_os_error()),
            unexpected => Err(io::Error::other(format!(
                "unexpected Windows process wait result: {unexpected}"
            ))),
        }
    }

    /// 等待 Windows leader 退出并读取真实退出状态。
    fn wait(&mut self) -> io::Result<ExitStatus> {
        if unsafe { WaitForSingleObject(self.process as HANDLE, INFINITE) } != WAIT_OBJECT_0 {
            return Err(io::Error::last_os_error());
        }
        self.exit_status()
    }

    /// 终止尚未交给 Job Object 的挂起进程。
    fn kill(&mut self) -> io::Result<()> {
        if unsafe { TerminateProcess(self.process as HANDLE, 1) } == 0 {
            Err(io::Error::last_os_error())
        } else {
            Ok(())
        }
    }

    /// 从 Windows process handle 读取退出码。
    fn exit_status(&self) -> io::Result<ExitStatus> {
        let mut code = STILL_ACTIVE as u32;
        if unsafe { GetExitCodeProcess(self.process as HANDLE, &mut code) } == 0 {
            Err(io::Error::last_os_error())
        } else {
            Ok(ExitStatus::from_raw(code))
        }
    }
}

#[cfg(windows)]
impl Drop for PlatformChild {
    /// 关闭 CreateProcessW 返回且仍由该适配器持有的句柄。
    fn drop(&mut self) {
        if self.primary_thread != 0 {
            unsafe { CloseHandle(self.primary_thread as HANDLE) };
        }
        if self.process != 0 {
            unsafe { CloseHandle(self.process as HANDLE) };
        }
    }
}

/// 持有只供 CreateProcessW 继承的标准流句柄。
#[cfg(windows)]
struct WindowsStartupHandles {
    input: HANDLE,
    output: HANDLE,
    error: HANDLE,
    owned: Vec<HANDLE>,
}

/// 保存 Windows STARTUPINFOEX attribute list 的对齐内存并负责释放内部资源。
#[cfg(windows)]
struct WindowsAttributeList {
    storage: Vec<usize>,
}

#[cfg(windows)]
impl WindowsAttributeList {
    /// 创建只允许指定标准流句柄继承的 PROC_THREAD_ATTRIBUTE_HANDLE_LIST。
    fn for_handles(handles: &mut [HANDLE]) -> Result<Self, String> {
        let mut bytes = 0usize;
        unsafe {
            InitializeProcThreadAttributeList(std::ptr::null_mut(), 1, 0, &mut bytes);
        }
        if bytes == 0 {
            return Err(format!(
                "failed to size Windows process attribute list: {}",
                io::Error::last_os_error()
            ));
        }
        let words = bytes.div_ceil(std::mem::size_of::<usize>());
        let mut list = Self {
            storage: vec![0usize; words],
        };
        if unsafe { InitializeProcThreadAttributeList(list.as_mut_ptr(), 1, 0, &mut bytes) } == 0 {
            list.storage.clear();
            return Err(format!(
                "failed to initialize Windows process attribute list: {}",
                io::Error::last_os_error()
            ));
        }
        if unsafe {
            UpdateProcThreadAttribute(
                list.as_mut_ptr(),
                0,
                PROC_THREAD_ATTRIBUTE_HANDLE_LIST as usize,
                handles.as_ptr().cast(),
                std::mem::size_of_val(handles),
                std::ptr::null_mut(),
                std::ptr::null(),
            )
        } == 0
        {
            let error = io::Error::last_os_error();
            unsafe { DeleteProcThreadAttributeList(list.as_mut_ptr()) };
            list.storage.clear();
            return Err(format!(
                "failed to restrict Windows inherited handles: {error}"
            ));
        }
        Ok(list)
    }

    /// 返回供 STARTUPINFOEXW 使用的 attribute list 地址。
    fn as_mut_ptr(&mut self) -> *mut std::ffi::c_void {
        self.storage.as_mut_ptr().cast()
    }
}

#[cfg(windows)]
impl Drop for WindowsAttributeList {
    /// 在 backing memory 释放前销毁已初始化的 attribute list。
    fn drop(&mut self) {
        if !self.storage.is_empty() {
            unsafe { DeleteProcThreadAttributeList(self.as_mut_ptr()) };
        }
    }
}

/// 去除无效和重复句柄，构造唯一的 Windows 继承 allowlist。
#[cfg(windows)]
fn unique_handle_allowlist(handles: impl IntoIterator<Item = isize>) -> Vec<isize> {
    let mut allowed = Vec::new();
    for handle in handles {
        if handle != 0 && handle != -1 && !allowed.contains(&handle) {
            allowed.push(handle);
        }
    }
    allowed
}

#[cfg(windows)]
impl Drop for WindowsStartupHandles {
    /// CreateProcessW 返回后关闭父进程侧临时标准流句柄。
    fn drop(&mut self) {
        for handle in self.owned.drain(..) {
            unsafe { CloseHandle(handle) };
        }
    }
}

/// 创建一个可继承的 Windows NUL 句柄。
#[cfg(windows)]
fn open_inheritable_null(access: u32) -> Result<HANDLE, String> {
    let security = SECURITY_ATTRIBUTES {
        nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: std::ptr::null_mut(),
        bInheritHandle: 1,
    };
    let name = [b'N' as u16, b'U' as u16, b'L' as u16, 0];
    let handle = unsafe {
        CreateFileW(
            name.as_ptr(),
            access,
            FILE_SHARE_READ | FILE_SHARE_WRITE,
            &security,
            OPEN_EXISTING,
            FILE_ATTRIBUTE_NORMAL,
            std::ptr::null_mut(),
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        Err(format!(
            "failed to open Windows NUL handle: {}",
            io::Error::last_os_error()
        ))
    } else {
        Ok(handle)
    }
}

/// 复制父进程标准流为可继承句柄；无有效标准流时退回 NUL。
#[cfg(windows)]
fn duplicate_standard_handle(kind: u32, fallback_access: u32) -> Result<HANDLE, String> {
    let source = unsafe { GetStdHandle(kind) };
    if source.is_null() || source == INVALID_HANDLE_VALUE {
        return open_inheritable_null(fallback_access);
    }
    let current = unsafe { GetCurrentProcess() };
    let mut duplicated = std::ptr::null_mut();
    if unsafe {
        DuplicateHandle(
            current,
            source,
            current,
            &mut duplicated,
            0,
            1,
            DUPLICATE_SAME_ACCESS,
        )
    } == 0
    {
        Err(format!(
            "failed to duplicate Windows standard handle: {}",
            io::Error::last_os_error()
        ))
    } else {
        Ok(duplicated)
    }
}

/// 根据开发/打包策略准备继承或丢弃的 Windows CLI 标准流。
#[cfg(windows)]
fn windows_startup_handles() -> Result<WindowsStartupHandles, String> {
    let input = open_inheritable_null(GENERIC_READ)?;
    let output_result = if cfg!(debug_assertions) {
        duplicate_standard_handle(STD_OUTPUT_HANDLE, GENERIC_WRITE)
    } else {
        open_inheritable_null(GENERIC_WRITE)
    };
    let output = match output_result {
        Ok(output) => output,
        Err(error) => {
            unsafe { CloseHandle(input) };
            return Err(error);
        }
    };
    let error_result = if cfg!(debug_assertions) {
        duplicate_standard_handle(STD_ERROR_HANDLE, GENERIC_WRITE)
    } else {
        open_inheritable_null(GENERIC_WRITE)
    };
    let error = match error_result {
        Ok(error) => error,
        Err(error) => {
            unsafe {
                CloseHandle(input);
                CloseHandle(output);
            }
            return Err(error);
        }
    };
    Ok(WindowsStartupHandles {
        input,
        output,
        error,
        owned: vec![input, output, error],
    })
}

/// 描述构造官方 CLI 命令所需的全部路径。
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct CliCommandPlan {
    node_executable: PathBuf,
    cli_entry: PathBuf,
    desktop_patch: PathBuf,
    harness_home: PathBuf,
    working_directory: PathBuf,
    path: OsString,
}

impl CliCommandPlan {
    /// 创建尚未启动的官方 `dsh web` 命令。
    fn command(&self) -> Command {
        let mut command = Command::new(&self.node_executable);
        command
            .arg(&self.cli_entry)
            .args(["web", "--patch"])
            .arg(&self.desktop_patch)
            .args(["--host", HOST_ADDRESS, "--port"])
            .arg(HOST_PORT.to_string())
            .current_dir(&self.working_directory)
            .env("DSH_HOME", &self.harness_home)
            .stdin(Stdio::null());
        for (name, _) in std::env::vars_os()
            .filter(|(name, _)| name.to_string_lossy().eq_ignore_ascii_case("path"))
        {
            command.env_remove(name);
        }
        command.env_remove("PATH").env_remove("Path");
        command.env("PATH", &self.path);
        if cfg!(debug_assertions) {
            command.stdout(Stdio::inherit()).stderr(Stdio::inherit());
        } else {
            command.stdout(Stdio::null()).stderr(Stdio::null());
        }
        command
    }

    /// debug+wdio 构建只替换 JS 入口，仍沿用生产命令的固定参数和环境。
    #[cfg(all(debug_assertions, feature = "wdio"))]
    pub(crate) fn with_test_entry(mut self, cli_entry: PathBuf) -> Self {
        self.cli_entry = cli_entry;
        self
    }
}

/// 发布包清单中本模块需要读取的最小字段。
#[derive(Debug, Deserialize)]
struct DshManifest {
    name: String,
    version: String,
    bin: DshBins,
}

/// 发布包声明的命令入口。
#[derive(Debug, Deserialize)]
struct DshBins {
    dsh: String,
}

/// 监督进程的退出原因，不依赖 CLI 的人类可读输出。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ExitReason {
    Requested,
    Unexpected,
    StaleGeneration,
}

/// 保留真实退出状态及其相对于当前轮次的稳定分类。
#[derive(Debug)]
pub(crate) struct ProcessExit {
    pub status: ExitStatus,
    pub reason: ExitReason,
}

/// 一次有界停止保留的清理结果和真实 CLI 退出信息。
#[derive(Debug)]
pub(crate) struct StopReport {
    pub outcome: StopOutcome,
    pub exit: Option<ProcessExit>,
}

/// CLI 启动边界可稳定映射到 Desktop 诊断分类的错误。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SupervisorError {
    RuntimeUnavailable,
    PortConflict,
    PreflightFailed,
    SpawnFailed,
    CleanupFailed,
}

/// 对仍存活的 CLI leader 执行平台优雅停止动作。
type GracefulAction = fn(u32) -> Result<(), String>;

/// 描述一个由 Desktop 拥有的 CLI 进程树。
pub(crate) struct CliProcess {
    generation: u64,
    child: Mutex<PlatformChild>,
    ownership: ProcessOwnership,
    requested_generation: AtomicU64,
    observed_status: Mutex<Option<ExitStatus>>,
    classified_reason: Mutex<Option<ExitReason>>,
    stop_lock: Mutex<()>,
    graceful_action: GracefulAction,
}

/// 按发布 `package.json#bin.dsh` 契约解析闭包内的 CLI 入口。
fn resolve_dsh_cli_entry(runtime_root: &Path) -> Result<PathBuf, String> {
    let runtime_root = runtime_root
        .canonicalize()
        .map_err(|error| format!("runtime closure is unavailable: {error}"))?;
    let package_directory = runtime_root.join("@deepseek-ai/dsh");
    let package_directory = package_directory
        .canonicalize()
        .map_err(|error| format!("@deepseek-ai/dsh package is unavailable: {error}"))?;
    if !package_directory.starts_with(&runtime_root) {
        return Err("@deepseek-ai/dsh package resolves outside the runtime closure".into());
    }
    let manifest_path = package_directory.join("package.json");
    if fs::symlink_metadata(&manifest_path)
        .map_err(|error| format!("@deepseek-ai/dsh/package.json is unavailable: {error}"))?
        .file_type()
        .is_symlink()
    {
        return Err("@deepseek-ai/dsh/package.json must not be a symbolic link".into());
    }
    let manifest: DshManifest = serde_json::from_slice(
        &fs::read(&manifest_path)
            .map_err(|error| format!("@deepseek-ai/dsh/package.json cannot be read: {error}"))?,
    )
    .map_err(|error| format!("@deepseek-ai/dsh/package.json is invalid: {error}"))?;
    if manifest.name != "@deepseek-ai/dsh" || manifest.version != PINNED_DSH_VERSION {
        return Err(format!(
            "@deepseek-ai/dsh runtime version mismatch: expected {PINNED_DSH_VERSION}, found {}",
            manifest.version
        ));
    }
    if manifest.bin.dsh.trim().is_empty() {
        return Err("@deepseek-ai/dsh package.json#bin.dsh is empty".into());
    }
    let entry = package_directory.join(&manifest.bin.dsh);
    if fs::symlink_metadata(&entry)
        .map_err(|error| format!("@deepseek-ai/dsh CLI entry is unavailable: {error}"))?
        .file_type()
        .is_symlink()
    {
        return Err("@deepseek-ai/dsh CLI entry must not be a symbolic link".into());
    }
    let entry = entry
        .canonicalize()
        .map_err(|error| format!("@deepseek-ai/dsh CLI entry is unavailable: {error}"))?;
    if !entry.starts_with(&package_directory) || !entry.is_file() {
        return Err("@deepseek-ai/dsh package.json#bin.dsh escapes its package".into());
    }
    Ok(entry)
}

/// 解析并约束 Desktop 自有的临时 Web composition patch。
fn resolve_desktop_update_patch(runtime_root: &Path) -> Result<PathBuf, String> {
    let runtime_root = runtime_root
        .canonicalize()
        .map_err(|error| format!("runtime closure is unavailable: {error}"))?;
    let patch = runtime_root.join(DESKTOP_UPDATE_PATCH);
    if fs::symlink_metadata(&patch)
        .map_err(|error| format!("Desktop update patch is unavailable: {error}"))?
        .file_type()
        .is_symlink()
    {
        return Err("Desktop update patch must not be a symbolic link".into());
    }
    let patch = patch
        .canonicalize()
        .map_err(|error| format!("Desktop update patch is unavailable: {error}"))?;
    if !patch.starts_with(&runtime_root) || !patch.is_file() {
        return Err("Desktop update patch escapes the runtime closure".into());
    }
    Ok(patch)
}

/// 将官方 Node 目录放在继承 PATH 的第一项。
fn prepend_node_path(
    node_executable: &Path,
    inherited_path: Option<OsString>,
) -> Result<OsString, String> {
    let node_directory = node_executable
        .parent()
        .ok_or_else(|| "official Node executable has no parent directory".to_string())?;
    let paths = std::iter::once(node_directory.to_path_buf()).chain(
        inherited_path
            .as_deref()
            .map(std::env::split_paths)
            .into_iter()
            .flatten(),
    );
    std::env::join_paths(paths).map_err(|error| format!("cannot construct CLI PATH: {error}"))
}

/// 对固定 Host 地址做一次普通端口冲突预检并立即释放。
fn preflight_host_port() -> io::Result<()> {
    preflight_address(SocketAddrV4::new(Ipv4Addr::LOCALHOST, HOST_PORT))
}

/// 绑定并立即释放一个地址，供固定端口实现和冲突测试共用。
fn preflight_address(address: SocketAddrV4) -> io::Result<()> {
    let listener = TcpListener::bind(address)?;
    drop(listener);
    Ok(())
}

/// 根据拥有关系和当前轮次对真实退出作分类。
fn classify_exit(
    process_generation: u64,
    current_generation: u64,
    requested_generation: Option<u64>,
) -> ExitReason {
    if requested_generation == Some(process_generation) {
        ExitReason::Requested
    } else if process_generation != current_generation {
        ExitReason::StaleGeneration
    } else {
        ExitReason::Unexpected
    }
}

/// 将真实退出码与 generation ownership 一起分类，避免把孤立的 code 130 当作正常关闭。
fn classify_exit_with_code(
    process_generation: u64,
    current_generation: u64,
    requested_generation: Option<u64>,
    exit_code: Option<i32>,
) -> ExitReason {
    if exit_code == Some(130) {
        if requested_generation == Some(process_generation) {
            ExitReason::Requested
        } else {
            ExitReason::Unexpected
        }
    } else {
        classify_exit(process_generation, current_generation, requested_generation)
    }
}

/// Unix 为 CLI leader 建立独立进程组，供超时后的整树回收使用。
#[cfg(unix)]
fn configure_platform_command(command: &mut Command) {
    command.process_group(0);
}

/// 非 Unix 的进程创建属性由对应平台适配器负责。
#[cfg(not(unix))]
fn configure_platform_command(_command: &mut Command) {}

/// 返回继承环境中大小写兼容的 PATH 值。
fn inherited_path() -> Option<OsString> {
    std::env::vars_os().find_map(|(name, value)| {
        name.to_string_lossy()
            .eq_ignore_ascii_case("path")
            .then_some(value)
    })
}

/// 将 Windows OS 字符串编码为带终止 NUL 的 UTF-16，并拒绝内嵌 NUL。
#[cfg(windows)]
fn windows_wide(value: &std::ffi::OsStr) -> Result<Vec<u16>, String> {
    let mut wide = value.encode_wide().collect::<Vec<_>>();
    if wide.contains(&0) {
        return Err("Windows process value contains an embedded NUL".into());
    }
    wide.push(0);
    Ok(wide)
}

/// 由标准 Command 参数构造 CreateProcessW 可写命令行。
#[cfg(windows)]
fn windows_command_line(command: &Command) -> Result<Vec<u16>, String> {
    let mut command_line = Vec::new();
    let mut values = std::iter::once(command.get_program()).chain(command.get_args());
    if let Some(program) = values.next() {
        command_line.extend(quote_windows_argument(
            &program.encode_wide().collect::<Vec<_>>(),
        ));
    }
    for argument in values {
        command_line.push(b' ' as u16);
        command_line.extend(quote_windows_argument(
            &argument.encode_wide().collect::<Vec<_>>(),
        ));
    }
    if command_line.contains(&0) {
        return Err("Windows command line contains an embedded NUL".into());
    }
    command_line.push(0);
    Ok(command_line)
}

/// 用 Windows ordinal case-insensitive 规则比较两个 UTF-16 环境变量名。
#[cfg(windows)]
fn compare_windows_environment_names(
    left: &std::ffi::OsStr,
    right: &std::ffi::OsStr,
) -> std::cmp::Ordering {
    let left = left.encode_wide().collect::<Vec<_>>();
    let right = right.encode_wide().collect::<Vec<_>>();
    assert!(left.len() <= i32::MAX as usize && right.len() <= i32::MAX as usize);
    match unsafe {
        CompareStringOrdinal(
            left.as_ptr(),
            left.len() as i32,
            right.as_ptr(),
            right.len() as i32,
            1,
        )
    } {
        CSTR_LESS_THAN => std::cmp::Ordering::Less,
        CSTR_EQUAL => std::cmp::Ordering::Equal,
        CSTR_GREATER_THAN => std::cmp::Ordering::Greater,
        unexpected => panic!("CompareStringOrdinal returned {unexpected}"),
    }
}

/// 按 Windows ordinal case-insensitive 语义合并、去重并排序进程环境。
#[cfg(windows)]
fn merge_windows_environment(
    inherited: impl IntoIterator<Item = (OsString, OsString)>,
    overrides: impl IntoIterator<Item = (OsString, Option<OsString>)>,
) -> Vec<(OsString, OsString)> {
    let mut environment = Vec::new();
    for (name, value) in inherited {
        environment.retain(|(existing, _): &(OsString, OsString)| {
            compare_windows_environment_names(existing, &name) != std::cmp::Ordering::Equal
        });
        environment.push((name, value));
    }
    let overrides = overrides.into_iter().collect::<Vec<_>>();
    for (name, _) in overrides.iter().filter(|(_, value)| value.is_none()) {
        environment.retain(|(existing, _)| {
            compare_windows_environment_names(existing, name) != std::cmp::Ordering::Equal
        });
    }
    for (name, value) in overrides
        .into_iter()
        .filter_map(|(name, value)| value.map(|value| (name, value)))
    {
        environment.retain(|(existing, _)| {
            compare_windows_environment_names(existing, &name) != std::cmp::Ordering::Equal
        });
        environment.push((name, value));
    }
    environment.sort_by(|(left, _), (right, _)| compare_windows_environment_names(left, right));
    environment
}

/// 合并继承环境与 Command 覆盖项并构造 Windows Unicode environment block。
#[cfg(windows)]
fn windows_environment_block(command: &Command) -> Result<Vec<u16>, String> {
    let environment = merge_windows_environment(
        std::env::vars_os(),
        command
            .get_envs()
            .map(|(name, value)| (name.to_os_string(), value.map(OsString::from))),
    );
    let mut block = Vec::new();
    for (name, value) in environment {
        let name = name.encode_wide().collect::<Vec<_>>();
        let value = value.encode_wide().collect::<Vec<_>>();
        if name.contains(&0) || value.contains(&0) {
            return Err("Windows environment contains an embedded NUL".into());
        }
        block.extend(name);
        block.push(b'=' as u16);
        block.extend(value);
        block.push(0);
    }
    if block.is_empty() {
        block.push(0);
    }
    block.push(0);
    Ok(block)
}

/// 通过隐藏的专属 console 创建挂起 CLI，并保留主线程句柄供 Job 接管后恢复。
#[cfg(windows)]
fn spawn_windows_command(command: &Command) -> Result<PlatformChild, String> {
    let _console = WINDOWS_CONSOLE_CONTROL
        .lock()
        .map_err(|_| "Windows console control lock poisoned".to_string())?;
    let contract = windows_launch_contract();
    let application = windows_wide(command.get_program())?;
    let mut command_line = windows_command_line(command)?;
    let environment = windows_environment_block(command)?;
    let working_directory = command
        .get_current_dir()
        .map(|directory| windows_wide(directory.as_os_str()))
        .transpose()?;
    let handles = windows_startup_handles()?;
    let mut inherited_handles = unique_handle_allowlist([
        handles.input as isize,
        handles.output as isize,
        handles.error as isize,
    ])
    .into_iter()
    .map(|handle| handle as HANDLE)
    .collect::<Vec<_>>();
    let mut attributes = WindowsAttributeList::for_handles(&mut inherited_handles)?;
    let mut startup: STARTUPINFOEXW = unsafe { std::mem::zeroed() };
    startup.StartupInfo.cb = std::mem::size_of::<STARTUPINFOEXW>() as u32;
    startup.StartupInfo.dwFlags = STARTF_USESHOWWINDOW | STARTF_USESTDHANDLES;
    startup.StartupInfo.wShowWindow = contract.show_window;
    startup.StartupInfo.hStdInput = handles.input;
    startup.StartupInfo.hStdOutput = handles.output;
    startup.StartupInfo.hStdError = handles.error;
    startup.lpAttributeList = attributes.as_mut_ptr();
    let mut process: PROCESS_INFORMATION = unsafe { std::mem::zeroed() };
    let created = unsafe {
        CreateProcessW(
            application.as_ptr(),
            command_line.as_mut_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            1,
            contract.creation_flags | CREATE_UNICODE_ENVIRONMENT | EXTENDED_STARTUPINFO_PRESENT,
            environment.as_ptr().cast(),
            working_directory
                .as_ref()
                .map_or(std::ptr::null(), |directory| directory.as_ptr()),
            &startup.StartupInfo,
            &mut process,
        )
    };
    if created == 0 {
        return Err(format!(
            "failed to create hidden Windows CLI: {}",
            io::Error::last_os_error()
        ));
    }
    Ok(PlatformChild {
        process: process.hProcess as isize,
        primary_thread: process.hThread as isize,
        pid: process.dwProcessId,
    })
}

/// 从运行时闭包和 Desktop 数据目录构造完整命令计划。
pub(crate) fn build_command_plan(
    node_executable: PathBuf,
    runtime_root: &Path,
    harness_home: PathBuf,
    working_directory: PathBuf,
) -> Result<CliCommandPlan, String> {
    let cli_entry = resolve_dsh_cli_entry(runtime_root)?;
    let desktop_patch = resolve_desktop_update_patch(runtime_root)?;
    let path = prepend_node_path(&node_executable, inherited_path())?;
    Ok(CliCommandPlan {
        node_executable,
        cli_entry,
        desktop_patch,
        harness_home,
        working_directory,
        path,
    })
}

/// Windows 下持有 Job Object，确保异常退出时后代不会脱管。
#[cfg(windows)]
struct ProcessOwnership {
    job: isize,
}

#[cfg(windows)]
impl ProcessOwnership {
    /// 为挂起进程创建 kill-on-close Job 并完成接管。
    fn attach(child: &PlatformChild) -> Result<Self, String> {
        let job = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
        if job.is_null() {
            return Err("failed to create CLI Job Object".into());
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
            return Err("failed to configure CLI Job Object".into());
        }
        let assigned = unsafe { AssignProcessToJobObject(job, child.process as HANDLE) != 0 };
        if !assigned {
            unsafe { CloseHandle(job) };
            return Err("failed to assign CLI process to Job Object".into());
        }
        Ok(Self { job: job as isize })
    }

    /// 强制终止 Job 中的完整 CLI 进程树。
    fn force_kill_tree(&self) -> Result<(), String> {
        if unsafe { TerminateJobObject(self.job as HANDLE, 1) } != 0 {
            Ok(())
        } else {
            Err("failed to terminate CLI Job Object".into())
        }
    }

    /// 查询 Job 中是否已经没有活动进程。
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
        queried
            .then_some(accounting.ActiveProcesses == 0)
            .ok_or_else(|| "failed to query CLI Job Object".into())
    }
}

#[cfg(windows)]
impl Drop for ProcessOwnership {
    /// 关闭 Job 句柄并触发 kill-on-close 安全兜底。
    fn drop(&mut self) {
        unsafe { CloseHandle(self.job as HANDLE) };
    }
}

/// Unix 下持有以 CLI leader 为组长的独立进程组。
#[cfg(unix)]
struct ProcessOwnership {
    pgid: i32,
}

#[cfg(unix)]
impl ProcessOwnership {
    /// 记录已经由 `process_group(0)` 建立的进程组。
    fn attach(child: &PlatformChild) -> Result<Self, String> {
        Ok(Self {
            pgid: child.id() as i32,
        })
    }

    /// 仅在宽限期结束后向拥有的进程组发送 SIGKILL。
    fn force_kill_tree(&self) -> Result<(), String> {
        let result = unsafe { libc::kill(-self.pgid, libc::SIGKILL) };
        if result == 0 {
            return Ok(());
        }
        let error = std::io::Error::last_os_error();
        if error.raw_os_error() == Some(libc::ESRCH) {
            Ok(())
        } else {
            Err(format!(
                "failed to kill CLI process group {}: {error}",
                self.pgid
            ))
        }
    }

    /// 查询拥有的进程组是否已经完全消失。
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
                "failed to query CLI process group {}: {error}",
                self.pgid
            )),
        }
    }
}

/// 其它平台只拥有直接 CLI 子进程。
#[cfg(not(any(unix, windows)))]
struct ProcessOwnership;

#[cfg(not(any(unix, windows)))]
impl ProcessOwnership {
    /// 建立仅包含直接子进程的拥有关系。
    fn attach(_child: &PlatformChild) -> Result<Self, String> {
        Ok(Self)
    }

    /// 其它平台由直接子进程终止提供兜底。
    fn force_kill_tree(&self) -> Result<(), String> {
        Ok(())
    }

    /// 其它平台没有额外进程树状态。
    fn tree_has_exited(&self) -> Result<bool, String> {
        Ok(true)
    }
}

/// 在 Windows 接管失败时终止仍处于挂起态的 CLI。
#[cfg(windows)]
fn terminate_unowned_child(child: &mut PlatformChild) -> Result<(), String> {
    child.kill().map_err(|error| error.to_string())?;
    child.wait().map(|_| ()).map_err(|error| error.to_string())
}

/// 在非 Windows 接管失败时终止尚未暴露给调用方的 CLI。
#[cfg(not(windows))]
fn terminate_unowned_child(child: &mut Child) -> Result<(), String> {
    child.kill().map_err(|error| error.to_string())?;
    child.wait().map(|_| ()).map_err(|error| error.to_string())
}

/// 使用指定平台优雅动作创建并接管一条已经准备好的命令。
fn spawn_owned_command_with_graceful_action(
    mut command: Command,
    generation: u64,
    preflight: impl FnOnce() -> io::Result<()>,
    graceful_action: GracefulAction,
) -> Result<Arc<CliProcess>, SupervisorError> {
    configure_platform_command(&mut command);
    if let Err(error) = preflight() {
        return Err(if error.kind() == io::ErrorKind::AddrInUse {
            SupervisorError::PortConflict
        } else {
            SupervisorError::PreflightFailed
        });
    }
    #[cfg(windows)]
    let mut child = spawn_windows_command(&command).map_err(|_| SupervisorError::SpawnFailed)?;
    #[cfg(not(windows))]
    let mut child = command.spawn().map_err(|_| SupervisorError::SpawnFailed)?;
    #[cfg(windows)]
    let ownership = match assign_then_resume(
        &mut child,
        ProcessOwnership::attach,
        PlatformChild::resume_initial_thread,
    ) {
        Ok(ownership) => ownership,
        Err((None, _)) => {
            return Err(if terminate_unowned_child(&mut child).is_ok() {
                SupervisorError::SpawnFailed
            } else {
                SupervisorError::CleanupFailed
            });
        }
        Err((Some(ownership), _)) => {
            let cleanup = ownership
                .force_kill_tree()
                .and_then(|_| child.wait().map(|_| ()).map_err(|error| error.to_string()));
            return Err(if cleanup.is_ok() {
                SupervisorError::SpawnFailed
            } else {
                SupervisorError::CleanupFailed
            });
        }
    };
    #[cfg(not(windows))]
    let ownership = match ProcessOwnership::attach(&child) {
        Ok(ownership) => ownership,
        Err(_) => {
            return Err(if terminate_unowned_child(&mut child).is_ok() {
                SupervisorError::SpawnFailed
            } else {
                SupervisorError::CleanupFailed
            });
        }
    };
    Ok(Arc::new(CliProcess {
        generation,
        child: Mutex::new(child),
        ownership,
        requested_generation: AtomicU64::new(0),
        observed_status: Mutex::new(None),
        classified_reason: Mutex::new(None),
        stop_lock: Mutex::new(()),
        graceful_action,
    }))
}

/// 创建进程组/Job Object 并使用当前平台动作启动命令。
fn spawn_owned_command(
    command: Command,
    generation: u64,
    preflight: impl FnOnce() -> io::Result<()>,
) -> Result<Arc<CliProcess>, SupervisorError> {
    spawn_owned_command_with_graceful_action(
        command,
        generation,
        preflight,
        platform_graceful_action,
    )
}

/// Unix 仅向 CLI leader 发送 SIGTERM。
#[cfg(unix)]
fn platform_graceful_action(pid: u32) -> Result<(), String> {
    let result = unsafe { libc::kill(pid as i32, libc::SIGTERM) };
    if result == 0 {
        return Ok(());
    }
    let error = io::Error::last_os_error();
    if error.raw_os_error() == Some(libc::ESRCH) {
        Ok(())
    } else {
        Err(format!("failed to signal CLI leader {pid}: {error}"))
    }
}

/// 管理 Desktop 临时附着 child console 及 debug 父 console 恢复。
#[cfg(windows)]
struct WindowsConsoleAttachment {
    restore_parent: bool,
    child_attached: bool,
    ignore_enabled: bool,
}

#[cfg(windows)]
impl WindowsConsoleAttachment {
    /// 从现有 debug console 分离并附着到 owned child 的专属 console。
    fn attach(child_pid: u32) -> Result<Self, String> {
        let restore_parent = unsafe { GetConsoleCP() } != 0;
        if restore_parent && unsafe { FreeConsole() } == 0 {
            return Err(format!(
                "failed to detach Desktop console: {}",
                io::Error::last_os_error()
            ));
        }
        if unsafe { AttachConsole(child_pid) } == 0 {
            let attach_error = io::Error::last_os_error();
            let mut attachment = Self {
                restore_parent,
                child_attached: false,
                ignore_enabled: false,
            };
            let restore = attachment.restore();
            return Err(match restore {
                Ok(()) => format!("failed to attach CLI console: {attach_error}"),
                Err(error) => format!("failed to attach CLI console: {attach_error}; {error}"),
            });
        }
        let mut attachment = Self {
            restore_parent,
            child_attached: true,
            ignore_enabled: false,
        };
        if unsafe { SetConsoleCtrlHandler(None, 1) } == 0 {
            let handler_error = io::Error::last_os_error();
            let restore = attachment.restore();
            return Err(match restore {
                Ok(()) => format!("failed to ignore Desktop Ctrl+C: {handler_error}"),
                Err(error) => {
                    format!("failed to ignore Desktop Ctrl+C: {handler_error}; {error}")
                }
            });
        }
        attachment.ignore_enabled = true;
        Ok(attachment)
    }

    /// 从 child console 分离，并在有无父 console 时都撤销 Desktop 的 Ctrl+C ignore 属性。
    fn restore(&mut self) -> Result<(), String> {
        let mut errors = Vec::new();
        if self.ignore_enabled {
            if unsafe { SetConsoleCtrlHandler(None, 0) } == 0 {
                errors.push(format!(
                    "failed to restore Desktop Ctrl+C handling before detach: {}",
                    io::Error::last_os_error()
                ));
            } else {
                self.ignore_enabled = false;
            }
        }
        if self.child_attached {
            if unsafe { FreeConsole() } == 0 {
                errors.push(format!(
                    "failed to detach CLI console: {}",
                    io::Error::last_os_error()
                ));
            } else {
                self.child_attached = false;
            }
        }
        if self.restore_parent && !self.child_attached {
            if unsafe { AttachConsole(ATTACH_PARENT_PROCESS) } == 0 {
                errors.push(format!(
                    "failed to restore Desktop parent console: {}",
                    io::Error::last_os_error()
                ));
            } else {
                self.restore_parent = false;
            }
        }
        // 前一次撤销若失败，在 console 切换完成后再尝试一次，Drop 仍会继续兜底。
        if self.ignore_enabled {
            if unsafe { SetConsoleCtrlHandler(None, 0) } == 0 {
                errors.push(format!(
                    "failed to restore Desktop Ctrl+C handling: {}",
                    io::Error::last_os_error()
                ));
            } else {
                self.ignore_enabled = false;
            }
        }
        if errors.is_empty() {
            Ok(())
        } else {
            Err(errors.join("; "))
        }
    }

    /// 向专属 console 广播真实 Ctrl+C，并给 handler thread 一个启动窗口后恢复 Desktop。
    fn send_ctrl_c(&mut self) -> Result<(), String> {
        if unsafe { GenerateConsoleCtrlEvent(CTRL_C_EVENT, 0) } == 0 {
            return Err(format!(
                "failed to generate CLI Ctrl+C: {}",
                io::Error::last_os_error()
            ));
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
        self.restore()
    }
}

#[cfg(windows)]
impl Drop for WindowsConsoleAttachment {
    /// 错误路径也尽力解除 child console，防止 Desktop 保持错误附着状态。
    fn drop(&mut self) {
        let _ = self.restore();
    }
}

/// Windows 串行附着 owned 专属 console，以 group 0 广播真实 Ctrl+C。
#[cfg(windows)]
fn platform_graceful_action(pid: u32) -> Result<(), String> {
    let _control = WINDOWS_CONSOLE_CONTROL
        .lock()
        .map_err(|_| "Windows console control lock poisoned".to_string())?;
    let mut attachment = WindowsConsoleAttachment::attach(pid)?;
    attachment.send_ctrl_c()
}

/// 其它平台尚不提供 CLI 优雅停止动作。
#[cfg(not(any(unix, windows)))]
fn platform_graceful_action(_pid: u32) -> Result<(), String> {
    Err("graceful CLI shutdown is unavailable on this platform".into())
}

/// 在固定端口预检后启动一个由 Desktop 拥有的官方 CLI 进程树。
pub(crate) fn spawn_cli(
    plan: &CliCommandPlan,
    generation: u64,
) -> Result<Arc<CliProcess>, SupervisorError> {
    fs::create_dir_all(&plan.harness_home).map_err(|_| SupervisorError::RuntimeUnavailable)?;
    fs::create_dir_all(&plan.working_directory).map_err(|_| SupervisorError::RuntimeUnavailable)?;
    spawn_owned_command(plan.command(), generation, preflight_host_port)
}

impl CliProcess {
    /// 返回该进程唯一所属的 lifecycle generation。
    pub(crate) fn generation(&self) -> u64 {
        self.generation
    }

    /// 返回 CLI leader PID，仅用于进程监督与 debug 测试 recorder。
    #[cfg(all(debug_assertions, feature = "wdio"))]
    pub(crate) fn pid(&self) -> Result<u32, String> {
        self.child
            .lock()
            .map(|child| child.id())
            .map_err(|_| "CLI child lock poisoned".to_string())
    }

    /// 串行执行一次有界停止，避免 Retry 与窗口关闭重复操作进程树。
    pub(crate) fn with_stop_lock<T>(&self, stop: impl FnOnce() -> T) -> Result<T, String> {
        let _guard = self
            .stop_lock
            .lock()
            .map_err(|_| "CLI stop lock poisoned".to_string())?;
        Ok(stop())
    }

    /// 串行完成宽限停止并把 cleanup outcome 与真实退出状态一起返回。
    pub(crate) fn stop(
        &self,
        current_generation: u64,
        graceful_timeout: std::time::Duration,
        forced_timeout: std::time::Duration,
    ) -> Result<StopReport, String> {
        self.with_stop_lock(|| {
            let outcome = stop_process(self, current_generation, graceful_timeout, forced_timeout)?;
            let exit = self.try_exit(current_generation)?;
            Ok(StopReport { outcome, exit })
        })?
    }

    /// 缓存第一次观察到的直接子进程真实退出状态。
    fn cache_observed_status(&self, status: ExitStatus) -> Result<(), String> {
        let mut observed = self
            .observed_status
            .lock()
            .map_err(|_| "CLI exit status lock poisoned".to_string())?;
        observed.get_or_insert(status);
        Ok(())
    }

    /// 记录并返回直接 CLI 子进程的真实退出状态。
    fn observe_child_status(&self) -> Result<Option<ExitStatus>, String> {
        if let Some(status) = *self
            .observed_status
            .lock()
            .map_err(|_| "CLI exit status lock poisoned".to_string())?
        {
            return Ok(Some(status));
        }
        let status = self
            .child
            .lock()
            .map_err(|_| "CLI child lock poisoned".to_string())?
            .try_wait()
            .map_err(|error| error.to_string())?;
        if let Some(status) = status {
            self.cache_observed_status(status)?;
        }
        Ok(status)
    }

    /// 按当前 generation 返回退出状态及 requested/stale/unexpected 分类。
    pub(crate) fn try_exit(&self, current_generation: u64) -> Result<Option<ProcessExit>, String> {
        let Some(status) = self.observe_child_status()? else {
            return Ok(None);
        };
        let mut classified = self
            .classified_reason
            .lock()
            .map_err(|_| "CLI exit reason lock poisoned".to_string())?;
        let reason = *classified.get_or_insert_with(|| {
            classify_exit_with_code(
                self.generation,
                current_generation,
                match self.requested_generation.load(Ordering::Acquire) {
                    0 => None,
                    generation => Some(generation),
                },
                status.code(),
            )
        });
        Ok(Some(ProcessExit { status, reason }))
    }
}

impl ProcessControl for CliProcess {
    /// 确认 leader 存活并登记 owned request 后调用平台优雅停止动作。
    fn request_graceful_stop(&self, current_generation: u64) -> Result<(), String> {
        let mut child = self
            .child
            .lock()
            .map_err(|_| "CLI child lock poisoned".to_string())?;
        let already_observed = *self
            .observed_status
            .lock()
            .map_err(|_| "CLI exit status lock poisoned".to_string())?;
        let status = match already_observed {
            Some(status) => Some(status),
            None => child.try_wait().map_err(|error| error.to_string())?,
        };
        if let Some(status) = status {
            self.cache_observed_status(status)?;
            drop(child);
            self.try_exit(current_generation)?;
            return Ok(());
        }
        self.requested_generation
            .store(self.generation, Ordering::Release);
        let pid = child.id();
        let action = (self.graceful_action)(pid);
        if action.is_ok() {
            return Ok(());
        }
        if let Some(status) = child
            .try_wait()
            .map_err(|wait_error| wait_error.to_string())?
        {
            self.cache_observed_status(status)?;
            drop(child);
            self.try_exit(current_generation)?;
        }
        action
    }

    /// 只有直接 CLI 和拥有的完整进程树都消失才确认退出。
    fn has_exited(&self) -> Result<bool, String> {
        Ok(self.observe_child_status()?.is_some() && self.ownership.tree_has_exited()?)
    }

    /// 宽限期结束后终止拥有的进程组或 Job Object。
    fn force_kill_tree(&self) -> Result<(), String> {
        self.ownership.force_kill_tree()
    }

    /// 回收 CLI leader 并保留真实 ExitStatus。
    fn reap(&self) -> Result<(), String> {
        if self.observe_child_status()?.is_none() {
            let status = self
                .child
                .lock()
                .map_err(|_| "CLI child lock poisoned".to_string())?
                .wait()
                .map_err(|error| error.to_string())?;
            *self
                .observed_status
                .lock()
                .map_err(|_| "CLI exit status lock poisoned".to_string())? = Some(status);
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests;
