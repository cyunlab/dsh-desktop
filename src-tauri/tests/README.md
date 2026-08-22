# Rust integration tests

这里存放只通过 crate 公开接口运行的 Cargo 黑盒集成测试。

依赖模块私有接口的单元测试放在对应生产模块旁的 `tests/mod.rs` 中，不通过扩大生产 API 可见性来迁入本目录。
