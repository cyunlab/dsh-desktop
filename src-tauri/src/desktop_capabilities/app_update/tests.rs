use super::*;
use std::cell::Cell;
use std::rc::Rc;

#[derive(Clone)]
/// 测试用的可共享单调时钟。
struct TestClock(Rc<Cell<Duration>>);

impl Clock for TestClock {
    /// 返回测试控制的单调时间。
    fn now(&self) -> Duration {
        self.0.get()
    }
}

#[derive(Clone, Default)]
/// 测试用的可跨 Controller 重建共享偏好存储。
struct MemoryPreferences(Rc<Cell<Option<bool>>>);

impl PreferenceStore for MemoryPreferences {
    /// 读取测试内存中的自动下载偏好。
    fn load_automatic_download(&self) -> Result<Option<bool>, PreferenceError> {
        Ok(self.0.get())
    }

    /// 保存测试内存中的自动下载偏好。
    fn save_automatic_download(&mut self, enabled: bool) -> Result<(), PreferenceError> {
        self.0.set(Some(enabled));
        Ok(())
    }
}

/// 创建可控制时钟的测试领域控制器。
fn controller(preference: Option<bool>) -> UpdateController<TestClock, MemoryPreferences> {
    UpdateController::new(
        "2.0.15",
        TestClock(Rc::new(Cell::new(Duration::from_secs(10)))),
        MemoryPreferences(Rc::new(Cell::new(preference))),
    )
    .unwrap()
}

/// 创建用于检查结果的可信 Stable 发布。
fn release(version: &str) -> StableRelease {
    StableRelease {
        version: version.to_owned(),
        release_notes: "修复启动问题".to_owned(),
    }
}

/// Ready 后立即检查并安排六小时后的下一次检查。
#[test]
fn ready_starts_check_and_schedules_six_hour_interval() {
    let output = controller(None).handle(UpdateInput::Ready).unwrap();
    assert_eq!(output.snapshot.sequence, 1);
    assert_eq!(output.snapshot.state, UpdateState::Checking);
    assert_eq!(
        output.snapshot.next_check_at,
        Some(Duration::from_secs(21_610))
    );
    assert_eq!(
        output.effects,
        vec![
            UpdateEffect::CheckStable,
            UpdateEffect::ScheduleCheck {
                after: Duration::from_secs(21_600)
            },
        ]
    );
}

/// 手动检查使用同一 Stable 检查策略。
#[test]
fn manual_check_is_available_independently_of_ready_schedule() {
    let output = controller(None).handle(UpdateInput::ManualCheck).unwrap();
    assert_eq!(output.snapshot.state, UpdateState::Checking);
    assert_eq!(output.effects, vec![UpdateEffect::CheckStable]);
}

/// 周期计时器到期会继续检查并刷新下一次六小时计划。
#[test]
fn periodic_timer_continues_the_six_hour_schedule() {
    let mut controller = controller(None);
    controller.handle(UpdateInput::Ready).unwrap();

    let output = controller.handle(UpdateInput::PeriodicCheckDue).unwrap();

    assert_eq!(output.snapshot.sequence, 2);
    assert_eq!(output.snapshot.state, UpdateState::Checking);
    assert!(output.effects.is_empty());
}

/// 检查或下载进行中时重复触发不会启动重叠更新操作。
#[test]
fn overlapping_update_triggers_are_ignored() {
    let mut controller = controller(None);
    controller.handle(UpdateInput::Ready).unwrap();
    for input in [
        UpdateInput::Ready,
        UpdateInput::PeriodicCheckDue,
        UpdateInput::ManualCheck,
    ] {
        assert!(controller.handle(input).unwrap().effects.is_empty());
    }
    controller
        .handle(UpdateInput::CheckSucceeded {
            release: Some(release("2.1.0")),
        })
        .unwrap();
    controller.handle(UpdateInput::DownloadStarted).unwrap();
    assert!(controller
        .handle(UpdateInput::ManualCheck)
        .unwrap()
        .effects
        .is_empty());
}

/// Ready 之前到达的周期信号不会启动后台调度。
#[test]
fn periodic_schedule_does_not_start_before_ready() {
    let output = controller(None)
        .handle(UpdateInput::PeriodicCheckDue)
        .unwrap();

    assert_eq!(output.snapshot.state, UpdateState::Idle);
    assert!(output.effects.is_empty());
}

