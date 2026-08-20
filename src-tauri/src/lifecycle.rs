//! Sidecar 生命周期的可测试核心抽象。

use std::thread;
use std::time::{Duration, Instant};

#[cfg(test)]
use std::sync::{Arc, Mutex};

/// 一个由桌面端拥有的进程树控制接口。
pub trait ProcessControl: Send + Sync {
    /// 请求被管理进程优雅地停止。
    fn request_graceful_stop(&self) -> Result<(), String>;

    /// 检查被管理进程是否已经退出。
    fn has_exited(&self) -> Result<bool, String>;

    /// 强制终止被管理进程以及它拥有的整个进程树。
    fn force_kill_tree(&self) -> Result<(), String>;

    /// 等待并回收被管理进程的退出句柄。
    fn reap(&self) -> Result<(), String>;
}

/// 描述优雅停止或强制回收的最终结果。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StopOutcome {
    /// 进程在宽限期内自行退出。
    Graceful,
    /// 进程在宽限期后被强制终止并回收。
    Forced,
}

/// 先优雅停止、再强制终止整个进程树，并在返回前等待和回收子进程。
pub fn stop_process(process: &dyn ProcessControl, graceful_timeout: Duration) -> StopOutcome {
    let graceful_requested = process.request_graceful_stop().is_ok();
    let deadline = Instant::now() + graceful_timeout;
    loop {
        if process.has_exited().unwrap_or(false) {
            reap_until_complete(process);
            return if graceful_requested {
                StopOutcome::Graceful
            } else {
                StopOutcome::Forced
            };
        }
        if Instant::now() >= deadline {
            break;
        }
        thread::sleep(Duration::from_millis(25));
    }

    let mut force_requested_at: Option<Instant> = None;
    loop {
        if process.has_exited().unwrap_or(false) {
            reap_until_complete(process);
            return StopOutcome::Forced;
        }
        if force_requested_at.is_none_or(|last| last.elapsed() >= Duration::from_secs(1)) {
            let _ = process.force_kill_tree();
            force_requested_at = Some(Instant::now());
        }
        thread::sleep(Duration::from_millis(25));
    }
}

/// 在生命周期函数返回前持续回收进程句柄，避免遗留僵尸进程或未完成的等待。
fn reap_until_complete(process: &dyn ProcessControl) {
    while process.reap().is_err() {
        thread::sleep(Duration::from_millis(25));
    }
}

