use super::staging::{
    atomic_replace_file, InstallKind, StageCandidate, StagedUpdate, StagingError,
    StagingRepository, UpdateVerifier,
};
use super::{
    Clock, DownloadProgress, PreferenceError, PreferenceStore, StableRelease, UpdateController,
    UpdateEffect, UpdateInput, UpdateSnapshot, UpdateState,
};
use base64::Engine;
use futures_util::StreamExt;
use minisign_verify::{PublicKey, Signature};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs::{self, File, OpenOptions};
use std::io::{Seek, SeekFrom, Write};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_updater::{Update, UpdaterExt};
use time::{format_description::well_known::Rfc3339, OffsetDateTime};

pub const UPDATE_SNAPSHOT_EVENT: &str = "app-update:snapshot";
const MANIFEST_HTTP_TIMEOUT: Duration = Duration::from_secs(30);

/// 大包下载只限制连接与无读取进展时间，不限制整个 body 总时长。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct PackageClientPolicy {
    connect_timeout: Duration,
    read_idle_timeout: Duration,
}

impl PackageClientPolicy {
    /// 返回适合 57–231MB 更新包的默认网络策略。
    fn production() -> Self {
        Self {
            connect_timeout: Duration::from_secs(30),
            read_idle_timeout: Duration::from_secs(60),
        }
    }

    /// 构建不含 total timeout 的 reqwest client。
    fn build_client(self) -> Result<reqwest::Client, reqwest::Error> {
        reqwest::Client::builder()
            .connect_timeout(self.connect_timeout)
            .read_timeout(self.read_idle_timeout)
            .build()
    }
}
use std::path::Path;

/// 平台安装完成后说明是否已由 installer 接管重新启动。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct OfflineInstallOutcome {
    pub relaunch_handled: bool,
    pub cleanup: OfflineInstallCleanup,
}

/// 区分同步安装完成与 Windows installer 已接管但尚未证实完成。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OfflineInstallCleanup {
    CompleteNow,
    #[cfg(any(target_os = "windows", test))]
    Deferred,
}

/// 对复验后磁盘包执行平台替换的系统边界。
pub trait OfflinePackageInstaller {
    /// 使用持久化可信计划安装包，不访问 manifest 或网络。
    fn install(
        &mut self,
        package: &Path,
        version: &str,
        target: &str,
        install_kind: InstallKind,
        relaunch: bool,
    ) -> Result<OfflineInstallOutcome, String>;
}

/// 复验恢复的 staging package、执行离线安装，并只在成功后清理仓储。
pub fn install_verified_offline<V: UpdateVerifier>(
    repository: &mut StagingRepository<V>,
    installer: &mut impl OfflinePackageInstaller,
    relaunch: bool,
) -> Result<OfflineInstallOutcome, String> {
    let package = repository
        .verify_for_install()
        .map_err(|_| "update package verification failed".to_string())?;
    let outcome = installer.install(
        package.path(),
        package.version(),
        package.target(),
        package.install_kind(),
        relaunch,
    )?;
    if outcome.cleanup == OfflineInstallCleanup::CompleteNow {
        repository
            .complete_install(&package)
            .map_err(|_| "update cleanup failed".to_string())?;
    }
    Ok(outcome)
}

/// 复刻 Tauri 2.10 平台安装语义、但直接消费已复验磁盘包的生产 Adapter。
pub struct PlatformInstaller {
    #[cfg(target_os = "windows")]
    app_name: String,
}

impl PlatformInstaller {
    /// 从 Desktop 应用元数据创建当前平台安装器。
    pub fn new(app: &AppHandle) -> Self {
        #[cfg(not(target_os = "windows"))]
        let _ = app;
        Self {
            #[cfg(target_os = "windows")]
            app_name: app.package_info().name.clone(),
        }
    }
}

impl OfflinePackageInstaller for PlatformInstaller {
    /// 校验持久化 target/install kind 与当前平台一致后执行离线安装。
    fn install(
        &mut self,
        package: &Path,
        _version: &str,
        target: &str,
        install_kind: InstallKind,
        relaunch: bool,
    ) -> Result<OfflineInstallOutcome, String> {
        #[cfg(not(target_os = "windows"))]
        let _ = relaunch;
        if install_kind != InstallKind::current()
            || target
                != tauri_plugin_updater::target()
                    .as_deref()
                    .unwrap_or_default()
        {
            return Err("update installer target mismatch".into());
        }
        #[cfg(target_os = "macos")]
        return install_macos_app(package).map(|()| OfflineInstallOutcome {
            relaunch_handled: false,
            cleanup: OfflineInstallCleanup::CompleteNow,
        });
        #[cfg(target_os = "linux")]
        return install_linux_appimage(package).map(|()| OfflineInstallOutcome {
            relaunch_handled: false,
            cleanup: OfflineInstallCleanup::CompleteNow,
        });
        #[cfg(target_os = "windows")]
        return install_windows_nsis(package, &self.app_name, relaunch).map(|()| {
            OfflineInstallOutcome {
                relaunch_handled: relaunch,
                cleanup: OfflineInstallCleanup::Deferred,
            }
        });
    }
}

