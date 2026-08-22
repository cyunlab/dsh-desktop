//! Published CLI 生命周期的可测试核心抽象。

use std::thread;
use std::time::{Duration, Instant};

/// 一个由桌面端拥有的进程树控制接口。
pub trait ProcessControl: Send + Sync {
    /// 按调用当下的轮次请求被管理进程优雅地停止。
    fn request_graceful_stop(&self, current_generation: u64) -> Result<(), String>;

    /// 检查直接子进程和拥有的进程树是否已经全部退出。
    fn has_exited(&self) -> Result<bool, String>;

    /// 强制终止被管理进程以及它拥有的整个进程树。
    fn force_kill_tree(&self) -> Result<(), String>;

    /// 回收已经确认退出的直接子进程句柄。
    fn reap(&self) -> Result<(), String>;
}

/// 描述优雅停止或强制回收的最终结果。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StopOutcome {
    /// 进程树在宽限期内自行退出。
    Graceful,
    /// 进程树在宽限期后被强制终止并确认退出。
    Forced,
}

/// 在指定期限内轮询进程树是否已经全部退出。
fn wait_until_exited(process: &dyn ProcessControl, timeout: Duration) -> Result<bool, String> {
    let deadline = Instant::now() + timeout;
    loop {
        if process.has_exited()? {
            return Ok(true);
        }
        if Instant::now() >= deadline {
            return Ok(false);
        }
        thread::sleep(Duration::from_millis(25).min(timeout));
    }
}

/// 先优雅停止、再强杀进程树，并在两个有界期限内确认退出和回收结果。
pub fn stop_process(
    process: &dyn ProcessControl,
    current_generation: u64,
    graceful_timeout: Duration,
    forced_timeout: Duration,
) -> Result<StopOutcome, String> {
    let gracefully_exited = process.request_graceful_stop(current_generation).is_ok()
        && wait_until_exited(process, graceful_timeout).unwrap_or(false);
    if gracefully_exited {
        process.reap()?;
        return Ok(StopOutcome::Graceful);
    }

    process.force_kill_tree()?;
    if !wait_until_exited(process, forced_timeout)? {
        return Err("CLI process tree did not exit after forced termination".into());
    }
    process.reap()?;
    Ok(StopOutcome::Forced)
}

/// readiness 等待可能结束的安全分类。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReadinessWaitError {
    /// 当前启动轮次已被 Retry 或 shutdown 取消。
    Cancelled,
    /// CLI 在客户端页面可访问前已经退出。
    ProcessExited,
    /// 查询进程或 listener 状态时发生内部错误。
    ProbeFailed,
}

/// 从同一启动轮次的绝对起点等待 readiness，同时观察取消、子进程退出和 prolonged 状态。
pub fn wait_for_readiness(
    mut is_current: impl FnMut() -> bool,
    mut child_exited: impl FnMut() -> Result<bool, String>,
    mut listener_ready: impl FnMut() -> Result<bool, String>,
    attempt_started: Instant,
    prolonged_after: Duration,
    poll_interval: Duration,
    mut on_prolonged: impl FnMut(),
) -> Result<(), ReadinessWaitError> {
    let mut prolonged = false;
    loop {
        if !is_current() {
            return Err(ReadinessWaitError::Cancelled);
        }
        if child_exited().map_err(|_| ReadinessWaitError::ProbeFailed)? {
            return Err(ReadinessWaitError::ProcessExited);
        }
        if listener_ready().map_err(|_| ReadinessWaitError::ProbeFailed)? {
            if !is_current() {
                return Err(ReadinessWaitError::Cancelled);
            }
            if child_exited().map_err(|_| ReadinessWaitError::ProbeFailed)? {
                return Err(ReadinessWaitError::ProcessExited);
            }
            return Ok(());
        }
        if !prolonged && attempt_started.elapsed() >= prolonged_after {
            prolonged = true;
            on_prolonged();
        }
        if !poll_interval.is_zero() {
            thread::sleep(poll_interval);
        }
    }
}

#[cfg(test)]
mod tests;
