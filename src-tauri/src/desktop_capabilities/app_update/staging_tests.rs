use super::staging::{StageCandidate, StagingRepository, UpdateVerifier};
use std::fs;
use std::io::{self, Read};
use std::path::Path;

/// 仅接受内容与签名完全匹配的确定性系统边界验证器。
struct DeterministicVerifier;

impl UpdateVerifier for DeterministicVerifier {
    /// 验证测试包内容与测试签名的绑定关系。
    fn verify(&self, package: &Path, signature: &str) -> Result<(), String> {
        let content = fs::read(package).map_err(|error| error.to_string())?;
        if signature == format!("trusted:{}", String::from_utf8_lossy(&content)) {
            Ok(())
        } else {
            Err("signature mismatch".into())
        }
    }
}

/// 先产生部分内容再模拟网络读取中断的输入流。
struct InterruptedReader {
    emitted: bool,
}

impl Read for InterruptedReader {
    /// 第一次读取返回部分内容，之后返回确定性错误。
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        if self.emitted {
            return Err(io::Error::new(io::ErrorKind::UnexpectedEof, "interrupted"));
        }
        self.emitted = true;
        let partial = b"partial";
        buffer[..partial.len()].copy_from_slice(partial);
        Ok(partial.len())
    }
}

/// 验证已暂存更新可在进程重启后从公开仓储缝隙恢复。
#[test]
fn staged_update_survives_repository_restart() {
    let cache = tempfile::tempdir().unwrap();
    let mut repository = StagingRepository::open(cache.path(), DeterministicVerifier).unwrap();
    let candidate = StageCandidate::new("2.1.0", "trusted:package-v2").unwrap();

    let staged = repository
        .stage(candidate, "package-v2".as_bytes())
        .unwrap();
    assert_eq!(staged.version(), "2.1.0");
    drop(repository);

    let recovered = StagingRepository::open(cache.path(), DeterministicVerifier)
        .unwrap()
        .snapshot();
    assert_eq!(recovered.unwrap().version(), "2.1.0");
}

/// 验证更新版本会替换旧包，而旧版本和同版本候选会被拒绝。
#[test]
fn only_newer_candidate_replaces_the_staged_update() {
    let cache = tempfile::tempdir().unwrap();
    let mut repository = StagingRepository::open(cache.path(), DeterministicVerifier).unwrap();
    repository
        .stage(
            StageCandidate::new("2.1.0", "trusted:package-v2").unwrap(),
            "package-v2".as_bytes(),
        )
        .unwrap();

    assert_eq!(
        repository.stage(
            StageCandidate::new("2.1.0", "trusted:duplicate").unwrap(),
            "duplicate".as_bytes(),
        ),
        Err(super::staging::StagingError::NotNewer)
    );
    assert_eq!(
        repository.stage(
            StageCandidate::new("2.0.9", "trusted:older").unwrap(),
            "older".as_bytes(),
        ),
        Err(super::staging::StagingError::NotNewer)
    );

    repository
        .stage(
            StageCandidate::new("2.2.0", "trusted:package-v3").unwrap(),
            "package-v3".as_bytes(),
        )
        .unwrap();
    assert_eq!(repository.snapshot().unwrap().version(), "2.2.0");
    drop(repository);

    let recovered = StagingRepository::open(cache.path(), DeterministicVerifier).unwrap();
    assert_eq!(recovered.snapshot().unwrap().version(), "2.2.0");
}

/// 验证签名失败的候选不会成为暂存更新且重启后没有残留状态。
#[test]
fn verification_failure_discards_the_candidate() {
    let cache = tempfile::tempdir().unwrap();
    let mut repository = StagingRepository::open(cache.path(), DeterministicVerifier).unwrap();

    assert_eq!(
        repository.stage(
            StageCandidate::new("2.1.0", "trusted:different-content").unwrap(),
            "untrusted-package".as_bytes(),
        ),
        Err(super::staging::StagingError::VerificationFailed)
    );
    assert_eq!(repository.snapshot(), None);
    drop(repository);

    let recovered = StagingRepository::open(cache.path(), DeterministicVerifier).unwrap();
    assert_eq!(recovered.snapshot(), None);
}

/// 验证安装前复验会发现下载后篡改并清除不可信暂存状态。
#[test]
fn preinstall_verification_detects_tampering_and_cleans_up() {
    let cache = tempfile::tempdir().unwrap();
    let mut repository = StagingRepository::open(cache.path(), DeterministicVerifier).unwrap();
    repository
        .stage(
            StageCandidate::new("2.1.0", "trusted:package-v2").unwrap(),
            "package-v2".as_bytes(),
        )
        .unwrap();
    let verified = repository.verify_for_install().unwrap();
    assert_eq!(verified.version(), "2.1.0");
    fs::write(verified.path(), b"tampered").unwrap();

    assert_eq!(
        repository.verify_for_install(),
        Err(super::staging::StagingError::VerificationFailed)
    );
    assert_eq!(repository.snapshot(), None);
    drop(repository);

    let recovered = StagingRepository::open(cache.path(), DeterministicVerifier).unwrap();
    assert_eq!(recovered.snapshot(), None);
}

