//! Sidecar 生命周期的可测试核心抽象。

use std::thread;
use std::time::{Duration, Instant};

#[cfg(test)]
use std::sync::{Arc, Mutex};

/// 一个由桌面端拥有的进程树控制接口。
pub trait ProcessControl: Send + Sync {
    /// 请求被管理进程优雅地停止。
    fn request_graceful_stop(&self) -> Result<(), String>;

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
    graceful_timeout: Duration,
    forced_timeout: Duration,
) -> Result<StopOutcome, String> {
    let gracefully_exited = process.request_graceful_stop().is_ok()
        && wait_until_exited(process, graceful_timeout).unwrap_or(false);
    if gracefully_exited {
        process.reap()?;
        return Ok(StopOutcome::Graceful);
    }

    process.force_kill_tree()?;
    if !wait_until_exited(process, forced_timeout)? {
        return Err("sidecar process tree did not exit after forced termination".into());
    }
    process.reap()?;
    Ok(StopOutcome::Forced)
}

/// 确认旧进程树清理成功后才执行替代轮次启动回调。
pub fn cleanup_then_restart(
    process: Option<&dyn ProcessControl>,
    graceful_timeout: Duration,
    forced_timeout: Duration,
    restart: impl FnOnce(),
) -> Result<Option<StopOutcome>, String> {
    let outcome = process
        .map(|process| stop_process(process, graceful_timeout, forced_timeout))
        .transpose()?;
    restart();
    Ok(outcome)
}

/// readiness 等待可能结束的安全分类。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReadinessWaitError {
    /// 当前启动轮次已被 Retry 或 shutdown 取消。
    Cancelled,
    /// sidecar 在 listener 可访问前已经退出。
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

/// 可观察的 sidecar 生命周期事件。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SidecarEvent {
    /// Host 已经报告可访问的 origin。
    Ready(String),
    /// Host 在启动阶段报告了失败。
    StartupFailed,
    /// 监督线程观察到 Host 进程退出。
    Exited,
}

/// 生命周期状态机对 sidecar 事件作出的动作。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LifecycleAction {
    /// 事件不改变当前状态，调用方继续等待。
    Ignore,
    /// 首次 ready，调用方可以导航到 Host。
    Ready(String),
    /// 当前轮次必须清理 sidecar 并展示失败状态。
    Fail,
}

/// 将 sidecar 事件与启动阶段和 ready 阶段的语义隔离开。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum MachineState {
    /// 等待 Host ready 或启动错误。
    Starting,
    /// Host 已经 ready，后续退出属于崩溃。
    Ready,
    /// 本轮已失败，忽略迟到事件。
    Failed,
}

/// 可复用的 sidecar 生命周期状态机。
#[derive(Debug, Clone)]
pub struct LifecycleMachine {
    /// 当前状态。
    state: MachineState,
}

impl LifecycleMachine {
    /// 创建一个等待 sidecar 启动结果的新状态机。
    pub fn new() -> Self {
        Self {
            state: MachineState::Starting,
        }
    }

    /// 消费一个 sidecar 事件并返回桌面端应执行的动作。
    pub fn observe(&mut self, event: SidecarEvent) -> LifecycleAction {
        match (self.state, event) {
            (MachineState::Starting, SidecarEvent::Ready(origin)) => {
                self.state = MachineState::Ready;
                LifecycleAction::Ready(origin)
            }
            (MachineState::Starting, SidecarEvent::StartupFailed | SidecarEvent::Exited) => {
                self.state = MachineState::Failed;
                LifecycleAction::Fail
            }
            (MachineState::Ready, SidecarEvent::Ready(_)) => LifecycleAction::Ignore,
            (MachineState::Ready, SidecarEvent::StartupFailed | SidecarEvent::Exited) => {
                self.state = MachineState::Failed;
                LifecycleAction::Fail
            }
            (MachineState::Failed, _) => LifecycleAction::Ignore,
        }
    }
}

impl Default for LifecycleMachine {
    /// 创建默认的启动中状态机。
    fn default() -> Self {
        Self::new()
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
    fn request_graceful_stop(&self) -> Result<(), String> {
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
        cleanup_then_restart, stop_process, wait_for_readiness, FakeProcess, LifecycleAction,
        LifecycleMachine, ReadinessWaitError, SidecarEvent, StopOutcome,
    };
    use std::cell::Cell;
    use std::rc::Rc;
    use std::sync::{Arc, Mutex};
    use std::time::{Duration, Instant};

    /// 验证启动失败事件会进入失败动作并忽略迟到事件。
    #[test]
    fn startup_failure_is_terminal_for_attempt() {
        let mut machine = LifecycleMachine::new();
        assert_eq!(
            machine.observe(SidecarEvent::StartupFailed),
            LifecycleAction::Fail
        );
        assert_eq!(
            machine.observe(SidecarEvent::Ready("http://127.0.0.1:1234/".into())),
            LifecycleAction::Ignore
        );
    }

    /// 验证 ready 后的进程退出被识别为失败。
    #[test]
    fn crash_after_ready_returns_failure() {
        let mut machine = LifecycleMachine::new();
        assert!(matches!(
            machine.observe(SidecarEvent::Ready("http://127.0.0.1:1234/".into())),
            LifecycleAction::Ready(_)
        ));
        assert_eq!(machine.observe(SidecarEvent::Exited), LifecycleAction::Fail);
    }

    /// 验证普通 sidecar 会优雅退出并在返回前完成回收。
    #[test]
    fn graceful_stop_waits_and_reaps() {
        let process = FakeProcess::new(false, false, false);
        assert_eq!(
            stop_process(
                process.as_ref(),
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
            stop_process(process.as_ref(), Duration::ZERO, Duration::from_millis(10)),
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
        assert!(stop_process(process.as_ref(), Duration::ZERO, Duration::ZERO).is_err());
        assert_eq!(*process.events.lock().unwrap(), ["graceful", "force"]);
    }

    /// 验证优雅阶段探测失败仍会执行强杀并在确认后完成回收。
    #[test]
    fn graceful_probe_error_still_forces_and_confirms_cleanup() {
        let process = FakeProcess::with_graceful_probe_error();
        assert_eq!(
            stop_process(process.as_ref(), Duration::ZERO, Duration::from_millis(10)),
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
        assert!(stop_process(process.as_ref(), Duration::ZERO, Duration::ZERO).is_err());
        assert_eq!(*process.events.lock().unwrap(), ["graceful", "force"]);
    }

    /// 验证强杀后仍存活会在确认期限结束后返回错误。
    #[test]
    fn post_kill_confirmation_is_bounded() {
        let process = FakeProcess::new(true, false, true);
        assert!(stop_process(process.as_ref(), Duration::ZERO, Duration::ZERO).is_err());
        assert_eq!(*process.events.lock().unwrap(), ["graceful", "force"]);
    }

    /// 验证 Retry 只有在旧进程回收完成后才执行替代启动。
    #[test]
    fn retry_starts_only_after_confirmed_cleanup() {
        let process = FakeProcess::new(true, false, false);
        let events = Arc::clone(&process.events);
        cleanup_then_restart(
            Some(process.as_ref()),
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
            Duration::ZERO,
            Duration::ZERO,
            move || *restarted_for_callback.lock().unwrap() = true,
        )
        .is_err());
        assert!(!*restarted.lock().unwrap());
    }

    /// 验证 listener 等待会在 sidecar 崩溃后立即失败。
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

    /// 验证 readiness 探测沿用启动轮次的绝对开始时间，不会在 sidecar ready 后重置 prolonged 计时。
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
}
