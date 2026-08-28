pub mod staging;

use semver::Version;
use serde::Serialize;
use std::fmt;
use std::time::Duration;

const CHECK_INTERVAL: Duration = Duration::from_secs(6 * 60 * 60);
const MAX_AUTOMATIC_RETRIES: u8 = 3;

/// 为更新调度提供可替换的单调时钟边界。
pub trait Clock {
    /// 返回自任意固定起点以来经过的单调时间。
    fn now(&self) -> Duration;
}

/// 为自动下载设置提供最小持久化边界。
pub trait PreferenceStore {
    /// 读取自动下载设置；缺失表示采用默认值。
    fn load_automatic_download(&self) -> Result<Option<bool>, PreferenceError>;

    /// 持久化自动下载设置。
    fn save_automatic_download(&mut self, enabled: bool) -> Result<(), PreferenceError>;
}

/// 描述偏好存储边界的稳定错误。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PreferenceError(pub String);

/// 将偏好错误格式化为安全诊断文本。
impl fmt::Display for PreferenceError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

/// 描述更新领域初始化或输入验证失败。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum UpdateDomainError {
    InvalidCurrentVersion(String),
    InvalidReleaseVersion(String),
    Preference(PreferenceError),
}

/// 将偏好存储错误转换为领域错误。
impl From<PreferenceError> for UpdateDomainError {
    fn from(error: PreferenceError) -> Self {
        Self::Preference(error)
    }
}

/// 可信更新 Adapter 交给领域层的 Stable 发布信息。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct StableRelease {
    pub version: String,
    pub release_notes: String,
}

/// 表示下载长度已知或未知的完整进度。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum DownloadProgress {
    UnknownTotal {
        downloaded_bytes: u64,
    },
    KnownTotal {
        downloaded_bytes: u64,
        total_bytes: u64,
    },
}

/// 标识失败及重试所针对的更新操作。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum UpdateOperation {
    Check,
    Download,
}

/// 更新能力对 Adapter 暴露的类型化状态。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum UpdateState {
    Idle,
    Checking,
    UpToDate,
    Available {
        version: String,
        release_notes: String,
    },
    Downloading {
        version: String,
        release_notes: String,
        progress: DownloadProgress,
    },
    Staged {
        version: String,
        release_notes: String,
    },
    Failed {
        operation: UpdateOperation,
        retryable: bool,
        message: String,
    },
}

/// 每次领域输入产生的完整、单调有序快照。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct UpdateSnapshot {
    pub sequence: u64,
    pub state: UpdateState,
    pub automatic_download: bool,
    pub next_check_at: Option<Duration>,
}

/// 请求可信 Adapter 执行、但不向普通调用方开放参数的副作用。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum UpdateEffect {
    CheckStable,
    ScheduleCheck {
        after: Duration,
    },
    StartDownload {
        release: StableRelease,
    },
    ScheduleRetry {
        operation: UpdateOperation,
        after: Duration,
    },
}

/// 公开 Controller 接收的可信结果与窄化用户意图。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum UpdateInput {
    Ready,
    PeriodicCheckDue,
    ManualCheck,
    CheckSucceeded { release: Option<StableRelease> },
    CheckFailed { message: String, retryable: bool },
    SetAutomaticDownload(bool),
    DownloadStarted,
    DownloadAdvanced(DownloadProgress),
    DownloadSucceeded,
    DownloadFailed { message: String, retryable: bool },
    RetryDue,
}

/// 汇总一次领域转换产生的完整快照与 Adapter 副作用。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UpdateOutput {
    pub snapshot: UpdateSnapshot,
    pub effects: Vec<UpdateEffect>,
}

/// 保存可重试操作所需的最小领域上下文。
#[derive(Debug, Clone, PartialEq, Eq)]
struct PendingRetry {
    operation: UpdateOperation,
    automatic_retries: u8,
}

/// 维护 Stable 更新生命周期与调度策略的公开状态机。
pub struct UpdateController<C, P> {
    clock: C,
    preferences: P,
    current_version: Version,
    current_release: Option<StableRelease>,
    ready: bool,
    snapshot: UpdateSnapshot,
    pending_retry: Option<PendingRetry>,
}

impl<C: Clock, P: PreferenceStore> UpdateController<C, P> {
    /// 从当前应用版本和持久化偏好创建控制器。
    pub fn new(current_version: &str, clock: C, preferences: P) -> Result<Self, UpdateDomainError> {
        let current_version = Version::parse(current_version)
            .map_err(|_| UpdateDomainError::InvalidCurrentVersion(current_version.to_owned()))?;
        let automatic_download = preferences.load_automatic_download()?.unwrap_or(true);
        Ok(Self {
            clock,
            preferences,
            current_version,
            current_release: None,
            ready: false,
            snapshot: UpdateSnapshot {
                sequence: 0,
                state: UpdateState::Idle,
                automatic_download,
                next_check_at: None,
            },
            pending_retry: None,
        })
    }

    /// 返回当前完整快照而不改变顺序号。
    pub fn snapshot(&self) -> &UpdateSnapshot {
        &self.snapshot
    }

