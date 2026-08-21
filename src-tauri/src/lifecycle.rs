//! Sidecar 生命周期的可测试核心抽象。

use std::thread;
use std::time::{Duration, Instant};

#[cfg(test)]
use std::sync::{Arc, Mutex};

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

/// 确认旧进程树清理成功后才执行替代轮次启动回调。
#[cfg(test)]
pub fn cleanup_then_restart(
    process: Option<&dyn ProcessControl>,
    current_generation: u64,
    graceful_timeout: Duration,
    forced_timeout: Duration,
    restart: impl FnOnce(),
) -> Result<Option<StopOutcome>, String> {
    let outcome = process
        .map(|process| {
            stop_process(
                process,
                current_generation,
                graceful_timeout,
                forced_timeout,
            )
        })
        .transpose()?;
    restart();
    Ok(outcome)
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

/// 测试进程的内部状态。
#[cfg(test)]
#[derive(Default)]
struct FakeProcessState {
    /// 是否已经退出。
    exited: bool,
    /// 是否已经回收。
    reaped: bool,
}

/// 测试用的可控进程树。
#[cfg(test)]
struct FakeProcess {
    /// 是否拒绝优雅停止。
    stubborn: bool,
    /// 是否让强制终止返回错误。
    force_error: bool,
    /// 是否在强制终止后仍报告存活。
    ignores_force: bool,
    /// 是否在强杀前让退出探测返回错误。
    probe_error_before_force: bool,
    /// 是否在强杀后仍让退出探测返回错误。
    probe_error_after_force: bool,
    /// 可断言的调用顺序。
    events: Arc<Mutex<Vec<&'static str>>>,
    /// 当前模拟状态。
    state: Mutex<FakeProcessState>,
}

#[cfg(test)]
impl FakeProcess {
    /// 创建一个具有指定停止行为的测试进程。
    fn new(stubborn: bool, force_error: bool, ignores_force: bool) -> Arc<Self> {
        Arc::new(Self {
            stubborn,
            force_error,
            ignores_force,
            probe_error_before_force: false,
            probe_error_after_force: false,
            events: Arc::new(Mutex::new(Vec::new())),
            state: Mutex::new(FakeProcessState::default()),
        })
    }

    /// 创建一个优雅阶段退出探测失败、强杀后恢复正常的测试进程。
    fn with_graceful_probe_error() -> Arc<Self> {
        Arc::new(Self {
            stubborn: true,
            force_error: false,
            ignores_force: false,
            probe_error_before_force: true,
            probe_error_after_force: false,
            events: Arc::new(Mutex::new(Vec::new())),
            state: Mutex::new(FakeProcessState::default()),
        })
    }

    /// 创建一个始终无法确认退出状态的测试进程。
    fn with_persistent_probe_error() -> Arc<Self> {
        Arc::new(Self {
            stubborn: true,
            force_error: false,
            ignores_force: false,
            probe_error_before_force: true,
            probe_error_after_force: true,
            events: Arc::new(Mutex::new(Vec::new())),
            state: Mutex::new(FakeProcessState::default()),
        })
    }
}

#[cfg(test)]
impl ProcessControl for FakeProcess {
    /// 记录优雅停止，并让普通进程立即退出。
    fn request_graceful_stop(&self, _current_generation: u64) -> Result<(), String> {
        self.events.lock().unwrap().push("graceful");
        if !self.stubborn {
            self.state.lock().unwrap().exited = true;
        }
        Ok(())
    }

    /// 返回测试进程树是否全部退出。
    fn has_exited(&self) -> Result<bool, String> {
        let forced = self.events.lock().unwrap().contains(&"force");
        if (self.probe_error_before_force && !forced) || (self.probe_error_after_force && forced) {
            return Err("graceful probe failed".into());
        }
        Ok(self.state.lock().unwrap().exited)
    }

    /// 记录强杀请求并按配置返回结果。
    fn force_kill_tree(&self) -> Result<(), String> {
        self.events.lock().unwrap().push("force");
        if self.force_error {
            return Err("forced termination failed".into());
        }
        if !self.ignores_force {
            self.state.lock().unwrap().exited = true;
        }
        Ok(())
    }

    /// 记录已经确认退出后的回收动作。
    fn reap(&self) -> Result<(), String> {
        self.events.lock().unwrap().push("reap");
        let mut state = self.state.lock().unwrap();
        if !state.exited {
            return Err("process is still running".into());
        }
        state.reaped = true;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::{
        cleanup_then_restart, stop_process, wait_for_readiness, FakeProcess, ReadinessWaitError,
        StopOutcome,
    };
    use std::cell::Cell;
    use std::rc::Rc;
    use std::sync::{Arc, Mutex};
    use std::time::{Duration, Instant};

    /// 验证普通 CLI 会优雅退出并在返回前完成回收。
    #[test]
    fn graceful_stop_waits_and_reaps() {
        let process = FakeProcess::new(false, false, false);
        assert_eq!(
            stop_process(
                process.as_ref(),
                1,
                Duration::from_millis(10),
                Duration::from_millis(10)
            ),
            Ok(StopOutcome::Graceful)
        );
        assert_eq!(*process.events.lock().unwrap(), ["graceful", "reap"]);
    }

    /// 验证顽固后代会被强杀并在返回前完成回收。
    #[test]
    fn stubborn_descendants_are_force_killed_and_reaped() {
        let process = FakeProcess::new(true, false, false);
        assert_eq!(
            stop_process(
                process.as_ref(),
                1,
                Duration::ZERO,
                Duration::from_millis(10)
            ),
            Ok(StopOutcome::Forced)
        );
        assert_eq!(
            *process.events.lock().unwrap(),
            ["graceful", "force", "reap"]
        );
    }

    /// 验证强杀错误会立即传播且不会进入无界等待。
    #[test]
    fn force_kill_error_is_propagated() {
        let process = FakeProcess::new(true, true, false);
        assert!(stop_process(process.as_ref(), 1, Duration::ZERO, Duration::ZERO).is_err());
        assert_eq!(*process.events.lock().unwrap(), ["graceful", "force"]);
    }

    /// 验证优雅阶段探测失败仍会执行强杀并在确认后完成回收。
    #[test]
    fn graceful_probe_error_still_forces_and_confirms_cleanup() {
        let process = FakeProcess::with_graceful_probe_error();
        assert_eq!(
            stop_process(
                process.as_ref(),
                1,
                Duration::ZERO,
                Duration::from_millis(10)
            ),
            Ok(StopOutcome::Forced)
        );
        assert_eq!(
            *process.events.lock().unwrap(),
            ["graceful", "force", "reap"]
        );
    }

    /// 验证强杀后的探测错误会作为清理失败返回，且强杀确实已经执行。
    #[test]
    fn post_force_probe_error_reports_cleanup_failure() {
        let process = FakeProcess::with_persistent_probe_error();
        assert!(stop_process(process.as_ref(), 1, Duration::ZERO, Duration::ZERO).is_err());
        assert_eq!(*process.events.lock().unwrap(), ["graceful", "force"]);
    }

    /// 验证强杀后仍存活会在确认期限结束后返回错误。
    #[test]
    fn post_kill_confirmation_is_bounded() {
        let process = FakeProcess::new(true, false, true);
        assert!(stop_process(process.as_ref(), 1, Duration::ZERO, Duration::ZERO).is_err());
        assert_eq!(*process.events.lock().unwrap(), ["graceful", "force"]);
    }

    /// 验证 Retry 只有在旧进程回收完成后才执行替代启动。
    #[test]
    fn retry_starts_only_after_confirmed_cleanup() {
        let process = FakeProcess::new(true, false, false);
        let events = Arc::clone(&process.events);
        cleanup_then_restart(
            Some(process.as_ref()),
            2,
            Duration::ZERO,
            Duration::from_millis(10),
            move || events.lock().unwrap().push("restart"),
        )
        .unwrap();
        assert_eq!(
            *process.events.lock().unwrap(),
            ["graceful", "force", "reap", "restart"]
        );
    }

    /// 验证清理失败时不会执行替代启动。
    #[test]
    fn retry_does_not_start_when_cleanup_is_unconfirmed() {
        let process = FakeProcess::new(true, true, false);
        let restarted = Arc::new(Mutex::new(false));
        let restarted_for_callback = Arc::clone(&restarted);
        assert!(cleanup_then_restart(
            Some(process.as_ref()),
            2,
            Duration::ZERO,
            Duration::ZERO,
            move || *restarted_for_callback.lock().unwrap() = true,
        )
        .is_err());
        assert!(!*restarted.lock().unwrap());
    }

    /// 验证 readiness 等待会在 CLI 崩溃后立即失败。
    #[test]
    fn crash_during_listener_wait_is_detected() {
        let probes = Rc::new(Cell::new(0));
        let probes_for_exit = Rc::clone(&probes);
        let result = wait_for_readiness(
            || true,
            move || {
                let current = probes_for_exit.get() + 1;
                probes_for_exit.set(current);
                Ok(current >= 2)
            },
            || Ok(false),
            Instant::now(),
            Duration::from_secs(30),
            Duration::ZERO,
            || {},
        );
        assert_eq!(result, Err(ReadinessWaitError::ProcessExited));
        assert_eq!(probes.get(), 2);
    }

    /// 验证 readiness 探测沿用启动轮次的绝对开始时间，不会在 CLI 启动后重置 prolonged 计时。
    #[test]
    fn readiness_uses_the_attempt_start_time_for_prolonged_state() {
        let probes = Rc::new(Cell::new(0));
        let probes_for_readiness = Rc::clone(&probes);
        let prolonged = Rc::new(Cell::new(false));
        let prolonged_for_callback = Rc::clone(&prolonged);
        let result = wait_for_readiness(
            || true,
            || Ok(false),
            move || {
                let current = probes_for_readiness.get() + 1;
                probes_for_readiness.set(current);
                Ok(current >= 2)
            },
            Instant::now() - Duration::from_secs(1),
            Duration::from_millis(30),
            Duration::ZERO,
            move || prolonged_for_callback.set(true),
        );
        assert_eq!(result, Ok(()));
        assert!(prolonged.get());
    }

    /// 验证 listener 刚就绪时必须再次确认轮次，拒绝 Retry 期间迟到的 HTTP 成功。
    #[test]
    fn readiness_rechecks_generation_before_accepting_listener() {
        let current_checks = Rc::new(Cell::new(0));
        let current_checks_for_probe = Rc::clone(&current_checks);
        let result = wait_for_readiness(
            move || {
                let check = current_checks_for_probe.get() + 1;
                current_checks_for_probe.set(check);
                check == 1
            },
            || Ok(false),
            || Ok(true),
            Instant::now(),
            Duration::from_secs(30),
            Duration::ZERO,
            || {},
        );
        assert_eq!(result, Err(ReadinessWaitError::Cancelled));
        assert_eq!(current_checks.get(), 2);
    }

    /// 验证 listener 刚就绪时必须再次确认 CLI 存活，拒绝与退出竞态的 HTTP 成功。
    #[test]
    fn readiness_rechecks_process_before_accepting_listener() {
        let exit_checks = Rc::new(Cell::new(0));
        let exit_checks_for_probe = Rc::clone(&exit_checks);
        let result = wait_for_readiness(
            || true,
            move || {
                let check = exit_checks_for_probe.get() + 1;
                exit_checks_for_probe.set(check);
                Ok(check == 2)
            },
            || Ok(true),
            Instant::now(),
            Duration::from_secs(30),
            Duration::ZERO,
            || {},
        );
        assert_eq!(result, Err(ReadinessWaitError::ProcessExited));
        assert_eq!(exit_checks.get(), 2);
    }
}