/// 在 macOS 上从 updater tar.gz 解包并以可回滚目录替换当前 `.app`。
#[cfg(target_os = "macos")]
fn install_macos_app(package: &Path) -> Result<(), String> {
    use flate2::read::GzDecoder;
    let current_exe = std::env::current_exe().map_err(|_| "current application unavailable")?;
    let destination = tauri_plugin_updater::extract_path_from_executable(&current_exe)
        .map_err(|_| "current application unavailable")?;
    let backup = tempfile::Builder::new()
        .prefix("dsh-current-app")
        .tempdir()
        .map_err(|_| "update temporary directory unavailable")?;
    let extracted = tempfile::Builder::new()
        .prefix("dsh-updated-app")
        .tempdir()
        .map_err(|_| "update temporary directory unavailable")?;
    let file = File::open(package).map_err(|_| "update package unavailable")?;
    let mut archive = tar::Archive::new(GzDecoder::new(file));
    let mut extracted_any = false;
    for entry in archive.entries().map_err(|_| "update archive invalid")? {
        let mut entry = entry.map_err(|_| "update archive invalid")?;
        let relative: PathBuf = entry
            .path()
            .map_err(|_| "update archive invalid")?
            .iter()
            .skip(1)
            .collect();
        if relative.as_os_str().is_empty() {
            continue;
        }
        let output = extracted.path().join(relative);
        if let Some(parent) = output.parent() {
            fs::create_dir_all(parent).map_err(|_| "update extraction failed")?;
        }
        entry
            .unpack(&output)
            .map_err(|_| "update extraction failed")?;
        extracted_any = true;
    }
    if !extracted_any {
        return Err("update archive invalid".into());
    }
    let backup_path = backup.path().join("current_app");
    match fs::rename(&destination, &backup_path) {
        Ok(()) => {
            if let Err(_) = fs::rename(extracted.path(), &destination) {
                let _ = fs::rename(&backup_path, &destination);
                return Err("update replacement failed".into());
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::PermissionDenied => {
            install_macos_with_authorization(extracted.path(), &destination)?;
        }
        Err(_) => return Err("update replacement failed".into()),
    }
    let _ = std::process::Command::new("touch")
        .arg(destination)
        .status();
    Ok(())
}

/// 使用系统 AppleScript 权限对话框替换不可直接写入的 macOS 应用。
#[cfg(target_os = "macos")]
fn install_macos_with_authorization(source: &Path, destination: &Path) -> Result<(), String> {
    let command = format!(
        "rm -rf -- {} && mv -f -- {} {}",
        shell_quote(destination),
        shell_quote(source),
        shell_quote(destination)
    );
    let apple_script = format!(
        "do shell script \"{}\" with administrator privileges",
        command.replace('\\', "\\\\").replace('"', "\\\"")
    );
    let status = std::process::Command::new("osascript")
        .args(["-e", &apple_script])
        .status()
        .map_err(|_| "update authorization unavailable")?;
    if status.success() {
        Ok(())
    } else {
        Err("update authorization denied".into())
    }
}

/// 为 shell command 生成不执行插值的单引号参数。
#[cfg(target_os = "macos")]
fn shell_quote(path: &Path) -> String {
    format!("'{}'", path.to_string_lossy().replace('\'', "'\\''"))
}

/// 将文件 rename 限定为可在失败路径注入的系统边界。
#[cfg(any(target_os = "linux", test))]
trait RenameBoundary {
    /// 原子移动单个文件或目录。
    fn rename(&mut self, source: &Path, destination: &Path) -> std::io::Result<()>;
}

/// 生产环境使用标准文件系统 rename。
#[cfg(target_os = "linux")]
struct FileSystemRename;

#[cfg(target_os = "linux")]
impl RenameBoundary for FileSystemRename {
    /// 委托标准库执行同文件系统原子移动。
    fn rename(&mut self, source: &Path, destination: &Path) -> std::io::Result<()> {
        fs::rename(source, destination)
    }
}

/// 表示替换失败是否仍安全恢复了旧应用。
#[cfg(any(target_os = "linux", test))]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ReplaceTransactionError {
    RolledBack,
    RollbackFailed,
}

/// 仅移动一次当前应用，并在候选替换或后处理失败时恢复原应用。
#[cfg(any(target_os = "linux", test))]
fn replace_with_rollback(
    boundary: &mut impl RenameBoundary,
    destination: &Path,
    candidate: &Path,
    backup: &Path,
    post_replace: impl FnOnce() -> Result<(), ()>,
) -> Result<(), ReplaceTransactionError> {
    boundary
        .rename(destination, backup)
        .map_err(|_| ReplaceTransactionError::RolledBack)?;
    if boundary.rename(candidate, destination).is_err() || post_replace().is_err() {
        return match boundary.rename(backup, destination) {
            Ok(()) => Err(ReplaceTransactionError::RolledBack),
            Err(_) => Err(ReplaceTransactionError::RollbackFailed),
        };
    }
    Ok(())
}

/// 在 Linux 上从 updater tar.gz 或原始包替换当前 AppImage，并保留回滚副本。
#[cfg(target_os = "linux")]
fn install_linux_appimage(package: &Path) -> Result<(), String> {
    use std::io::{Read, Seek, SeekFrom};
    use std::os::unix::fs::PermissionsExt;
    let destination = std::env::var_os("APPIMAGE")
        .map(PathBuf::from)
        .ok_or_else(|| "current AppImage unavailable".to_string())?;
    let parent = destination
        .parent()
        .ok_or_else(|| "current AppImage unavailable".to_string())?;
    let temporary = tempfile::Builder::new()
        .prefix("dsh-appimage-update")
        .tempdir_in(parent)
        .map_err(|_| "update temporary directory unavailable")?;
    let candidate = temporary.path().join("candidate.AppImage");
    let mut input = File::open(package).map_err(|_| "update package unavailable")?;
    let mut magic = [0_u8; 2];
    input
        .read_exact(&mut magic)
        .map_err(|_| "update package unavailable")?;
    input
        .seek(SeekFrom::Start(0))
        .map_err(|_| "update package unavailable")?;
    if magic == [0x1f, 0x8b] {
        let mut archive = tar::Archive::new(flate2::read::GzDecoder::new(input));
        let mut found = false;
        for entry in archive.entries().map_err(|_| "update archive invalid")? {
            let mut entry = entry.map_err(|_| "update archive invalid")?;
            if entry
                .path()
                .ok()
                .and_then(|path| path.extension().map(|value| value == "AppImage"))
                .unwrap_or(false)
            {
                entry
                    .unpack(&candidate)
                    .map_err(|_| "update extraction failed")?;
                found = true;
                break;
            }
        }
        if !found {
            return Err("update archive invalid".into());
        }
    } else {
        fs::copy(package, &candidate).map_err(|_| "update extraction failed")?;
    }
    let permissions = fs::metadata(&destination)
        .map_err(|_| "current AppImage unavailable")?
        .permissions();
    fs::set_permissions(&candidate, permissions).map_err(|_| "update extraction failed")?;
    let backup = temporary.path().join("current.AppImage");
    let transaction = replace_with_rollback(
        &mut FileSystemRename,
        &destination,
        &candidate,
        &backup,
        || {
            let mut executable = fs::metadata(&destination).map_err(|_| ())?.permissions();
            executable.set_mode(executable.mode() | 0o700);
            fs::set_permissions(&destination, executable).map_err(|_| ())
        },
    );
    match transaction {
        Ok(()) => Ok(()),
        Err(ReplaceTransactionError::RolledBack) => Err("update replacement failed".into()),
        Err(ReplaceTransactionError::RollbackFailed) => {
            let _preserved_directory = temporary.keep();
            Err("update rollback failed; backup preserved".into())
        }
    }
}

/// 在 Windows 上从 updater ZIP 或原始 EXE 启动 current-user NSIS installer。
#[cfg(target_os = "windows")]
fn install_windows_nsis(package: &Path, app_name: &str, relaunch: bool) -> Result<(), String> {
    use std::io::Read;
    let mut file = File::open(package).map_err(|_| "update package unavailable")?;
    let mut magic = [0_u8; 2];
    file.read_exact(&mut magic)
        .map_err(|_| "update package unavailable")?;
    let directory = tempfile::Builder::new()
        .prefix(&format!("{app_name}-updater"))
        .tempdir()
        .map_err(|_| "update temporary directory unavailable")?
        .keep();
    let installer = if magic == [b'M', b'Z'] {
        let path = directory.join("installer.exe");
        fs::copy(package, &path).map_err(|_| "update extraction failed")?;
        path
    } else {
        let mut archive = zip::ZipArchive::new(file).map_err(|_| "update archive invalid")?;
        let mut installer = None;
        for index in 0..archive.len() {
            let mut entry = archive
                .by_index(index)
                .map_err(|_| "update archive invalid")?;
            if Path::new(entry.name())
                .extension()
                .is_some_and(|value| value == "exe")
            {
                let path = directory.join("installer.exe");
                let mut output = File::create(&path).map_err(|_| "update extraction failed")?;
                std::io::copy(&mut entry, &mut output).map_err(|_| "update extraction failed")?;
                installer = Some(path);
                break;
            }
        }
        installer.ok_or_else(|| "update archive invalid".to_string())?
    };
    let mut command = std::process::Command::new(installer);
    command.args(windows_nsis_args(relaunch));
    command.spawn().map_err(|_| "update installation failed")?;
    Ok(())
}

/// 为 Windows NSIS 区分正常退出安装与显式重启安装参数。
#[cfg(any(target_os = "windows", test))]
fn windows_nsis_args(relaunch: bool) -> &'static [&'static str] {
    if relaunch {
        &["/P", "/UPDATE", "/R"]
    } else {
        &["/P", "/UPDATE"]
    }
}

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
            endpoint: parsed.to_string(),
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

