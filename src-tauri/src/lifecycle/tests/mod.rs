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