/// 验证安装适配器报告成功后仓储清除包与可恢复元数据。
#[test]
fn successful_installation_cleans_the_staged_update() {
    let cache = tempfile::tempdir().unwrap();
    let mut repository = StagingRepository::open(cache.path(), DeterministicVerifier).unwrap();
    repository
        .stage(
            StageCandidate::new("2.1.0", "trusted:package-v2").unwrap(),
            "package-v2".as_bytes(),
        )
        .unwrap();
    let verified = repository.verify_for_install().unwrap();

    repository.complete_install(&verified).unwrap();
    assert_eq!(repository.snapshot(), None);
    drop(repository);

    let recovered = StagingRepository::open(cache.path(), DeterministicVerifier).unwrap();
    assert_eq!(recovered.snapshot(), None);
}

/// Windows installer handoff 后只有新进程版本达到 staging 版本才清理。
#[test]
fn startup_reconciliation_cleans_only_after_version_advances() {
    let cache = tempfile::tempdir().unwrap();
    let mut repository = StagingRepository::open(cache.path(), DeterministicVerifier).unwrap();
    repository
        .stage(
            StageCandidate::new("2.1.0", "trusted:package-v2").unwrap(),
            "package-v2".as_bytes(),
        )
        .unwrap();

    assert!(!repository.reconcile_current_version("2.0.15").unwrap());
    assert_eq!(repository.snapshot().unwrap().version(), "2.1.0");
    assert!(repository.reconcile_current_version("2.1.0").unwrap());
    assert_eq!(repository.snapshot(), None);
}

/// 发现更高 Stable 时仓储立即清除旧 staging，同旧版本则保留。
#[test]
fn discard_older_staging_only_for_newer_replacement() {
    let cache = tempfile::tempdir().unwrap();
    let mut repository = StagingRepository::open(cache.path(), DeterministicVerifier).unwrap();
    repository
        .stage(
            StageCandidate::new("2.1.0", "trusted:package-v2").unwrap(),
            "package-v2".as_bytes(),
        )
        .unwrap();
    assert!(!repository.discard_if_older_than("2.1.0").unwrap());
    assert!(repository.snapshot().is_some());
    assert!(repository.discard_if_older_than("2.2.0").unwrap());
    assert!(repository.snapshot().is_none());
}

/// 验证中断的流式写入不会留下可恢复的部分更新。
#[test]
fn interrupted_stream_is_discarded() {
    let cache = tempfile::tempdir().unwrap();
    let mut repository = StagingRepository::open(cache.path(), DeterministicVerifier).unwrap();
    let result = repository.stage(
        StageCandidate::new("2.1.0", "trusted:partial").unwrap(),
        InterruptedReader { emitted: false },
    );

    assert_eq!(result, Err(super::staging::StagingError::StorageFailed));
    assert_eq!(repository.snapshot(), None);
    drop(repository);

    let recovered = StagingRepository::open(cache.path(), DeterministicVerifier).unwrap();
    assert_eq!(recovered.snapshot(), None);
}

/// 验证重启恢复会拒绝已被篡改的包并清除其元数据。
#[test]
fn recovery_discards_a_tampered_package() {
    let cache = tempfile::tempdir().unwrap();
    let mut repository = StagingRepository::open(cache.path(), DeterministicVerifier).unwrap();
    repository
        .stage(
            StageCandidate::new("2.1.0", "trusted:package-v2").unwrap(),
            "package-v2".as_bytes(),
        )
        .unwrap();
    let package = repository.verify_for_install().unwrap();
    fs::write(package.path(), b"tampered-after-download").unwrap();
    drop(repository);

    let recovered = StagingRepository::open(cache.path(), DeterministicVerifier).unwrap();
    assert_eq!(recovered.snapshot(), None);
}

/// 验证公开暂存快照的调试文本不包含签名或缓存根路径。
#[test]
fn public_snapshot_does_not_expose_signature_or_path() {
    let cache = tempfile::tempdir().unwrap();
    let mut repository = StagingRepository::open(cache.path(), DeterministicVerifier).unwrap();
    repository
        .stage(
            StageCandidate::new("2.1.0", "trusted:private-signature-material").unwrap(),
            "private-signature-material".as_bytes(),
        )
        .unwrap();

    let visible = format!("{:?}", repository.snapshot().unwrap());
    assert_eq!(visible, "StagedUpdate { version: \"2.1.0\" }");
    assert!(!visible.contains(&cache.path().to_string_lossy().to_string()));
    assert!(!visible.contains("trusted:"));
}

/// 验证候选和安装句柄的调试文本同样不会泄露签名或本机路径。
#[test]
fn trusted_handles_redact_sensitive_debug_fields() {
    let cache = tempfile::tempdir().unwrap();
    let candidate = StageCandidate::new("2.1.0", "trusted:package-v2").unwrap();
    assert!(!format!("{candidate:?}").contains("trusted:package-v2"));
    let mut repository = StagingRepository::open(cache.path(), DeterministicVerifier).unwrap();
    repository
        .stage(candidate, "package-v2".as_bytes())
        .unwrap();

    let verified = repository.verify_for_install().unwrap();
    let visible = format!("{verified:?}");
    assert!(!visible.contains(&cache.path().to_string_lossy().to_string()));
    assert!(visible.contains("[redacted]"));
}