/// 将下载临时文件归零后交给 staging，避免从 EOF 复制出空包。
fn stage_downloaded_package<V: UpdateVerifier>(
    repository: &mut StagingRepository<V>,
    candidate: StageCandidate,
    package: &mut tempfile::NamedTempFile,
) -> Result<StagedUpdate, StagingError> {
    package
        .as_file_mut()
        .seek(SeekFrom::Start(0))
        .map_err(|_| StagingError::StorageFailed)?;
    repository.stage(candidate, package.as_file_mut())
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
    automatic_download: Option<bool>,
    warning: Option<PreferenceLoadWarning>,
}

/// 记录偏好为何采用默认值，不携带文件路径或内容。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PreferenceLoadWarning {
    Invalid,
    Unavailable,
}

impl FilePreferenceStore {
    /// 创建仅拥有 updater 偏好文件的存储边界。
    pub fn new(path: PathBuf) -> Self {
        let (automatic_download, warning) = match fs::read(&path) {
            Ok(bytes) => match serde_json::from_slice::<StoredPreference>(&bytes) {
                Ok(value) => (Some(value.automatic_download), None),
                Err(_) => (None, Some(PreferenceLoadWarning::Invalid)),
            },
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => (None, None),
            Err(_) => (None, Some(PreferenceLoadWarning::Unavailable)),
        };
        Self {
            path,
            automatic_download,
            warning,
        }
    }

    /// 返回单次读取产生的安全默认原因。
    fn warning(&self) -> Option<PreferenceLoadWarning> {
        self.warning
    }
}

impl PreferenceStore for FilePreferenceStore {
    /// 缺失、损坏或不可读文件均安全回退默认值，避免阻断 Host Ready。
    fn load_automatic_download(&self) -> Result<Option<bool>, PreferenceError> {
        Ok(self.automatic_download)
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
            .and_then(|_| atomic_replace_file(&temporary, &self.path))
            .map_err(|_| {
                let _ = fs::remove_file(&temporary);
                PreferenceError("update preference is unavailable".into())
            })?;
        self.automatic_download = Some(enabled);
        self.warning = None;
        Ok(())
    }
}

