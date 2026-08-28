use super::staging::{StageCandidate, StagingRepository, UpdateVerifier};
use super::{
    Clock, DownloadProgress, PreferenceError, PreferenceStore, StableRelease, UpdateController,
    UpdateEffect, UpdateInput, UpdateSnapshot, UpdateState,
};
use base64::Engine;
use futures_util::StreamExt;
use minisign_verify::{PublicKey, Signature};
use serde::{Deserialize, Serialize};
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_updater::{Update, UpdaterExt};

pub const UPDATE_SNAPSHOT_EVENT: &str = "app-update:snapshot";
use std::path::Path;

/// 更新 Adapter 的可信配置错误。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AdapterConfigError {
    MissingEndpoint,
    InsecureEndpoint,
    MissingPublicKey,
    InvalidPublicKey,
}

/// 仅包含 Rust 所有的 Stable endpoint 与 updater 公钥。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AdapterConfig {
    pub endpoint: String,
    pub public_key: String,
}

impl AdapterConfig {
    /// 从受信构建配置创建 Adapter，并对缺失或无效信任根关闭更新能力。
    pub fn parse(
        endpoint: Option<&str>,
        public_key: Option<&str>,
    ) -> Result<Self, AdapterConfigError> {
        let endpoint = endpoint
            .filter(|value| !value.trim().is_empty())
            .ok_or(AdapterConfigError::MissingEndpoint)?;
        let parsed =
            reqwest::Url::parse(endpoint).map_err(|_| AdapterConfigError::MissingEndpoint)?;
        if parsed.scheme() != "https" {
            return Err(AdapterConfigError::InsecureEndpoint);
        }
        let public_key = public_key
            .filter(|value| !value.trim().is_empty())
            .ok_or(AdapterConfigError::MissingPublicKey)?;
        let decoded = base64::engine::general_purpose::STANDARD
            .decode(public_key)
            .ok()
            .and_then(|bytes| String::from_utf8(bytes).ok())
            .ok_or(AdapterConfigError::InvalidPublicKey)?;
        PublicKey::decode(&decoded).map_err(|_| AdapterConfigError::InvalidPublicKey)?;
        Ok(Self {
            endpoint: endpoint.into(),
            public_key: public_key.into(),
        })
    }
}

/// 使用 Tauri `.sig` 外层 base64 格式验证磁盘包的 minisign 边界。
pub struct TauriMinisignVerifier {
    public_key: PublicKey,
}

impl TauriMinisignVerifier {
    /// 从 Tauri 配置中的 base64 公钥创建验证器。
    pub fn new(encoded_public_key: &str) -> Result<Self, AdapterConfigError> {
        let decoded =
            decode_tauri_text(encoded_public_key).ok_or(AdapterConfigError::InvalidPublicKey)?;
        let public_key =
            PublicKey::decode(&decoded).map_err(|_| AdapterConfigError::InvalidPublicKey)?;
        Ok(Self { public_key })
    }
}

impl UpdateVerifier for TauriMinisignVerifier {
    /// 以内存映射而非 package-sized Vec 复用 Tauri 的 minisign wire format。
    fn verify(&self, package: &Path, signature: &str) -> Result<(), String> {
        let signature = decode_tauri_text(signature)
            .ok_or_else(|| "invalid updater signature encoding".to_string())?;
        let signature =
            Signature::decode(&signature).map_err(|_| "invalid updater signature".to_string())?;
        let file = File::open(package).map_err(|_| "update package unavailable".to_string())?;
        let bytes = unsafe { memmap2::MmapOptions::new().map(&file) }
            .map_err(|_| "update package unavailable".to_string())?;
        self.public_key
            .verify(&bytes, &signature, true)
            .map_err(|_| "update signature verification failed".to_string())
    }
}

/// 解码 Tauri updater 对 minisign 文本增加的外层 base64。
fn decode_tauri_text(encoded: &str) -> Option<String> {
    base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .ok()
        .and_then(|bytes| String::from_utf8(bytes).ok())
}