/// 进程重启恢复的可信 staging 版本会立即重新呈现为待安装状态。
#[test]
fn recovered_staging_is_visible_before_network_check() {
    let output = controller(None)
        .handle(UpdateInput::RecoverStaged {
            version: "2.1.0".into(),
        })
        .unwrap();
    assert_eq!(
        output.snapshot.state,
        UpdateState::Staged {
            version: "2.1.0".into(),
            release_notes: String::new()
        }
    );
    assert!(output.effects.is_empty());
}

/// 已恢复的 staging 不会被同版本 Stable 重复下载或被检查失败遮盖。
#[test]
fn recovered_staging_remains_the_actionable_state() {
    let mut controller = controller(None);
    controller
        .handle(UpdateInput::RecoverStaged {
            version: "2.1.0".into(),
        })
        .unwrap();
    for version in ["2.1.0", "2.0.16"] {
        let same_or_older = controller
            .handle(UpdateInput::CheckSucceeded {
                release: Some(release(version)),
            })
            .unwrap();
        assert_eq!(
            same_or_older.snapshot.state,
            UpdateState::Staged {
                version: "2.1.0".into(),
                release_notes: String::new()
            }
        );
        assert!(same_or_older.effects.is_empty());
    }
    let failed = controller
        .handle(UpdateInput::CheckFailed {
            message: "offline".into(),
            retryable: true,
        })
        .unwrap();
    assert_eq!(
        failed.snapshot.state,
        UpdateState::Staged {
            version: "2.1.0".into(),
            release_notes: String::new()
        }
    );
}

/// 新 Stable 会先请求丢弃旧 staging，且下载失败后不会恢复旧版本。
#[test]
fn newer_stable_discards_old_staging_before_download() {
    let mut controller = controller(None);
    controller
        .handle(UpdateInput::RecoverStaged {
            version: "2.1.0".into(),
        })
        .unwrap();
    let discovered = controller
        .handle(UpdateInput::CheckSucceeded {
            release: Some(release("2.2.0")),
        })
        .unwrap();
    assert_eq!(
        discovered.effects,
        vec![
            UpdateEffect::DiscardOlderStaged {
                replacement_version: "2.2.0".into(),
            },
            UpdateEffect::StartDownload {
                release: release("2.2.0"),
            },
        ]
    );
    let failed = controller
        .handle(UpdateInput::DownloadFailed {
            message: "offline".into(),
            retryable: false,
        })
        .unwrap();
    assert!(matches!(failed.snapshot.state, UpdateState::Failed { .. }));
}

/// 等于或低于当前版本的结果均不会触发自动下载。
#[test]
fn check_result_never_downgrades_or_reinstalls_current_version() {
    for version in ["2.0.14", "2.0.15"] {
        let output = controller(None)
            .handle(UpdateInput::CheckSucceeded {
                release: Some(release(version)),
            })
            .unwrap();
        assert_eq!(output.snapshot.state, UpdateState::UpToDate);
        assert!(output.effects.is_empty());
    }
}

/// 自动下载默认开启并在发现新 Stable 后请求可信 Adapter 下载。
#[test]
fn automatic_download_defaults_to_enabled() {
    let output = controller(None)
        .handle(UpdateInput::CheckSucceeded {
            release: Some(release("2.1.0")),
        })
        .unwrap();
    assert!(output.snapshot.automatic_download);
    assert!(matches!(
        output.snapshot.state,
        UpdateState::Available { .. }
    ));
    assert_eq!(
        output.effects,
        vec![UpdateEffect::StartDownload {
            release: release("2.1.0")
        }]
    );
}

/// 关闭自动下载会被持久化且不会隐藏可用版本。
#[test]
fn disabled_automatic_download_keeps_update_available() {
    let preferences = MemoryPreferences::default();
    let mut controller = UpdateController::new(
        "2.0.15",
        TestClock(Rc::new(Cell::new(Duration::ZERO))),
        preferences.clone(),
    )
    .unwrap();
    controller
        .handle(UpdateInput::SetAutomaticDownload(false))
        .unwrap();
    let output = controller
        .handle(UpdateInput::CheckSucceeded {
            release: Some(release("2.1.0")),
        })
        .unwrap();
    assert!(!output.snapshot.automatic_download);
    assert!(matches!(
        output.snapshot.state,
        UpdateState::Available { .. }
    ));
    assert!(output.effects.is_empty());
    let restarted = UpdateController::new(
        "2.0.15",
        TestClock(Rc::new(Cell::new(Duration::ZERO))),
        preferences,
    )
    .unwrap();
    assert!(!restarted.snapshot().automatic_download);
}