/// 组合可信 Tauri check、流式 staging 与领域 controller 的生产运行时。
pub struct TauriUpdateRuntime {
    controller: Mutex<UpdateController<SystemClock, FilePreferenceStore>>,
    config: Result<AdapterConfig, AdapterConfigError>,
    staging: Mutex<Option<StagingRepository<TauriMinisignVerifier>>>,
    pending: Mutex<Option<Update>>,
    transition_publish_gate: Mutex<()>,
    operation_gate: tokio::sync::Mutex<()>,
    log_path: PathBuf,
    last_http_status: Mutex<Option<u16>>,
}

/// 在单一门内完成领域转换与发布，确保外部观察顺序和 sequence 一致。
fn transition_and_publish<C: Clock, P: PreferenceStore>(
    gate: &Mutex<()>,
    controller: &Mutex<UpdateController<C, P>>,
    input: UpdateInput,
    publish: impl FnOnce(&UpdateSnapshot),
) -> Option<Vec<UpdateEffect>> {
    let _guard = gate.lock().ok()?;
    let output = controller.lock().ok()?.handle(input).ok()?;
    publish(&output.snapshot);
    Some(output.effects)
}

/// 将候选发布提交给领域前先完成旧 staging 清理，存储失败则关闭安装资格。
fn prepare_checked_release<V: UpdateVerifier>(
    repository: Option<&mut StagingRepository<V>>,
    release: StableRelease,
) -> UpdateInput {
    match repository.map(|repository| repository.discard_if_older_than(&release.version)) {
        Some(Ok(_)) => UpdateInput::CheckSucceeded {
            release: Some(release),
        },
        _ => UpdateInput::StagingDiscardFailed,
    }
}

impl TauriUpdateRuntime {
    /// 从应用路径与构建信任根创建 fail-closed updater runtime。
    pub fn new(app: &AppHandle) -> Result<Arc<Self>, String> {
        let endpoint = option_env!("DSH_UPDATER_ENDPOINT").map(str::to_owned);
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
        record_configuration_identity(
            &log_path,
            config.as_ref().ok(),
            &app.package_info().version.to_string(),
        );
        let preference_path = config_dir.join("updater-preference.json");
        let preferences = FilePreferenceStore::new(preference_path);
        let preference_warning = preferences.warning();
        let controller = UpdateController::new(
            &app.package_info().version.to_string(),
            SystemClock::new(),
            preferences,
        )
        .map_err(|_| "update controller unavailable")?;
        let mut staging = config.as_ref().ok().and_then(|config| {
            TauriMinisignVerifier::new(&config.public_key)
                .ok()
                .and_then(|verifier| StagingRepository::open(cache_dir, verifier).ok())
        });
        if let Some(repository) = staging.as_mut() {
            let _ = repository.reconcile_current_version(&app.package_info().version.to_string());
        }
        let mut controller = controller;
        if let Some(staged) = staging.as_ref().and_then(StagingRepository::snapshot) {
            let _ = controller.handle(UpdateInput::RecoverStaged {
                version: staged.version().into(),
            });
        }
        let runtime = Arc::new(Self {
            controller: Mutex::new(controller),
            config,
            staging: Mutex::new(staging),
            pending: Mutex::new(None),
            transition_publish_gate: Mutex::new(()),
            operation_gate: tokio::sync::Mutex::new(()),
            log_path,
            last_http_status: Mutex::new(None),
        });
        if let Some(warning) = preference_warning {
            runtime.record_preference_warning(warning);
        }
        Ok(runtime)
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
        let effects = transition_and_publish(
            &self.transition_publish_gate,
            &self.controller,
            input,
            |snapshot| {
                self.record_snapshot(snapshot);
                let _ = app.emit(UPDATE_SNAPSHOT_EVENT, snapshot);
            },
        );
        let Some(effects) = effects else {
            return;
        };
        for effect in effects {
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

    /// 记录偏好损坏或不可读后的安全默认，不阻断 Desktop Ready。
    fn record_preference_warning(&self, warning: PreferenceLoadWarning) {
        let record = SafeUpdateLog {
            event: match warning {
                PreferenceLoadWarning::Invalid => "preference-invalid-defaulted",
                PreferenceLoadWarning::Unavailable => "preference-unavailable-defaulted",
            },
            version: None,
            platform: format!("{}-{}", std::env::consts::OS, std::env::consts::ARCH),
            http_status: None,
            failure_stage: Some("preference"),
            correlation_id: "update-preference".into(),
        };
        let Some(parent) = self.log_path.parent() else {
            return;
        };
        if fs::create_dir_all(parent).is_err() {
            return;
        }
        if let (Ok(line), Ok(mut file)) = (
            record.to_json(),
            OpenOptions::new()
                .create(true)
                .append(true)
                .open(&self.log_path),
        ) {
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
            UpdateEffect::StartDownload { release } => {
                let runtime = Arc::clone(self);
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    runtime.download_pending(&app, release).await;
                });
            }
        }
    }