/// 使用进程内单调时钟驱动 controller 调度。
#[derive(Clone)]
pub struct SystemClock {
    started: Instant,
}

impl SystemClock {
    /// 创建从当前时刻开始的单调时钟。
    pub fn new() -> Self {
        Self {
            started: Instant::now(),
        }
    }
}

impl Clock for SystemClock {
    /// 返回进程启动以来的单调时长。
    fn now(&self) -> Duration {
        self.started.elapsed()
    }
}

/// 磁盘上的自动下载偏好文件格式。
#[derive(Serialize, Deserialize)]
struct StoredPreference {
    automatic_download: bool,
}

/// 在应用配置目录原子持久化自动下载偏好。
pub struct FilePreferenceStore {
    path: PathBuf,
}

impl FilePreferenceStore {
    /// 创建仅拥有 updater 偏好文件的存储边界。
    pub fn new(path: PathBuf) -> Self {
        Self { path }
    }
}

impl PreferenceStore for FilePreferenceStore {
    /// 缺失文件采用默认值，损坏文件关闭初始化并保留诊断边界。
    fn load_automatic_download(&self) -> Result<Option<bool>, PreferenceError> {
        match fs::read(&self.path) {
            Ok(bytes) => serde_json::from_slice::<StoredPreference>(&bytes)
                .map(|value| Some(value.automatic_download))
                .map_err(|_| PreferenceError("update preference is invalid".into())),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(_) => Err(PreferenceError("update preference is unavailable".into())),
        }
    }

    /// 通过同目录临时文件替换偏好，避免半写入设置。
    fn save_automatic_download(&mut self, enabled: bool) -> Result<(), PreferenceError> {
        let parent = self
            .path
            .parent()
            .ok_or_else(|| PreferenceError("update preference is unavailable".into()))?;
        fs::create_dir_all(parent)
            .map_err(|_| PreferenceError("update preference is unavailable".into()))?;
        let temporary = self.path.with_extension("json.tmp");
        let bytes = serde_json::to_vec(&StoredPreference {
            automatic_download: enabled,
        })
        .map_err(|_| PreferenceError("update preference is unavailable".into()))?;
        fs::write(&temporary, bytes)
            .and_then(|_| fs::rename(&temporary, &self.path))
            .map_err(|_| PreferenceError("update preference is unavailable".into()))
    }
}

/// 组合可信 Tauri check、流式 staging 与领域 controller 的生产运行时。
pub struct TauriUpdateRuntime {
    controller: Mutex<UpdateController<SystemClock, FilePreferenceStore>>,
    config: Result<AdapterConfig, AdapterConfigError>,
    staging: Mutex<Option<StagingRepository<TauriMinisignVerifier>>>,
    pending: Mutex<Option<Update>>,
    log_path: PathBuf,
    last_http_status: Mutex<Option<u16>>,
}

impl TauriUpdateRuntime {
    /// 从应用路径与构建信任根创建 fail-closed updater runtime。
    pub fn new(app: &AppHandle) -> Result<Arc<Self>, String> {
        let endpoint = std::env::var("DSH_UPDATER_ENDPOINT")
            .ok()
            .or_else(|| option_env!("DSH_UPDATER_ENDPOINT").map(str::to_owned));
        let public_key = option_env!("DSH_UPDATER_PUBLIC_KEY");
        let config = AdapterConfig::parse(endpoint.as_deref(), public_key);
        let config_dir = app
            .path()
            .app_config_dir()
            .map_err(|_| "update config directory unavailable")?;
        let cache_dir = app
            .path()
            .app_cache_dir()
            .map_err(|_| "update cache directory unavailable")?;
        let log_path = config_dir.join("logs").join("updater.jsonl");
        let controller = UpdateController::new(
            &app.package_info().version.to_string(),
            SystemClock::new(),
            FilePreferenceStore::new(config_dir.join("updater-preference.json")),
        )
        .map_err(|_| "update controller unavailable")?;
        let staging = config.as_ref().ok().and_then(|config| {
            TauriMinisignVerifier::new(&config.public_key)
                .ok()
                .and_then(|verifier| StagingRepository::open(cache_dir, verifier).ok())
        });
        let mut controller = controller;
        if let Some(staged) = staging.as_ref().and_then(StagingRepository::snapshot) {
            let _ = controller.handle(UpdateInput::RecoverStaged {
                version: staged.version().into(),
            });
        }
        Ok(Arc::new(Self {
            controller: Mutex::new(controller),
            config,
            staging: Mutex::new(staging),
            pending: Mutex::new(None),
            log_path,
            last_http_status: Mutex::new(None),
        }))
    }