/// 可观察的 sidecar 生命周期事件。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SidecarEvent {
    /// Host 已经报告可访问的 origin。
    Ready(String),
    /// Host 在启动阶段报告了失败。
    StartupFailed(String),
    /// Host 主动报告已停止。
    Stopped,
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
    Fail(String),
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
            (MachineState::Starting, SidecarEvent::StartupFailed(error)) => {
                self.state = MachineState::Failed;
                LifecycleAction::Fail(error)
            }
            (MachineState::Starting, SidecarEvent::Stopped) => {
                self.state = MachineState::Failed;
                LifecycleAction::Fail("Host stopped before becoming ready".into())
            }
            (MachineState::Starting, SidecarEvent::Exited) => {
                self.state = MachineState::Failed;
                LifecycleAction::Fail("Host exited before becoming ready".into())
            }
            (MachineState::Ready, SidecarEvent::Ready(_)) => LifecycleAction::Ignore,
            (MachineState::Ready, SidecarEvent::StartupFailed(error)) => {
                self.state = MachineState::Failed;
                LifecycleAction::Fail(error)
            }
            (MachineState::Ready, SidecarEvent::Stopped | SidecarEvent::Exited) => {
                self.state = MachineState::Failed;
                LifecycleAction::Fail("Host exited unexpectedly after becoming ready".into())
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

/// 测试用的可控 sidecar 事件源，允许覆盖启动和崩溃边界。
#[cfg(test)]
struct ControllableSidecar {
    /// 按顺序返回的事件。
    events: std::collections::VecDeque<SidecarEvent>,
}

#[cfg(test)]
impl ControllableSidecar {
    /// 创建由测试指定事件序列的 sidecar。
    fn new(events: impl IntoIterator<Item = SidecarEvent>) -> Self {
        Self {
            events: events.into_iter().collect(),
        }
    }

    /// 返回下一个可控事件，模拟 stdout 生命周期消息。
    fn next_event(&mut self) -> Option<SidecarEvent> {
        self.events.pop_front()
    }
}

/// 测试用的进程树控制器，能够模拟优雅退出和顽固后代。
#[cfg(test)]
#[derive(Default)]
struct FakeProcess {
    /// 是否收到优雅停止请求。
    graceful_requested: Mutex<bool>,
    /// 是否收到整棵树的强制终止请求。
    force_requested: Mutex<bool>,
    /// 是否模拟顽固的后代进程。
    stubborn_descendants: bool,
    /// 是否已经退出。
    exited: Mutex<bool>,
    /// 是否已经回收句柄。
    reaped: Mutex<bool>,
}

#[cfg(test)]
impl FakeProcess {
    /// 创建一个可配置是否拒绝优雅退出的测试进程。
    fn new(stubborn_descendants: bool) -> Arc<Self> {
        Arc::new(Self {
            stubborn_descendants,
            ..Self::default()
        })
    }
}

#[cfg(test)]
impl ProcessControl for FakeProcess {
    /// 记录优雅停止请求，并让非顽固进程立即变为已退出。
    fn request_graceful_stop(&self) -> Result<(), String> {
        *self.graceful_requested.lock().unwrap() = true;
        if !self.stubborn_descendants {
            *self.exited.lock().unwrap() = true;
        }
        Ok(())
    }

    /// 返回测试进程的退出状态。
    fn has_exited(&self) -> Result<bool, String> {
        Ok(*self.exited.lock().unwrap())
    }

    /// 记录强制终止整棵树，并标记进程退出。
    fn force_kill_tree(&self) -> Result<(), String> {
        *self.force_requested.lock().unwrap() = true;
        *self.exited.lock().unwrap() = true;
        Ok(())
    }

    /// 只有已退出的测试进程才允许被回收。
    fn reap(&self) -> Result<(), String> {
        if !*self.exited.lock().unwrap() {
            return Err("process is still running".into());
        }
        *self.reaped.lock().unwrap() = true;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::{
        stop_process, ControllableSidecar, FakeProcess, LifecycleAction, LifecycleMachine,
        SidecarEvent, StopOutcome,
    };
    use std::time::Duration;

    /// 验证启动失败事件会进入失败动作并忽略迟到事件。
    #[test]
    fn startup_failure_is_terminal_for_attempt() {
        let mut source = ControllableSidecar::new([
            SidecarEvent::StartupFailed("missing dependency".into()),
            SidecarEvent::Ready("http://127.0.0.1:1234/".into()),
        ]);
        let mut machine = LifecycleMachine::new();
        assert_eq!(
            machine.observe(source.next_event().unwrap()),
            LifecycleAction::Fail("missing dependency".into())
        );
        assert_eq!(
            machine.observe(source.next_event().unwrap()),
            LifecycleAction::Ignore
        );
    }

    /// 验证没有事件的延迟启动不会伪造 ready，随后真实 ready 才允许导航。
    #[test]
    fn delayed_readiness_waits_until_ready() {
        let mut source = ControllableSidecar::new([]);
        let mut machine = LifecycleMachine::new();
        assert!(source.next_event().is_none());
        source
            .events
            .push_back(SidecarEvent::Ready("http://127.0.0.1:1234/".into()));
        assert_eq!(
            machine.observe(source.next_event().unwrap()),
            LifecycleAction::Ready("http://127.0.0.1:1234/".into())
        );
    }

    /// 验证 ready 后的进程退出被识别为崩溃，而不是正常停止。
    #[test]
    fn crash_after_ready_returns_failure() {
        let mut source = ControllableSidecar::new([
            SidecarEvent::Ready("http://127.0.0.1:1234/".into()),
            SidecarEvent::Exited,
        ]);
        let mut machine = LifecycleMachine::new();
        assert!(matches!(
            machine.observe(source.next_event().unwrap()),
            LifecycleAction::Ready(_)
        ));
        assert_eq!(
            machine.observe(source.next_event().unwrap()),
            LifecycleAction::Fail("Host exited unexpectedly after becoming ready".into())
        );
    }

    /// 验证普通 sidecar 会优雅退出并在 stop 返回前完成回收。
    #[test]
    fn graceful_stop_waits_and_reaps() {
        let process = FakeProcess::new(false);
        assert_eq!(
            stop_process(process.as_ref(), Duration::from_millis(100)),
            StopOutcome::Graceful
        );
        assert!(*process.graceful_requested.lock().unwrap());
        assert!(!*process.force_requested.lock().unwrap());
        assert!(*process.reaped.lock().unwrap());
    }

    /// 验证顽固后代会触发整棵进程树强杀，并且不会提前返回。
    #[test]
    fn stubborn_descendants_are_force_killed_and_reaped() {
        let process = FakeProcess::new(true);
        assert_eq!(
            stop_process(process.as_ref(), Duration::from_millis(1)),
            StopOutcome::Forced
        );
        assert!(*process.graceful_requested.lock().unwrap());
        assert!(*process.force_requested.lock().unwrap());
        assert!(*process.reaped.lock().unwrap());
    }
}
