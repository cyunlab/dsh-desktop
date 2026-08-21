//! 官方 `dsh web` CLI 的命令构造与进程树监督边界。

use crate::lifecycle::{stop_process, ProcessControl, StopOutcome};
use serde::Deserialize;
use std::ffi::OsString;
use std::fs;
use std::io;
use std::net::{Ipv4Addr, SocketAddrV4, TcpListener};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

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

pub(crate) const HOST_ADDRESS: &str = "127.0.0.1";
pub(crate) const HOST_PORT: u16 = 3080;
pub(crate) const HOST_ORIGIN: &str = "http://127.0.0.1:3080/";
const PINNED_DSH_VERSION: &str = "0.1.0-rc.6";

/// 描述构造官方 CLI 命令所需的全部路径。
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct CliCommandPlan {
    node_executable: PathBuf,
    cli_entry: PathBuf,
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
            .args(["web", "--host", HOST_ADDRESS, "--port"])
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

/// 描述一个由 Desktop 拥有的 CLI 进程树。
pub(crate) struct CliProcess {
    generation: u64,
    child: Mutex<Child>,
    ownership: ProcessOwnership,
    requested_generation: AtomicU64,
    observed_status: Mutex<Option<ExitStatus>>,
    classified_reason: Mutex<Option<ExitReason>>,
    stop_lock: Mutex<()>,
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
    if process_generation != current_generation {
        ExitReason::StaleGeneration
    } else if requested_generation == Some(process_generation) {
        ExitReason::Requested
    } else {
        ExitReason::Unexpected
    }
}

/// 返回继承环境中大小写兼容的 PATH 值。
fn inherited_path() -> Option<OsString> {
    std::env::vars_os().find_map(|(name, value)| {
        name.to_string_lossy()
            .eq_ignore_ascii_case("path")
            .then_some(value)
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
    let path = prepend_node_path(&node_executable, inherited_path())?;
    Ok(CliCommandPlan {
        node_executable,
        cli_entry,
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
    fn attach(pid: u32) -> Result<Self, String> {
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
        let process = unsafe {
            OpenProcess(
                PROCESS_SET_QUOTA | PROCESS_TERMINATE | PROCESS_QUERY_LIMITED_INFORMATION,
                0,
                pid,
            )
        };
        if process.is_null() {
            unsafe { CloseHandle(job) };
            return Err("failed to open suspended CLI process".into());
        }
        let assigned = unsafe { AssignProcessToJobObject(job, process) != 0 };
        unsafe { CloseHandle(process) };
        if !assigned {
            unsafe { CloseHandle(job) };
            return Err("failed to assign CLI process to Job Object".into());
        }
        Ok(Self { job: job as isize })
    }

    /// Job 接管完成后恢复新 CLI 的初始线程。
    fn resume_suspended(&self, pid: u32) -> Result<(), String> {
        let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0) };
        if snapshot == INVALID_HANDLE_VALUE {
            return Err("failed to enumerate suspended CLI threads".into());
        }
        let mut entry: THREADENTRY32 = unsafe { std::mem::zeroed() };
        entry.dwSize = std::mem::size_of::<THREADENTRY32>() as u32;
        let mut found = false;
        let mut has_entry = unsafe { Thread32First(snapshot, &mut entry) != 0 };
        while has_entry {
            if entry.th32OwnerProcessID == pid {
                let handle = unsafe { OpenThread(THREAD_SUSPEND_RESUME, 0, entry.th32ThreadID) };
                if handle.is_null() {
                    unsafe { CloseHandle(snapshot) };
                    return Err("failed to open suspended CLI thread".into());
                }
                let resumed = unsafe { ResumeThread(handle) };
                unsafe { CloseHandle(handle) };
                if resumed == u32::MAX {
                    unsafe { CloseHandle(snapshot) };
                    return Err("failed to resume suspended CLI thread".into());
                }
                found = true;
            }
            has_entry = unsafe { Thread32Next(snapshot, &mut entry) != 0 };
        }
        unsafe { CloseHandle(snapshot) };
        found
            .then_some(())
            .ok_or_else(|| "suspended CLI thread was not found".into())
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
    fn attach(pid: u32) -> Result<Self, String> {
        Ok(Self { pgid: pid as i32 })
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
    fn attach(_pid: u32) -> Result<Self, String> {
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
fn terminate_unowned_child(child: &mut Child) -> Result<(), String> {
    child.kill().map_err(|error| error.to_string())?;
    child.wait().map(|_| ()).map_err(|error| error.to_string())
}

/// 在非 Windows 接管失败时终止尚未暴露给调用方的 CLI。
#[cfg(not(windows))]
fn terminate_unowned_child(child: &mut Child) -> Result<(), String> {
    child.kill().map_err(|error| error.to_string())?;
    child.wait().map(|_| ()).map_err(|error| error.to_string())
}

/// 创建进程组/Job Object 并启动一条已经准备好的命令。
fn spawn_owned_command(
    mut command: Command,
    generation: u64,
    preflight: impl FnOnce() -> io::Result<()>,
) -> Result<Arc<CliProcess>, SupervisorError> {
    #[cfg(windows)]
    command.creation_flags(CREATE_NEW_PROCESS_GROUP | CREATE_SUSPENDED);
    #[cfg(unix)]
    command.process_group(0);
    if let Err(error) = preflight() {
        return Err(if error.kind() == io::ErrorKind::AddrInUse {
            SupervisorError::PortConflict
        } else {
            SupervisorError::PreflightFailed
        });
    }
    let mut child = command.spawn().map_err(|_| SupervisorError::SpawnFailed)?;
    let ownership = match ProcessOwnership::attach(child.id()) {
        Ok(ownership) => ownership,
        Err(_) => {
            return Err(if terminate_unowned_child(&mut child).is_ok() {
                SupervisorError::SpawnFailed
            } else {
                SupervisorError::CleanupFailed
            });
        }
    };
    #[cfg(windows)]
    if ownership.resume_suspended(child.id()).is_err() {
        let cleanup = ownership
            .force_kill_tree()
            .and_then(|_| child.wait().map(|_| ()).map_err(|error| error.to_string()));
        return Err(if cleanup.is_ok() {
            SupervisorError::SpawnFailed
        } else {
            SupervisorError::CleanupFailed
        });
    }
    Ok(Arc::new(CliProcess {
        generation,
        child: Mutex::new(child),
        ownership,
        requested_generation: AtomicU64::new(0),
        observed_status: Mutex::new(None),
        classified_reason: Mutex::new(None),
        stop_lock: Mutex::new(()),
    }))
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
            classify_exit(
                self.generation,
                current_generation,
                match self.requested_generation.load(Ordering::Acquire) {
                    0 => None,
                    generation => Some(generation),
                },
            )
        });
        Ok(Some(ProcessExit { status, reason }))
    }
}

impl ProcessControl for CliProcess {
    /// Unix 仅向 CLI leader 发送 SIGTERM；Windows 本票交由 Job fallback。
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
        #[cfg(unix)]
        {
            if current_generation == self.generation {
                self.requested_generation
                    .store(current_generation, Ordering::Release);
            }
            let pid = child.id() as i32;
            let result = unsafe { libc::kill(pid, libc::SIGTERM) };
            if result == 0 {
                return Ok(());
            }
            let error = std::io::Error::last_os_error();
            if error.raw_os_error() == Some(libc::ESRCH) {
                if let Some(status) = child
                    .try_wait()
                    .map_err(|wait_error| wait_error.to_string())?
                {
                    self.cache_observed_status(status)?;
                    drop(child);
                    self.try_exit(current_generation)?;
                }
                Ok(())
            } else {
                if current_generation == self.generation {
                    let _ = self.requested_generation.compare_exchange(
                        current_generation,
                        0,
                        Ordering::AcqRel,
                        Ordering::Acquire,
                    );
                }
                Err(format!("failed to signal CLI leader {pid}: {error}"))
            }
        }
        #[cfg(windows)]
        {
            Err("Windows graceful Ctrl+C is implemented by issue #50".into())
        }
        #[cfg(not(any(unix, windows)))]
        {
            Err("graceful CLI shutdown is unavailable on this platform".into())
        }
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
mod tests {
    use super::{
        classify_exit, preflight_address, prepend_node_path, resolve_dsh_cli_entry,
        spawn_owned_command, CliCommandPlan, ExitReason, SupervisorError, HOST_ADDRESS,
    };
    #[cfg(unix)]
    use crate::lifecycle::StopOutcome;
    use std::ffi::{OsStr, OsString};
    use std::fs;
    use std::io;
    use std::net::{Ipv4Addr, TcpListener};
    use std::path::{Path, PathBuf};
    use std::process::{Command, Stdio};
    #[cfg(unix)]
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::thread;
    use std::time::Duration;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[cfg(unix)]
    static HELPER_SHUTDOWN_REQUESTED: AtomicBool = AtomicBool::new(false);

    /// POSIX helper 的信号处理器只设置原子标志，实际清理留在普通控制流。
    #[cfg(unix)]
    extern "C" fn request_helper_shutdown(_signal: i32) {
        HELPER_SHUTDOWN_REQUESTED.store(true, Ordering::Release);
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
            .any(|(name, value)| *name == OsStr::new("PATH")
                && *value == Some(plan.path.as_os_str())));
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
        assert_eq!(classify_exit(7, 8, None), ExitReason::StaleGeneration);
        assert_eq!(classify_exit(7, 7, None), ExitReason::Unexpected);
        assert_eq!(classify_exit(7, 8, Some(8)), ExitReason::StaleGeneration);
    }

    /// 验证 PATH 缺失时仍能提供仅包含官方 Node 的有效值。
    #[test]
    fn constructs_path_without_parent_value() {
        let path =
            prepend_node_path(Path::new("/desktop/node/bin/node"), None::<OsString>).unwrap();
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
    fn wait_for_exit(process: &super::CliProcess, generation: u64) -> super::ProcessExit {
        for _ in 0..200 {
            if let Some(exit) = process.try_exit(generation).unwrap() {
                return exit;
            }
            thread::sleep(Duration::from_millis(10));
        }
        panic!("CLI process did not exit");
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
        thread::sleep(Duration::from_millis(100));
        let report = process
            .stop(11, Duration::from_secs(1), Duration::from_secs(1))
            .unwrap();
        let exit = report.exit.unwrap();
        assert_eq!(exit.status.code(), Some(17));
        assert_eq!(exit.reason, ExitReason::Unexpected);
        assert_eq!(wait_for_exit(&process, 12).reason, ExitReason::Unexpected);
    }

    /// 验证 generation 推进后的真实 stop seam 把旧进程退出分类为 stale。
    #[cfg(unix)]
    #[test]
    fn stop_classifies_active_process_from_stale_generation() {
        let mut command = Command::new("/bin/sh");
        command
            .args(["-c", "exec sleep 60"])
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        let process = spawn_owned_command(command, 12, || Ok(())).unwrap();
        let report = process
            .stop(13, Duration::from_secs(2), Duration::from_secs(1))
            .unwrap();
        assert_eq!(report.exit.unwrap().reason, ExitReason::StaleGeneration);
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
        let mut command = Command::new("/bin/sh");
        command
            .args(["-c", "trap '' TERM; sleep 60 & wait"])
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        let process = spawn_owned_command(command, 22, || Ok(())).unwrap();
        let report = process
            .stop(22, Duration::ZERO, Duration::from_secs(2))
            .unwrap();
        assert_eq!(report.outcome, StopOutcome::Forced);
        assert_eq!(report.exit.unwrap().reason, ExitReason::Requested);
    }
}