    /// 返回当前完整更新快照。
    pub fn snapshot(&self) -> UpdateSnapshot {
        self.controller
            .lock()
            .map(|value| value.snapshot().clone())
            .unwrap_or(UpdateSnapshot {
                sequence: 0,
                state: super::UpdateState::Failed {
                    operation: super::UpdateOperation::Check,
                    retryable: false,
                    message: "update state unavailable".into(),
                },
                automatic_download: false,
                next_check_at: None,
            })
    }

    /// 接受 Rust 生成的可信输入、发布完整快照并执行领域副作用。
    pub fn dispatch(self: &Arc<Self>, app: &AppHandle, input: UpdateInput) {
        let output = self
            .controller
            .lock()
            .ok()
            .and_then(|mut controller| controller.handle(input).ok());
        let Some(output) = output else {
            return;
        };
        self.record_snapshot(&output.snapshot);
        let _ = app.emit(UPDATE_SNAPSHOT_EVENT, &output.snapshot);
        for effect in output.effects {
            self.execute_effect(app, effect);
        }
    }

    /// 追加一条不包含 URL、签名或用户路径的本地 JSON Lines 诊断。
    fn record_snapshot(&self, snapshot: &UpdateSnapshot) {
        let (version, failure_stage) = match &snapshot.state {
            UpdateState::Available { version, .. }
            | UpdateState::Downloading { version, .. }
            | UpdateState::Staged { version, .. } => (Some(version.clone()), None),
            UpdateState::Failed { operation, .. } => (
                None,
                Some(match operation {
                    super::UpdateOperation::Check => "check",
                    super::UpdateOperation::Download => "download",
                }),
            ),
            _ => (None, None),
        };
        let record = SafeUpdateLog {
            event: if matches!(snapshot.state, UpdateState::Failed { .. }) {
                "update-failed"
            } else {
                "update-transition"
            },
            version,
            platform: format!("{}-{}", std::env::consts::OS, std::env::consts::ARCH),
            http_status: self.last_http_status.lock().ok().and_then(|status| *status),
            failure_stage,
            correlation_id: format!("update-{}", snapshot.sequence),
        };
        let Some(parent) = self.log_path.parent() else {
            return;
        };
        if fs::create_dir_all(parent).is_err() {
            return;
        }
        let Ok(line) = record.to_json() else {
            return;
        };
        if let Ok(mut file) = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.log_path)
        {
            let _ = writeln!(file, "{line}");
        }
    }

    /// 在 Tauri async runtime 上执行 check、timer 或流式下载。
    fn execute_effect(self: &Arc<Self>, app: &AppHandle, effect: UpdateEffect) {
        match effect {
            UpdateEffect::ScheduleCheck { after } => {
                let runtime = Arc::clone(self);
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(after).await;
                    runtime.dispatch(&app, UpdateInput::PeriodicCheckDue);
                });
            }
            UpdateEffect::ScheduleRetry { after, .. } => {
                let runtime = Arc::clone(self);
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(after).await;
                    runtime.dispatch(&app, UpdateInput::RetryDue);
                });
            }
            UpdateEffect::CheckStable => {
                let runtime = Arc::clone(self);
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    runtime.check_stable(&app).await;
                });
            }
            UpdateEffect::StartDownload { .. } => {
                let runtime = Arc::clone(self);
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    runtime.download_pending(&app).await;
                });
            }
        }
    }

    /// 使用 Tauri 可信 manifest 与平台选择逻辑检查 Stable 更新。
    async fn check_stable(self: Arc<Self>, app: &AppHandle) {
        let config = match &self.config {
            Ok(value) => value,
            Err(_) => {
                self.dispatch(
                    app,
                    UpdateInput::CheckFailed {
                        message: "automatic updates are not configured".into(),
                        retryable: false,
                    },
                );
                return;
            }
        };
        let endpoint = match reqwest::Url::parse(&config.endpoint) {
            Ok(value) => value,
            Err(_) => {
                self.dispatch(
                    app,
                    UpdateInput::CheckFailed {
                        message: "automatic updates are not configured".into(),
                        retryable: false,
                    },
                );
                return;
            }
        };
        let updater = match app
            .updater_builder()
            .endpoints(vec![endpoint])
            .map(|builder| builder.pubkey(&config.public_key))
            .and_then(|builder| builder.build())
        {
            Ok(value) => value,
            Err(_) => {
                self.dispatch(
                    app,
                    UpdateInput::CheckFailed {
                        message: "update metadata validation failed".into(),
                        retryable: false,
                    },
                );
                return;
            }
        };
        match updater.check().await {
            Ok(Some(update)) if !update.signature.is_empty() => {
                let release = StableRelease {
                    version: update.version.clone(),
                    release_notes: update.body.clone().unwrap_or_default(),
                };
                if let Ok(mut pending) = self.pending.lock() {
                    *pending = Some(update);
                }
                self.dispatch(
                    app,
                    UpdateInput::CheckSucceeded {
                        release: Some(release),
                    },
                );
            }
            Ok(Some(_)) => self.dispatch(
                app,
                UpdateInput::CheckFailed {
                    message: "update signature is missing".into(),
                    retryable: false,
                },
            ),
            Ok(None) => self.dispatch(app, UpdateInput::CheckSucceeded { release: None }),
            Err(_) => self.dispatch(
                app,
                UpdateInput::CheckFailed {
                    message: "update check failed".into(),
                    retryable: true,
                },
            ),
        }
    }

    /// 将候选包通过 HTTPS 流入临时磁盘文件，再交给持久 staging 仓储验签晋级。
    async fn download_pending(self: Arc<Self>, app: &AppHandle) {
        let update = self.pending.lock().ok().and_then(|value| value.clone());
        let Some(update) = update else {
            return;
        };
        self.dispatch(app, UpdateInput::DownloadStarted);
        let response = match reqwest::Client::new()
            .get(update.download_url.clone())
            .headers(update.headers.clone())
            .send()
            .await
        {
            Ok(value) => value,
            Err(_) => {
                self.dispatch(
                    app,
                    UpdateInput::DownloadFailed {
                        message: "update download failed".into(),
                        retryable: true,
                    },
                );
                return;
            }
        };
        let status = response.status();
        if let Ok(mut observed) = self.last_http_status.lock() {
            *observed = Some(status.as_u16());
        }
        if !status.is_success() {
            self.dispatch(
                app,
                UpdateInput::DownloadFailed {
                    message: "update download failed".into(),
                    retryable: is_retryable_http_status(status),
                },
            );
            return;
        }
        let total = response.content_length();
        let mut downloaded = 0_u64;
        let mut temporary = match tempfile::NamedTempFile::new() {
            Ok(value) => value,
            Err(_) => {
                self.dispatch(
                    app,
                    UpdateInput::DownloadFailed {
                        message: "update storage failed".into(),
                        retryable: false,
                    },
                );
                return;
            }
        };
        let mut stream = response.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = match chunk {
                Ok(value) => value,
                Err(_) => {
                    self.dispatch(
                        app,
                        UpdateInput::DownloadFailed {
                            message: "update download failed".into(),
                            retryable: true,
                        },
                    );
                    return;
                }
            };
            if temporary.write_all(&chunk).is_err() {
                self.dispatch(
                    app,
                    UpdateInput::DownloadFailed {
                        message: "update storage failed".into(),
                        retryable: false,
                    },
                );
                return;
            }
            downloaded += chunk.len() as u64;
            let progress = total.map_or(
                DownloadProgress::UnknownTotal {
                    downloaded_bytes: downloaded,
                },
                |total_bytes| DownloadProgress::KnownTotal {
                    downloaded_bytes: downloaded,
                    total_bytes,
                },
            );
            self.dispatch(app, UpdateInput::DownloadAdvanced(progress));
        }
        if temporary.as_file_mut().sync_all().is_err() {
            self.dispatch(
                app,
                UpdateInput::DownloadFailed {
                    message: "update storage failed".into(),
                    retryable: false,
                },
            );
            return;
        }
        let candidate = match StageCandidate::new(&update.version, &update.signature) {
            Ok(value) => value,
            Err(_) => {
                self.dispatch(
                    app,
                    UpdateInput::DownloadFailed {
                        message: "update metadata validation failed".into(),
                        retryable: false,
                    },
                );
                return;
            }
        };
        let staged = self.staging.lock().ok().and_then(|mut repository| {
            repository
                .as_mut()
                .map(|repository| repository.stage(candidate, temporary.as_file_mut()))
        });
        match staged {
            Some(Ok(_)) => self.dispatch(app, UpdateInput::DownloadSucceeded),
            _ => self.dispatch(
                app,
                UpdateInput::DownloadFailed {
                    message: "update signature verification failed".into(),
                    retryable: false,
                },
            ),
        }
    }

    /// 判断是否存在已验证、等待正常退出或显式重启安装的包。
    pub fn has_staged(&self) -> bool {
        self.staging
            .lock()
            .ok()
            .and_then(|repository| repository.as_ref().and_then(StagingRepository::snapshot))
            .is_some()
    }

    /// 安装前复验唯一 staging package，并通过 Tauri installer 安装短暂读取的字节。
    pub fn install_staged(&self, app: &AppHandle) -> Result<(), String> {
        let mut repositories = self
            .staging
            .lock()
            .map_err(|_| "update staging unavailable".to_string())?;
        let repository = repositories
            .as_mut()
            .ok_or_else(|| "update staging unavailable".to_string())?;
        let package = repository
            .verify_for_install()
            .map_err(|_| "update package verification failed".to_string())?;
        let update = match self.pending.lock().ok().and_then(|value| value.clone()) {
            Some(value) => value,
            None => {
                let config = self
                    .config
                    .as_ref()
                    .map_err(|_| "update installer metadata unavailable".to_string())?;
                let endpoint = reqwest::Url::parse(&config.endpoint)
                    .map_err(|_| "update installer metadata unavailable".to_string())?;
                let updater = app
                    .updater_builder()
                    .endpoints(vec![endpoint])
                    .map(|builder| builder.pubkey(&config.public_key))
                    .and_then(|builder| builder.build())
                    .map_err(|_| "update installer metadata unavailable".to_string())?;
                tauri::async_runtime::block_on(updater.check())
                    .map_err(|_| "update installer metadata unavailable".to_string())?
                    .ok_or_else(|| "update installer metadata unavailable".to_string())?
            }
        };
        if package.version() != update.version {
            return Err("update installer metadata mismatch".into());
        }
        // Tauri 2.10 的 installer 只接受 &[u8]；该 Vec 仅在安装调用期间存在，staging 本身始终在磁盘。
        let bytes =
            fs::read(package.path()).map_err(|_| "update package unavailable".to_string())?;
        update
            .install(&bytes)
            .map_err(|_| "update installation failed".to_string())?;
        drop(bytes);
        repository
            .complete_install(&package)
            .map_err(|_| "update cleanup failed".to_string())
    }
}

