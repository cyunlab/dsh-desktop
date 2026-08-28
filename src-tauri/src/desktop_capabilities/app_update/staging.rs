use semver::Version;
use serde::{Deserialize, Serialize};
use std::fmt;
use std::fs::{self, File};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};

const STAGING_DIRECTORY: &str = "desktop-update";
const METADATA_FILE: &str = "staged.json";
const METADATA_TEMP_FILE: &str = ".staged.json.tmp";
const PACKAGE_FILE: &str = "package.bin";
const PACKAGE_TEMP_FILE: &str = ".package.bin.tmp";

/// 选择受信平台安装实现的持久化分类。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum InstallKind {
    WindowsNsis,
    LinuxAppImage,
    #[default]
    MacosApp,
}

impl InstallKind {
    /// 返回当前构建目标唯一允许的 updater 安装类型。
    pub fn current() -> Self {
        #[cfg(target_os = "windows")]
        return Self::WindowsNsis;
        #[cfg(target_os = "linux")]
        return Self::LinuxAppImage;
        #[cfg(target_os = "macos")]
        return Self::MacosApp;
    }
}

/// 更新包签名验证的系统边界。
pub trait UpdateVerifier {
    /// 使用候选签名验证磁盘上的完整更新包。
    fn verify(&self, package: &Path, signature: &str) -> Result<(), String>;
}

/// 准备进入暂存区的可信 Stable 候选元数据。
#[derive(Clone)]
pub struct StageCandidate {
    version: Version,
    signature: String,
    target: String,
    install_kind: InstallKind,
}

impl fmt::Debug for StageCandidate {
    /// 输出候选版本并固定脱敏签名。
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("StageCandidate")
            .field("version", &self.version)
            .field("signature", &"[redacted]")
            .finish()
    }
}

impl StageCandidate {
    /// 校验并创建一个暂存候选，拒绝非语义化版本和空签名。
    pub fn new(version: &str, signature: &str) -> Result<Self, StagingError> {
        let version = Version::parse(version).map_err(|_| StagingError::InvalidCandidate)?;
        if signature.is_empty() {
            return Err(StagingError::InvalidCandidate);
        }
        Ok(Self {
            version,
            signature: signature.into(),
            target: String::new(),
            install_kind: InstallKind::current(),
        })
    }

    /// 创建绑定 manifest target 与平台安装类型的生产暂存候选。
    pub fn with_install_plan(
        version: &str,
        signature: &str,
        target: &str,
        install_kind: InstallKind,
    ) -> Result<Self, StagingError> {
        let mut candidate = Self::new(version, signature)?;
        if target.trim().is_empty() || install_kind != InstallKind::current() {
            return Err(StagingError::InvalidCandidate);
        }
        candidate.target = target.into();
        candidate.install_kind = install_kind;
        Ok(candidate)
    }
}

/// 可安全公开给状态快照和日志的暂存更新摘要。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StagedUpdate {
    version: String,
}

impl StagedUpdate {
    /// 返回暂存更新版本，不暴露签名或本机路径。
    pub fn version(&self) -> &str {
        &self.version
    }
}

/// 通过安装前复验、可交给受信安装适配器的包句柄。
#[derive(Clone, PartialEq, Eq)]
pub struct VerifiedStagedPackage {
    version: String,
    path: PathBuf,
    target: String,
    install_kind: InstallKind,
}

impl fmt::Debug for VerifiedStagedPackage {
    /// 输出安装句柄版本并隐藏本机包路径。
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("VerifiedStagedPackage")
            .field("version", &self.version)
            .field("path", &"[redacted]")
            .finish()
    }
}

impl VerifiedStagedPackage {
    /// 返回已复验包的版本。
    pub fn version(&self) -> &str {
        &self.version
    }

    /// 返回仅供受信安装适配器使用的本地包路径。
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// 返回下载时由 Tauri 选择并持久化的 manifest target。
    pub fn target(&self) -> &str {
        &self.target
    }

    /// 返回下载时绑定的唯一平台安装类型。
    pub fn install_kind(&self) -> InstallKind {
        self.install_kind
    }
}

/// 暂存仓储的稳定错误分类，不包含本机路径或签名。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StagingError {
    InvalidCandidate,
    NotNewer,
    VerificationFailed,
    StorageFailed,
    NoStagedUpdate,
}

/// 磁盘上的私有暂存元数据。
#[derive(Debug, Serialize, Deserialize)]
struct StoredMetadata {
    version: String,
    signature: String,
    #[serde(default)]
    target: String,
    #[serde(default)]
    install_kind: InstallKind,
}