    /// 使用 Tauri 可信 manifest 与平台选择逻辑检查 Stable 更新。
    async fn check_stable(self: Arc<Self>, app: &AppHandle) {
        let _operation = self.operation_gate.lock().await;
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
            .timeout(MANIFEST_HTTP_TIMEOUT)
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
                let input = self
                    .staging
                    .lock()
                    .ok()
                    .map(|mut staging| prepare_checked_release(staging.as_mut(), release))
                    .unwrap_or(UpdateInput::StagingDiscardFailed);
                self.dispatch(app, input);
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
    async fn download_pending(self: Arc<Self>, app: &AppHandle, release: StableRelease) {
        let _operation = self.operation_gate.lock().await;
        let update = self.pending.lock().ok().and_then(|value| value.clone());
        let Some(update) = update else {
            return;
        };
        if !pending_version_matches(&update.version, &release) {
            return;
        }
        self.dispatch(app, UpdateInput::DownloadStarted);
        let client = match PackageClientPolicy::production().build_client() {
            Ok(client) => client,
            Err(_) => {
                self.dispatch(
                    app,
                    UpdateInput::DownloadFailed {
                        message: "update download failed".into(),
                        retryable: false,
                    },
                );
                return;
            }
        };
        let response = match client
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
        let target = tauri_plugin_updater::target().unwrap_or_default();
        let candidate = match StageCandidate::with_install_plan(
            &update.version,
            &update.signature,
            &target,
            InstallKind::current(),
        ) {
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
                .map(|repository| stage_downloaded_package(repository, candidate, &mut temporary))
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
        let repository_has_staged = self
            .staging
            .lock()
            .ok()
            .and_then(|repository| repository.as_ref().and_then(StagingRepository::snapshot))
            .is_some();
        staged_install_allowed(&self.snapshot(), repository_has_staged)
    }

    /// 安装前复验唯一 staging package，并通过持久化可信计划离线安装。
    pub fn install_staged(
        &self,
        app: &AppHandle,
        relaunch: bool,
    ) -> Result<OfflineInstallOutcome, String> {
        if !self.has_staged() {
            return Err("no trusted staged update".into());
        }
        let mut repositories = self
            .staging
            .lock()
            .map_err(|_| "update staging unavailable".to_string())?;
        let repository = repositories
            .as_mut()
            .ok_or_else(|| "update staging unavailable".to_string())?;
        let mut installer = PlatformInstaller::new(app);
        install_verified_offline(repository, &mut installer, relaunch)
    }
}

/// 将下载 effect 绑定到产生它的可信 pending Update 版本，拒绝过期配对。
fn pending_version_matches(pending_version: &str, release: &StableRelease) -> bool {
    pending_version == release.version
}

/// 只有领域与磁盘同时确认可信 Staged 时才允许退出安装。
fn staged_install_allowed(snapshot: &UpdateSnapshot, repository_has_staged: bool) -> bool {
    matches!(snapshot.state, UpdateState::Staged { .. }) && repository_has_staged
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

/// 已验证 updater 配置的脱敏身份，只包含原生验收所需的稳定 allowlist 字段。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SafeUpdaterConfigurationLog {
    pub event: &'static str,
    pub app_version: String,
    pub endpoint: String,
    pub public_key_sha256: String,
    pub platform: String,
    pub correlation_id: &'static str,
    pub recorded_at: String,
    pub process_id: u32,
}

impl SafeUpdaterConfigurationLog {
    /// 从实际请求使用的已验证配置构造脱敏身份。
    fn from_config(
        config: &AdapterConfig,
        app_version: &str,
        recorded_at: &str,
        process_id: u32,
    ) -> Self {
        Self {
            event: "updater-configuration-identity",
            app_version: app_version.into(),
            endpoint: config.endpoint.clone(),
            public_key_sha256: format!("{:x}", Sha256::digest(config.public_key.as_bytes())),
            platform: format!("{}-{}", std::env::consts::OS, std::env::consts::ARCH),
            correlation_id: "updater-configuration",
            recorded_at: recorded_at.into(),
            process_id,
        }
    }

    /// 序列化可供真实原生验收读取的配置身份记录。
    fn to_json(&self) -> Result<String, serde_json::Error> {
        serde_json::to_string(self)
    }
}

/// 使用生产时钟和进程身份追加已验证配置诊断，任何记录失败都不阻断启动。
fn record_configuration_identity(
    log_path: &Path,
    config: Option<&AdapterConfig>,
    app_version: &str,
) {
    let Ok(recorded_at) = OffsetDateTime::now_utc().format(&Rfc3339) else {
        return;
    };
    record_configuration_identity_with_context(
        log_path,
        config,
        app_version,
        &recorded_at,
        std::process::id(),
    );
}

/// 将注入的时间与进程身份写入固定 updater JSON Lines 边界。
fn record_configuration_identity_with_context(
    log_path: &Path,
    config: Option<&AdapterConfig>,
    app_version: &str,
    recorded_at: &str,
    process_id: u32,
) {
    let Some(config) = config else {
        return;
    };
    let Some(parent) = log_path.parent() else {
        return;
    };
    if fs::create_dir_all(parent).is_err() {
        return;
    }
    let record =
        SafeUpdaterConfigurationLog::from_config(config, app_version, recorded_at, process_id);
    if let (Ok(line), Ok(mut file)) = (
        record.to_json(),
        OpenOptions::new().create(true).append(true).open(log_path),
    ) {
        let _ = writeln!(file, "{line}");
    }
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

    /// 在第二次移动失败时记录可观察的回滚路径。
    struct ScriptedRename {
        calls: Vec<(PathBuf, PathBuf)>,
        fail_on: Vec<usize>,
    }

    impl RenameBoundary for ScriptedRename {
        /// 按调用序号模拟文件系统失败，其余调用成功。
        fn rename(&mut self, source: &Path, destination: &Path) -> std::io::Result<()> {
            self.calls.push((source.into(), destination.into()));
            if self.fail_on.contains(&self.calls.len()) {
                Err(std::io::Error::other("injected replacement failure"))
            } else {
                Ok(())
            }
        }
    }

    /// 记录恢复后离线安装拿到的可信计划，不访问网络。
    struct OfflineRecorder {
        observed: Option<(String, String, super::InstallKind, bool)>,
    }

    impl super::OfflinePackageInstaller for OfflineRecorder {
        /// 记录 repository 复验后交付的安装计划。
        fn install(
            &mut self,
            package: &Path,
            version: &str,
            target: &str,
            install_kind: super::InstallKind,
            relaunch: bool,
        ) -> Result<super::OfflineInstallOutcome, String> {
            assert_eq!(fs::read(package).unwrap(), b"test");
            self.observed = Some((version.into(), target.into(), install_kind, relaunch));
            Ok(super::OfflineInstallOutcome {
                relaunch_handled: false,
                cleanup: super::OfflineInstallCleanup::CompleteNow,
            })
        }
    }

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

    /// 已验证配置会以规范化 endpoint 和固定公钥指纹写入既有 updater 日志。
    #[test]
    fn validated_configuration_records_exact_safe_identity() {
        let directory = tempfile::tempdir().unwrap();
        let log_path = directory.path().join("logs").join("updater.jsonl");
        let public_key = "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXkgRTc2MjBGMTg0MkI0RTgxRgpSV1FmNkxSQ0dBOWk1M21sWWVjTzRJelQ1MVRHUHB2V3VjTlNDaDFDQk0wUVRhTG43M1k3R0ZPMw==";
        let config = AdapterConfig::parse(
            Some("https://UPDATES.EXAMPLE:443/dsh-desktop/channels/stable/latest.json"),
            Some(public_key),
        )
        .unwrap();

        record_configuration_identity_with_context(
            &log_path,
            Some(&config),
            "2.1.0",
            "2026-08-29T02:03:04Z",
            4242,
        );

        let line = fs::read_to_string(&log_path).unwrap();
        let value: serde_json::Value = serde_json::from_str(line.trim()).unwrap();
        assert_eq!(
            value,
            serde_json::json!({
                "event": "updater-configuration-identity",
                "app_version": "2.1.0",
                "endpoint": "https://updates.example/dsh-desktop/channels/stable/latest.json",
                "public_key_sha256": "98bc2519dc9034c5a0bfbc5dbb808404cfc4db8e957783124c128a3732ed913a",
                "platform": format!("{}-{}", std::env::consts::OS, std::env::consts::ARCH),
                "correlation_id": "updater-configuration",
                "recorded_at": "2026-08-29T02:03:04Z",
                "process_id": 4242
            })
        );
        assert!(!line.contains(public_key));
        assert!(!line.contains(directory.path().to_string_lossy().as_ref()));
        assert!(!line.contains("signature"));
    }

    /// 缺失或无效配置不会产生成功的 updater 配置身份。
    #[test]
    fn invalid_configuration_records_no_success_identity() {
        let directory = tempfile::tempdir().unwrap();
        let log_path = directory.path().join("logs").join("updater.jsonl");
        let config = AdapterConfig::parse(
            Some("http://updates.example/latest.json"),
            Some("not-base64"),
        );

        record_configuration_identity_with_context(
            &log_path,
            config.as_ref().ok(),
            "2.1.0",
            "2026-08-29T02:03:04Z",
            4242,
        );

        assert!(!log_path.exists());
    }

    /// Manifest 有总时限，大包下载只有连接和读取空闲时限。
    #[test]
    fn package_download_policy_has_no_total_timeout() {
        assert_eq!(MANIFEST_HTTP_TIMEOUT, Duration::from_secs(30));
        assert_eq!(
            PackageClientPolicy::production(),
            PackageClientPolicy {
                connect_timeout: Duration::from_secs(30),
                read_idle_timeout: Duration::from_secs(60),
            }
        );
        PackageClientPolicy::production().build_client().unwrap();
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

    /// AppImage 候选替换失败时只移动一次当前应用并恢复备份。
    #[test]
    fn appimage_replacement_failure_rolls_back_original() {
        let mut boundary = ScriptedRename {
            calls: Vec::new(),
            fail_on: vec![2],
        };
        assert_eq!(
            replace_with_rollback(
                &mut boundary,
                Path::new("current.AppImage"),
                Path::new("candidate.AppImage"),
                Path::new("backup.AppImage"),
                || Ok(()),
            ),
            Err(ReplaceTransactionError::RolledBack)
        );
        assert_eq!(
            boundary.calls,
            [
                (
                    PathBuf::from("current.AppImage"),
                    PathBuf::from("backup.AppImage")
                ),
                (
                    PathBuf::from("candidate.AppImage"),
                    PathBuf::from("current.AppImage")
                ),
                (
                    PathBuf::from("backup.AppImage"),
                    PathBuf::from("current.AppImage")
                ),
            ]
        );
    }

    /// 候选替换与回滚同时失败时必须报告 backup 仍需持久保留。
    #[test]
    fn appimage_rollback_failure_is_distinguished() {
        let mut boundary = ScriptedRename {
            calls: Vec::new(),
            fail_on: vec![2, 3],
        };
        assert_eq!(
            replace_with_rollback(
                &mut boundary,
                Path::new("current.AppImage"),
                Path::new("candidate.AppImage"),
                Path::new("backup.AppImage"),
                || Ok(()),
            ),
            Err(ReplaceTransactionError::RollbackFailed)
        );
    }

    /// 候选落位后的权限处理失败也必须恢复旧 AppImage。
    #[test]
    fn appimage_post_replace_failure_rolls_back_original() {
        let mut boundary = ScriptedRename {
            calls: Vec::new(),
            fail_on: Vec::new(),
        };
        assert_eq!(
            replace_with_rollback(
                &mut boundary,
                Path::new("current.AppImage"),
                Path::new("candidate.AppImage"),
                Path::new("backup.AppImage"),
                || Err(()),
            ),
            Err(ReplaceTransactionError::RolledBack)
        );
        assert_eq!(boundary.calls.len(), 3);
    }

    /// 损坏偏好不会阻断 controller 初始化，并安全回退自动下载开启。
    #[test]
    fn corrupt_preference_is_non_blocking_and_defaults_enabled() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("updater-preference.json");
        fs::write(&path, b"not-json").unwrap();
        let controller =
            UpdateController::new("2.0.15", SystemClock::new(), FilePreferenceStore::new(path));
        assert!(controller.unwrap().snapshot().automatic_download);
    }

    /// 偏好构造后采用的值不会因 controller 初始化前文件变化而二次读取。
    #[test]
    fn preference_value_is_adopted_from_a_single_read() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("updater-preference.json");
        fs::write(&path, br#"{"automatic_download":false}"#).unwrap();
        let store = FilePreferenceStore::new(path.clone());
        fs::write(&path, br#"{"automatic_download":true}"#).unwrap();
        let controller = UpdateController::new("2.0.15", SystemClock::new(), store).unwrap();
        assert!(!controller.snapshot().automatic_download);
    }

    /// 自动下载偏好可以原子覆盖已有文件，且失败不会残留临时文件。
    #[test]
    fn preference_save_replaces_existing_file_and_cleans_failed_temporary() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("updater-preference.json");
        let mut store = FilePreferenceStore::new(path.clone());
        store.save_automatic_download(false).unwrap();
        store.save_automatic_download(true).unwrap();
        assert!(
            serde_json::from_slice::<StoredPreference>(&fs::read(&path).unwrap())
                .unwrap()
                .automatic_download
        );

        fs::remove_file(&path).unwrap();
        fs::create_dir(&path).unwrap();
        assert!(store.save_automatic_download(false).is_err());
        assert!(!path.with_extension("json.tmp").exists());
    }

    /// 并发输入的发布顺序必须与 controller 单调 sequence 完全一致。
    #[test]
    fn concurrent_snapshot_publication_is_strictly_ordered() {
        let directory = tempfile::tempdir().unwrap();
        let controller = Arc::new(Mutex::new(
            UpdateController::new(
                "2.0.15",
                SystemClock::new(),
                FilePreferenceStore::new(directory.path().join("preference.json")),
            )
            .unwrap(),
        ));
        let gate = Arc::new(Mutex::new(()));
        let observed = Arc::new(Mutex::new(Vec::new()));
        let threads: Vec<_> = (0..24)
            .map(|_| {
                let controller = Arc::clone(&controller);
                let gate = Arc::clone(&gate);
                let observed = Arc::clone(&observed);
                std::thread::spawn(move || {
                    transition_and_publish(
                        &gate,
                        &controller,
                        UpdateInput::ManualCheck,
                        |snapshot| {
                            observed.lock().unwrap().push(snapshot.sequence);
                        },
                    );
                })
            })
            .collect();
        for thread in threads {
            thread.join().unwrap();
        }
        assert_eq!(*observed.lock().unwrap(), (1..=24).collect::<Vec<_>>());
    }

    /// 过期下载 effect 不能消费随后检查写入的另一版本 pending Update。
    #[test]
    fn stale_download_effect_does_not_match_new_pending_version() {
        assert!(!pending_version_matches(
            "2.2.0",
            &StableRelease {
                version: "2.1.0".into(),
                release_notes: String::new(),
            }
        ));
    }

    /// 清理旧 staging 失败时领域进入失败态，正常退出不得安装磁盘残留。
    #[test]
    fn discard_failure_suppresses_normal_exit_installation() {
        let cache = tempfile::tempdir().unwrap();
        let key_text = "untrusted comment: minisign public key E7620F1842B4E81F\nRWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3";
        let signature_text = "untrusted comment: signature from minisign secret key\nRWQf6LRCGA9i59SLOFxz6NxvASXDJeRtuZykwQepbDEGt87ig1BNpWaVWuNrm73YiIiJbq71Wi+dP9eKL8OC351vwIasSSbXxwA=\ntrusted comment: timestamp:1555779966\tfile:test\nQtKMXWyYcwdpZAlPF7tE2ENJkRd1ujvKjlj1m9RtHTBnZPa5WKU5uWRs5GoP5M/VqE81QFuMKI5k/SfNQUaOAA==";
        let key = base64::engine::general_purpose::STANDARD.encode(key_text);
        let signature = base64::engine::general_purpose::STANDARD.encode(signature_text);
        let mut repository =
            StagingRepository::open(cache.path(), TauriMinisignVerifier::new(&key).unwrap())
                .unwrap();
        repository
            .stage(
                StageCandidate::with_install_plan(
                    "2.1.0",
                    &signature,
                    &tauri_plugin_updater::target().unwrap(),
                    InstallKind::current(),
                )
                .unwrap(),
                b"test".as_slice(),
            )
            .unwrap();
        let metadata = cache.path().join("desktop-update/staged.json");
        fs::remove_file(&metadata).unwrap();
        fs::create_dir(&metadata).unwrap();
        let input = prepare_checked_release(
            Some(&mut repository),
            StableRelease {
                version: "2.2.0".into(),
                release_notes: String::new(),
            },
        );
        assert_eq!(input, UpdateInput::StagingDiscardFailed);
        let mut controller = UpdateController::new(
            "2.0.15",
            SystemClock::new(),
            FilePreferenceStore::new(cache.path().join("preference.json")),
        )
        .unwrap();
        controller
            .handle(UpdateInput::RecoverStaged {
                version: "2.1.0".into(),
            })
            .unwrap();
        let failed = controller.handle(input).unwrap().snapshot;
        assert!(matches!(
            failed.state,
            UpdateState::Failed {
                retryable: false,
                ..
            }
        ));
        assert!(!staged_install_allowed(&failed, true));
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

    /// 下载完成后的临时文件即使游标位于 EOF，也必须从头复制并验签进入 staging。
    #[test]
    fn downloaded_package_is_rewound_before_staging() {
        let cache = tempfile::tempdir().unwrap();
        let public_key_text = "untrusted comment: minisign public key E7620F1842B4E81F\nRWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3";
        let signature_text = "untrusted comment: signature from minisign secret key\nRWQf6LRCGA9i59SLOFxz6NxvASXDJeRtuZykwQepbDEGt87ig1BNpWaVWuNrm73YiIiJbq71Wi+dP9eKL8OC351vwIasSSbXxwA=\ntrusted comment: timestamp:1555779966\tfile:test\nQtKMXWyYcwdpZAlPF7tE2ENJkRd1ujvKjlj1m9RtHTBnZPa5WKU5uWRs5GoP5M/VqE81QFuMKI5k/SfNQUaOAA==";
        let key = base64::engine::general_purpose::STANDARD.encode(public_key_text);
        let signature = base64::engine::general_purpose::STANDARD.encode(signature_text);
        let mut repository =
            StagingRepository::open(cache.path(), TauriMinisignVerifier::new(&key).unwrap())
                .unwrap();
        let mut package = tempfile::NamedTempFile::new().unwrap();
        package.write_all(b"test").unwrap();

        let staged = stage_downloaded_package(
            &mut repository,
            StageCandidate::with_install_plan(
                "2.1.0",
                &signature,
                &tauri_plugin_updater::target().unwrap(),
                InstallKind::current(),
            )
            .unwrap(),
            &mut package,
        )
        .unwrap();

        assert_eq!(staged.version(), "2.1.0");
        assert_eq!(
            fs::read(cache.path().join("desktop-update/package.bin")).unwrap(),
            b"test"
        );
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

    /// 恢复 staging 后无需 manifest 或网络即可按持久化可信计划安装。
    #[test]
    fn recovered_staged_package_installs_offline() {
        let cache = tempfile::tempdir().unwrap();
        let key_text = "untrusted comment: minisign public key E7620F1842B4E81F\nRWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3";
        let signature_text = "untrusted comment: signature from minisign secret key\nRWQf6LRCGA9i59SLOFxz6NxvASXDJeRtuZykwQepbDEGt87ig1BNpWaVWuNrm73YiIiJbq71Wi+dP9eKL8OC351vwIasSSbXxwA=\ntrusted comment: timestamp:1555779966\tfile:test\nQtKMXWyYcwdpZAlPF7tE2ENJkRd1ujvKjlj1m9RtHTBnZPa5WKU5uWRs5GoP5M/VqE81QFuMKI5k/SfNQUaOAA==";
        let key = base64::engine::general_purpose::STANDARD.encode(key_text);
        let signature = base64::engine::general_purpose::STANDARD.encode(signature_text);
        let mut repository =
            StagingRepository::open(cache.path(), TauriMinisignVerifier::new(&key).unwrap())
                .unwrap();
        let target = tauri_plugin_updater::target().unwrap();
        repository
            .stage(
                StageCandidate::with_install_plan(
                    "2.1.0",
                    &signature,
                    &target,
                    super::InstallKind::current(),
                )
                .unwrap(),
                b"test".as_slice(),
            )
            .unwrap();
        drop(repository);
        let mut recovered =
            StagingRepository::open(cache.path(), TauriMinisignVerifier::new(&key).unwrap())
                .unwrap();
        let mut installer = OfflineRecorder { observed: None };
        let outcome =
            super::install_verified_offline(&mut recovered, &mut installer, true).unwrap();
        assert!(!outcome.relaunch_handled);
        assert_eq!(
            installer.observed,
            Some(("2.1.0".into(), target, super::InstallKind::current(), true))
        );
        assert!(recovered.snapshot().is_none());
    }

    /// Windows installer handoff 仅表示已启动，staging 必须留给下次启动确认。
    #[test]
    fn deferred_installer_handoff_keeps_staging() {
        struct DeferredInstaller;
        impl OfflinePackageInstaller for DeferredInstaller {
            /// 模拟 NSIS 已启动但安装尚未证实完成。
            fn install(
                &mut self,
                _: &Path,
                _: &str,
                _: &str,
                _: InstallKind,
                _: bool,
            ) -> Result<OfflineInstallOutcome, String> {
                Ok(OfflineInstallOutcome {
                    relaunch_handled: true,
                    cleanup: OfflineInstallCleanup::Deferred,
                })
            }
        }
        let cache = tempfile::tempdir().unwrap();
        let key_text = "untrusted comment: minisign public key E7620F1842B4E81F\nRWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3";
        let signature_text = "untrusted comment: signature from minisign secret key\nRWQf6LRCGA9i59SLOFxz6NxvASXDJeRtuZykwQepbDEGt87ig1BNpWaVWuNrm73YiIiJbq71Wi+dP9eKL8OC351vwIasSSbXxwA=\ntrusted comment: timestamp:1555779966\tfile:test\nQtKMXWyYcwdpZAlPF7tE2ENJkRd1ujvKjlj1m9RtHTBnZPa5WKU5uWRs5GoP5M/VqE81QFuMKI5k/SfNQUaOAA==";
        let key = base64::engine::general_purpose::STANDARD.encode(key_text);
        let signature = base64::engine::general_purpose::STANDARD.encode(signature_text);
        let mut repository =
            StagingRepository::open(cache.path(), TauriMinisignVerifier::new(&key).unwrap())
                .unwrap();
        repository
            .stage(
                StageCandidate::with_install_plan(
                    "2.1.0",
                    &signature,
                    &tauri_plugin_updater::target().unwrap(),
                    InstallKind::current(),
                )
                .unwrap(),
                b"test".as_slice(),
            )
            .unwrap();
        install_verified_offline(&mut repository, &mut DeferredInstaller, true).unwrap();
        assert_eq!(repository.snapshot().unwrap().version(), "2.1.0");
    }

    /// Windows 正常退出不会请求 installer reopen，显式重启才使用 `/R`。
    #[test]
    fn windows_nsis_relaunch_is_explicit() {
        assert_eq!(windows_nsis_args(false), ["/P", "/UPDATE"]);
        assert_eq!(windows_nsis_args(true), ["/P", "/UPDATE", "/R"]);
    }
}