/// 只对超时、限流和服务端失败安排有界自动重试。
fn is_retryable_http_status(status: reqwest::StatusCode) -> bool {
    status == reqwest::StatusCode::REQUEST_TIMEOUT
        || status == reqwest::StatusCode::TOO_MANY_REQUESTS
        || status.is_server_error()
}

/// 安装意图只区分退出与重启，不携带包路径等更新原语。
#[cfg(test)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InstallIntent {
    Exit,
    Restart,
}

/// Host cleanup 的受信系统边界。
#[cfg(test)]
pub trait HostCleanup {
    /// 停止并确认 Desktop 所有的 Host 进程树已经清理。
    fn stop_and_confirm(&mut self) -> Result<(), String>;
}

/// 已复验 staging package 的安装系统边界。
#[cfg(test)]
pub trait StagedInstaller {
    /// 安装由 Rust 仓储选择并复验的包。
    fn install_staged(&mut self) -> Result<(), String>;

    /// 请求应用重新启动。
    fn relaunch(&mut self) -> Result<(), String>;
}

/// 执行安装前的 Host cleanup，并严格区分正常退出和重启语义。
#[cfg(test)]
pub fn install_after_cleanup(
    cleanup: &mut impl HostCleanup,
    installer: &mut impl StagedInstaller,
    intent: InstallIntent,
) -> Result<(), String> {
    cleanup.stop_and_confirm()?;
    installer.install_staged()?;
    if intent == InstallIntent::Restart {
        installer.relaunch()?;
    }
    Ok(())
}