/// 负责单个已验证更新包持久化、恢复和清理的仓储。
pub struct StagingRepository<V> {
    root: PathBuf,
    verifier: V,
    staged: Option<StoredMetadata>,
}

impl<V: UpdateVerifier> StagingRepository<V> {
    /// 在注入的缓存根下打开仓储并恢复一致的已验证包。
    pub fn open(cache_root: impl AsRef<Path>, verifier: V) -> Result<Self, StagingError> {
        let root = cache_root.as_ref().join(STAGING_DIRECTORY);
        fs::create_dir_all(&root).map_err(|_| StagingError::StorageFailed)?;
        remove_if_exists(&root.join(PACKAGE_TEMP_FILE))?;
        remove_if_exists(&root.join(METADATA_TEMP_FILE))?;

        let staged = recover_metadata(&root, &verifier)?;
        Ok(Self {
            root,
            verifier,
            staged,
        })
    }

    /// 返回不含文件路径与签名的当前暂存快照。
    pub fn snapshot(&self) -> Option<StagedUpdate> {
        self.staged.as_ref().map(|metadata| StagedUpdate {
            version: metadata.version.clone(),
        })
    }

    /// 将输入流写入临时文件，验证成功后原子晋级为唯一暂存包。
    pub fn stage(
        &mut self,
        candidate: StageCandidate,
        mut package: impl Read,
    ) -> Result<StagedUpdate, StagingError> {
        if let Some(current) = &self.staged {
            let current_version =
                Version::parse(&current.version).map_err(|_| StagingError::StorageFailed)?;
            if candidate.version <= current_version {
                return Err(StagingError::NotNewer);
            }
        }
        let package_temp = self.root.join(PACKAGE_TEMP_FILE);
        remove_if_exists(&package_temp)?;
        let result = (|| {
            let mut output =
                File::create(&package_temp).map_err(|_| StagingError::StorageFailed)?;
            io::copy(&mut package, &mut output).map_err(|_| StagingError::StorageFailed)?;
            output.sync_all().map_err(|_| StagingError::StorageFailed)?;
            self.verifier
                .verify(&package_temp, &candidate.signature)
                .map_err(|_| StagingError::VerificationFailed)?;

            let metadata = StoredMetadata {
                version: candidate.version.to_string(),
                signature: candidate.signature,
                target: candidate.target,
                install_kind: candidate.install_kind,
            };
            atomic_replace_file(&package_temp, &self.root.join(PACKAGE_FILE))
                .map_err(|_| StagingError::StorageFailed)?;
            sync_directory(&self.root)?;
            write_metadata(&self.root, &metadata)?;
            Ok(metadata)
        })();
        if let Err(error) = result {
            let _ = remove_if_exists(&package_temp);
            self.staged = recover_metadata(&self.root, &self.verifier)?;
            return Err(error);
        }
        let metadata = result.expect("successful staging result must contain metadata");
        let staged = StagedUpdate {
            version: metadata.version.clone(),
        };
        self.staged = Some(metadata);
        Ok(staged)
    }

    /// 在安装前重新验证当前包，失败时关闭信任并清除暂存状态。
    pub fn verify_for_install(&mut self) -> Result<VerifiedStagedPackage, StagingError> {
        let Some(metadata) = &self.staged else {
            return Err(StagingError::NoStagedUpdate);
        };
        let package = self.root.join(PACKAGE_FILE);
        if self.verifier.verify(&package, &metadata.signature).is_err() {
            self.clear()?;
            return Err(StagingError::VerificationFailed);
        }
        Ok(VerifiedStagedPackage {
            version: metadata.version.clone(),
            path: package,
            target: metadata.target.clone(),
            install_kind: metadata.install_kind,
        })
    }

    /// 在受信安装适配器报告成功后清除与句柄对应的暂存更新。
    pub fn complete_install(
        &mut self,
        installed: &VerifiedStagedPackage,
    ) -> Result<(), StagingError> {
        let Some(metadata) = &self.staged else {
            return Err(StagingError::NoStagedUpdate);
        };
        if installed.version != metadata.version || installed.path != self.root.join(PACKAGE_FILE) {
            return Err(StagingError::InvalidCandidate);
        }
        self.clear()
    }

    /// 在 Desktop 新进程版本达到暂存版本后确认 installer handoff 成功并清理。
    pub fn reconcile_current_version(
        &mut self,
        current_version: &str,
    ) -> Result<bool, StagingError> {
        let Some(metadata) = &self.staged else {
            return Ok(false);
        };
        let current =
            Version::parse(current_version).map_err(|_| StagingError::InvalidCandidate)?;
        let staged = Version::parse(&metadata.version).map_err(|_| StagingError::StorageFailed)?;
        if current < staged {
            return Ok(false);
        }
        self.clear()?;
        Ok(true)
    }