    /// 消费可信结果或窄化意图并返回下一份完整快照。
    pub fn handle(&mut self, input: UpdateInput) -> Result<UpdateOutput, UpdateDomainError> {
        let mut effects = Vec::new();
        match input {
            UpdateInput::Ready => {
                self.ready = true;
                self.start_check(true, &mut effects);
            }
            UpdateInput::PeriodicCheckDue if self.ready => self.start_check(true, &mut effects),
            UpdateInput::PeriodicCheckDue => {}
            UpdateInput::ManualCheck => self.start_check(false, &mut effects),
            UpdateInput::CheckSucceeded { release } => {
                self.accept_check_result(release, &mut effects)?
            }
            UpdateInput::CheckFailed { message, retryable } => {
                self.accept_failure(UpdateOperation::Check, message, retryable, &mut effects);
            }
            UpdateInput::SetAutomaticDownload(enabled) => {
                self.preferences.save_automatic_download(enabled)?;
                self.snapshot.automatic_download = enabled;
                if enabled && matches!(self.snapshot.state, UpdateState::Available { .. }) {
                    if let Some(release) = self.current_release.clone() {
                        effects.push(UpdateEffect::StartDownload { release });
                    }
                }
            }
            UpdateInput::DownloadStarted => self.start_download(),
            UpdateInput::DownloadAdvanced(progress) => self.advance_download(progress),
            UpdateInput::DownloadSucceeded => self.finish_download(),
            UpdateInput::DownloadFailed { message, retryable } => {
                self.accept_failure(UpdateOperation::Download, message, retryable, &mut effects);
            }
            UpdateInput::RetryDue => self.retry(&mut effects),
        }
        self.snapshot.sequence += 1;
        Ok(UpdateOutput {
            snapshot: self.snapshot.clone(),
            effects,
        })
    }

    /// 开始一次非阻塞检查并维护六小时周期。
    fn start_check(&mut self, schedule_next: bool, effects: &mut Vec<UpdateEffect>) {
        self.snapshot.state = UpdateState::Checking;
        self.pending_retry = None;
        effects.push(UpdateEffect::CheckStable);
        if schedule_next {
            self.snapshot.next_check_at = Some(self.clock.now() + CHECK_INTERVAL);
            effects.push(UpdateEffect::ScheduleCheck {
                after: CHECK_INTERVAL,
            });
        }
    }

    /// 接受可信 Stable 检查结果并阻止降级或重复安装。
    fn accept_check_result(
        &mut self,
        release: Option<StableRelease>,
        effects: &mut Vec<UpdateEffect>,
    ) -> Result<(), UpdateDomainError> {
        self.pending_retry = None;
        let Some(release) = release else {
            self.current_release = None;
            self.snapshot.state = UpdateState::UpToDate;
            return Ok(());
        };
        let candidate = Version::parse(&release.version)
            .map_err(|_| UpdateDomainError::InvalidReleaseVersion(release.version.clone()))?;
        if candidate <= self.current_version {
            self.current_release = None;
            self.snapshot.state = UpdateState::UpToDate;
            return Ok(());
        }
        self.snapshot.state = UpdateState::Available {
            version: release.version.clone(),
            release_notes: release.release_notes.clone(),
        };
        self.current_release = Some(release.clone());
        if self.snapshot.automatic_download {
            effects.push(UpdateEffect::StartDownload { release });
        }
        Ok(())
    }

    /// 将已接受的 Stable 发布转换为下载中状态。
    fn start_download(&mut self) {
        if let Some(release) = &self.current_release {
            self.snapshot.state = UpdateState::Downloading {
                version: release.version.clone(),
                release_notes: release.release_notes.clone(),
                progress: DownloadProgress::UnknownTotal {
                    downloaded_bytes: 0,
                },
            };
        }
    }

    /// 用 Adapter 报告的已知或未知总量进度更新完整快照。
    fn advance_download(&mut self, progress: DownloadProgress) {
        if let Some(release) = &self.current_release {
            self.snapshot.state = UpdateState::Downloading {
                version: release.version.clone(),
                release_notes: release.release_notes.clone(),
                progress,
            };
        }
    }

    /// 将成功下载表示为待持久化 Adapter 接手的 staged 领域状态。
    fn finish_download(&mut self) {
        self.pending_retry = None;
        if let Some(release) = &self.current_release {
            self.snapshot.state = UpdateState::Staged {
                version: release.version.clone(),
                release_notes: release.release_notes.clone(),
            };
        }
    }

    /// 记录非阻塞失败并按一、二、四秒安排最多三次自动重试。
    fn accept_failure(
        &mut self,
        operation: UpdateOperation,
        message: String,
        retryable: bool,
        effects: &mut Vec<UpdateEffect>,
    ) {
        let prior_retries = self
            .pending_retry
            .as_ref()
            .filter(|pending| pending.operation == operation)
            .map_or(0, |pending| pending.automatic_retries);
        let retries = if retryable && prior_retries < MAX_AUTOMATIC_RETRIES {
            let retries = prior_retries + 1;
            effects.push(UpdateEffect::ScheduleRetry {
                operation,
                after: retry_delay(retries),
            });
            retries
        } else {
            prior_retries
        };
        self.pending_retry = Some(PendingRetry {
            operation,
            automatic_retries: retries,
        });
        self.snapshot.state = UpdateState::Failed {
            operation,
            retryable,
            message,
        };
    }

    /// 在计时器到期时只重放领域已记录的操作，不接受外部资源参数。
    fn retry(&mut self, effects: &mut Vec<UpdateEffect>) {
        let Some(pending) = &self.pending_retry else {
            return;
        };
        match pending.operation {
            UpdateOperation::Check => {
                self.snapshot.state = UpdateState::Checking;
                effects.push(UpdateEffect::CheckStable);
            }
            UpdateOperation::Download => {
                if let Some(release) = self.current_release.clone() {
                    effects.push(UpdateEffect::StartDownload { release });
                }
            }
        }
    }
}

/// 计算第 N 次自动重试的一、二、四秒有界指数延迟。
fn retry_delay(automatic_retry: u8) -> Duration {
    Duration::from_secs(1_u64 << automatic_retry.saturating_sub(1).min(2))
}

#[cfg(test)]
mod tests;
#[cfg(test)]
mod staging_tests;