/// 本地更新诊断记录，只允许稳定分类和值，不包含签名或本机路径。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SafeUpdateLog {
    pub event: &'static str,
    pub version: Option<String>,
    pub platform: String,
    pub http_status: Option<u16>,
    pub failure_stage: Option<&'static str>,
    pub correlation_id: String,
}

impl SafeUpdateLog {
    /// 序列化可落盘的脱敏结构化诊断记录。
    pub fn to_json(&self) -> Result<String, serde_json::Error> {
        serde_json::to_string(self)
    }

    /// 检查任意诊断文本都不包含调用方提供的敏感签名或用户路径。
    #[cfg(test)]
    pub fn excludes(&self, signature: &str, path: &Path) -> bool {
        let rendered = self.to_json().unwrap_or_default();
        !rendered.contains(signature) && !rendered.contains(&path.to_string_lossy().to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    /// 记录 cleanup 与安装的公开可观察顺序。
    struct Recorder {
        events: Vec<&'static str>,
    }

    impl HostCleanup for Recorder {
        /// 记录 Host cleanup 已确认。
        fn stop_and_confirm(&mut self) -> Result<(), String> {
            self.events.push("cleanup");
            Ok(())
        }
    }

    impl StagedInstaller for Recorder {
        /// 记录安装已发生。
        fn install_staged(&mut self) -> Result<(), String> {
            self.events.push("install");
            Ok(())
        }

        /// 记录应用 relaunch 已请求。
        fn relaunch(&mut self) -> Result<(), String> {
            self.events.push("relaunch");
            Ok(())
        }
    }

    /// 缺失、不安全 endpoint 或无效公钥都会关闭更新信任。
    #[test]
    fn configuration_fails_closed() {
        assert_eq!(
            AdapterConfig::parse(None, Some("key")),
            Err(AdapterConfigError::MissingEndpoint)
        );
        assert_eq!(
            AdapterConfig::parse(Some("http://updates.example/latest.json"), Some("key")),
            Err(AdapterConfigError::InsecureEndpoint)
        );
        assert_eq!(
            AdapterConfig::parse(Some("https://updates.example/latest.json"), None),
            Err(AdapterConfigError::MissingPublicKey)
        );
        assert_eq!(
            AdapterConfig::parse(
                Some("https://updates.example/latest.json"),
                Some("not-base64")
            ),
            Err(AdapterConfigError::InvalidPublicKey)
        );
    }

    /// 重启安装必须先确认 cleanup，再安装并 relaunch。
    #[test]
    fn restart_installs_only_after_cleanup_then_relaunches() {
        let mut cleanup = Recorder { events: Vec::new() };
        let mut installer = Recorder { events: Vec::new() };
        install_after_cleanup(&mut cleanup, &mut installer, InstallIntent::Restart).unwrap();
        assert_eq!(cleanup.events, ["cleanup"]);
        assert_eq!(installer.events, ["install", "relaunch"]);
    }

    /// 正常退出安装不会重新打开 Desktop。
    #[test]
    fn normal_exit_installs_without_relaunch() {
        let mut cleanup = Recorder { events: Vec::new() };
        let mut installer = Recorder { events: Vec::new() };
        install_after_cleanup(&mut cleanup, &mut installer, InstallIntent::Exit).unwrap();
        assert_eq!(cleanup.events, ["cleanup"]);
        assert_eq!(installer.events, ["install"]);
    }

    /// 结构化更新日志不会泄露 updater 签名或用户路径。
    #[test]
    fn structured_log_excludes_signature_and_user_path() {
        let record = SafeUpdateLog {
            event: "update-failed",
            version: Some("2.1.0".into()),
            platform: "macos-aarch64".into(),
            http_status: Some(503),
            failure_stage: Some("download"),
            correlation_id: "update-7".into(),
        };
        assert!(record.excludes(
            "secret-signature",
            Path::new("/Users/alice/private/package")
        ));
    }

    /// 与 Tauri `.sig` 相同的双层编码 fixture 能验证磁盘包并拒绝篡改。
    #[test]
    fn tauri_minisign_fixture_verifies_from_disk() {
        let public_key_text = "untrusted comment: minisign public key E7620F1842B4E81F\nRWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3";
        let signature_text = "untrusted comment: signature from minisign secret key\nRWQf6LRCGA9i59SLOFxz6NxvASXDJeRtuZykwQepbDEGt87ig1BNpWaVWuNrm73YiIiJbq71Wi+dP9eKL8OC351vwIasSSbXxwA=\ntrusted comment: timestamp:1555779966\tfile:test\nQtKMXWyYcwdpZAlPF7tE2ENJkRd1ujvKjlj1m9RtHTBnZPa5WKU5uWRs5GoP5M/VqE81QFuMKI5k/SfNQUaOAA==";
        let key = base64::engine::general_purpose::STANDARD.encode(public_key_text);
        let signature = base64::engine::general_purpose::STANDARD.encode(signature_text);
        let verifier = TauriMinisignVerifier::new(&key).unwrap();
        let mut package = tempfile::NamedTempFile::new().unwrap();
        package.write_all(b"test").unwrap();
        verifier.verify(package.path(), &signature).unwrap();
        package.as_file_mut().set_len(0).unwrap();
        package.write_all(b"Test").unwrap();
        assert!(verifier.verify(package.path(), &signature).is_err());
    }

    /// HTTP 失败只在瞬时类别进入自动重试，元数据类 4xx 关闭信任。
    #[test]
    fn only_transient_http_failures_are_retryable() {
        assert!(is_retryable_http_status(
            reqwest::StatusCode::REQUEST_TIMEOUT
        ));
        assert!(is_retryable_http_status(
            reqwest::StatusCode::TOO_MANY_REQUESTS
        ));
        assert!(is_retryable_http_status(
            reqwest::StatusCode::SERVICE_UNAVAILABLE
        ));
        assert!(!is_retryable_http_status(reqwest::StatusCode::NOT_FOUND));
        assert!(!is_retryable_http_status(reqwest::StatusCode::UNAUTHORIZED));
    }
}