/// 下载进度完整表达未知总量与已知总量两种形式。
#[test]
fn download_progress_supports_unknown_and_known_totals() {
    let mut controller = controller(None);
    controller
        .handle(UpdateInput::CheckSucceeded {
            release: Some(release("2.1.0")),
        })
        .unwrap();
    let unknown = controller
        .handle(UpdateInput::DownloadAdvanced(
            DownloadProgress::UnknownTotal {
                downloaded_bytes: 512,
            },
        ))
        .unwrap();
    let known = controller
        .handle(UpdateInput::DownloadAdvanced(
            DownloadProgress::KnownTotal {
                downloaded_bytes: 1024,
                total_bytes: 4096,
            },
        ))
        .unwrap();
    assert!(matches!(
        unknown.snapshot.state,
        UpdateState::Downloading {
            progress: DownloadProgress::UnknownTotal {
                downloaded_bytes: 512
            },
            ..
        }
    ));
    assert!(matches!(
        known.snapshot.state,
        UpdateState::Downloading {
            progress: DownloadProgress::KnownTotal {
                downloaded_bytes: 1024,
                total_bytes: 4096
            },
            ..
        }
    ));
    assert_eq!(known.snapshot.sequence, unknown.snapshot.sequence + 1);
}

/// 网络失败只安排三次一、二、四秒自动重试，耗尽后保持可手动重试。
#[test]
fn retryable_network_failure_has_three_bounded_exponential_retries() {
    let mut controller = controller(None);
    let mut delays = Vec::new();
    for _ in 0..4 {
        let output = controller
            .handle(UpdateInput::CheckFailed {
                message: "network unavailable".to_owned(),
                retryable: true,
            })
            .unwrap();
        delays.extend(
            output
                .effects
                .into_iter()
                .filter_map(|effect| match effect {
                    UpdateEffect::ScheduleRetry { after, .. } => Some(after),
                    _ => None,
                }),
        );
    }
    assert_eq!(
        delays,
        vec![
            Duration::from_secs(1),
            Duration::from_secs(2),
            Duration::from_secs(4)
        ]
    );
    assert!(matches!(
        controller.snapshot().state,
        UpdateState::Failed {
            retryable: true,
            ..
        }
    ));
}

/// 下载重试只重放已记录发布且不会接受外部 URL、路径或签名。
#[test]
fn download_retry_reuses_the_trusted_release_context() {
    let mut controller = controller(None);
    controller
        .handle(UpdateInput::CheckSucceeded {
            release: Some(release("2.1.0")),
        })
        .unwrap();
    controller.handle(UpdateInput::DownloadStarted).unwrap();
    controller
        .handle(UpdateInput::DownloadFailed {
            message: "connection reset".to_owned(),
            retryable: true,
        })
        .unwrap();

    let output = controller.handle(UpdateInput::RetryDue).unwrap();

    assert_eq!(
        output.effects,
        vec![UpdateEffect::StartDownload {
            release: release("2.1.0"),
        }]
    );
}

/// 检查失败作为可观察状态返回，不会成为阻塞启动的领域错误。
#[test]
fn failed_check_is_a_non_blocking_snapshot() {
    let output = controller(None)
        .handle(UpdateInput::CheckFailed {
            message: "offline".to_owned(),
            retryable: false,
        })
        .unwrap();
    assert_eq!(
        output.snapshot.state,
        UpdateState::Failed {
            operation: UpdateOperation::Check,
            retryable: false,
            message: "offline".to_owned(),
        }
    );
}

/// 已下载发布进入 staged 完整快照。
#[test]
fn completed_download_becomes_staged() {
    let mut controller = controller(None);
    controller
        .handle(UpdateInput::CheckSucceeded {
            release: Some(release("2.1.0")),
        })
        .unwrap();
    let output = controller.handle(UpdateInput::DownloadSucceeded).unwrap();
    assert_eq!(
        output.snapshot.state,
        UpdateState::Staged {
            version: "2.1.0".to_owned(),
            release_notes: "修复启动问题".to_owned(),
        }
    );
}