    /// 发现更高 Stable 时立即丢弃旧 staging，为唯一候选腾出可信槽位。
    pub fn discard_if_older_than(
        &mut self,
        replacement_version: &str,
    ) -> Result<bool, StagingError> {
        let Some(metadata) = &self.staged else {
            return Ok(false);
        };
        let replacement =
            Version::parse(replacement_version).map_err(|_| StagingError::InvalidCandidate)?;
        let staged = Version::parse(&metadata.version).map_err(|_| StagingError::StorageFailed)?;
        if replacement <= staged {
            return Ok(false);
        }
        self.clear()?;
        Ok(true)
    }

    /// 删除包与元数据并同步清空公开快照。
    fn clear(&mut self) -> Result<(), StagingError> {
        remove_if_exists(&self.root.join(METADATA_FILE))?;
        remove_if_exists(&self.root.join(PACKAGE_FILE))?;
        remove_if_exists(&self.root.join(METADATA_TEMP_FILE))?;
        remove_if_exists(&self.root.join(PACKAGE_TEMP_FILE))?;
        sync_directory(&self.root)?;
        self.staged = None;
        Ok(())
    }
}

/// 从磁盘恢复元数据，并对包执行一次可信验证。
fn recover_metadata<V: UpdateVerifier>(
    root: &Path,
    verifier: &V,
) -> Result<Option<StoredMetadata>, StagingError> {
    let metadata_path = root.join(METADATA_FILE);
    let package_path = root.join(PACKAGE_FILE);
    if !metadata_path.is_file() || !package_path.is_file() {
        remove_if_exists(&metadata_path)?;
        remove_if_exists(&package_path)?;
        return Ok(None);
    }
    let recovered = fs::read(&metadata_path)
        .map_err(|_| StagingError::StorageFailed)
        .and_then(|bytes| {
            serde_json::from_slice::<StoredMetadata>(&bytes)
                .map_err(|_| StagingError::VerificationFailed)
        })
        .and_then(|metadata| {
            Version::parse(&metadata.version).map_err(|_| StagingError::VerificationFailed)?;
            verifier
                .verify(&package_path, &metadata.signature)
                .map_err(|_| StagingError::VerificationFailed)?;
            Ok(metadata)
        });
    match recovered {
        Ok(metadata) => Ok(Some(metadata)),
        Err(_) => {
            remove_if_exists(&metadata_path)?;
            remove_if_exists(&package_path)?;
            Ok(None)
        }
    }
}

/// 通过同目录临时文件原子替换暂存元数据。
fn write_metadata(root: &Path, metadata: &StoredMetadata) -> Result<(), StagingError> {
    let temporary = root.join(METADATA_TEMP_FILE);
    let destination = root.join(METADATA_FILE);
    let bytes = serde_json::to_vec(metadata).map_err(|_| StagingError::StorageFailed)?;
    let mut file = File::create(&temporary).map_err(|_| StagingError::StorageFailed)?;
    file.write_all(&bytes)
        .and_then(|_| file.sync_all())
        .map_err(|_| StagingError::StorageFailed)?;
    atomic_replace_file(&temporary, &destination).map_err(|_| StagingError::StorageFailed)?;
    sync_directory(root)
}

/// 在支持的平台上以覆盖语义原子替换同一目录中的目标文件。
#[cfg(not(windows))]
pub(crate) fn atomic_replace_file(source: &Path, destination: &Path) -> io::Result<()> {
    fs::rename(source, destination)
}

/// 在 Unix 上同步目录项，确保原子晋级在崩溃恢复后仍然可见。
#[cfg(unix)]
fn sync_directory(directory: &Path) -> Result<(), StagingError> {
    File::open(directory)
        .and_then(|file| file.sync_all())
        .map_err(|_| StagingError::StorageFailed)
}

/// Windows 的覆盖移动已请求 WRITE_THROUGH，无需额外打开目录句柄。
#[cfg(windows)]
fn sync_directory(_directory: &Path) -> Result<(), StagingError> {
    Ok(())
}

/// 在 Windows 上使用系统覆盖语义原子替换同一卷中的目标文件。
#[cfg(windows)]
pub(crate) fn atomic_replace_file(source: &Path, destination: &Path) -> io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };

    let source: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
    let destination: Vec<u16> = destination
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect();
    let moved = unsafe {
        MoveFileExW(
            source.as_ptr(),
            destination.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if moved == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

/// 删除存在的仓储文件，同时把不存在视为成功。
fn remove_if_exists(path: &Path) -> Result<(), StagingError> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err(StagingError::StorageFailed),
    }
}
