## Agent skills

### Git submodules

`deepseek-harness/` is a Git submodule. Do not modify any files or code inside it; treat the entire directory as read-only.

### Issue tracker

Issues are tracked in GitHub Issues for this repository. See `docs/agents/issue-tracker.md`.

### Triage labels

Triage uses the five default canonical labels. See `docs/agents/triage-labels.md`.

### Domain docs

Domain documentation uses the single-context layout. See `docs/agents/domain.md`.


## read mode(read {file})
用于代码审核与阅读， 读取给出的源代码文件 file，整理它的 mermaid 类图，并逐行添加注释后输出。直接输出 markdown 文本，不要写入到任何文件。

## 代码风格
- 在每一个类或函数前添加中文注释

## Subagent Handoff 开发模式
当显式要求使用此模式时：使用 subagent + worktree + implement skill 的方式开发代码，需要给出详细的 spec 给 subagent。

## 注意
本项目使用 tauri，在构建过程中可能会产生大量的构建产物，占满内存，需要及时清理。

## Cargo 验证节奏
- 首次 Rust 验证前先运行 `pnpm build` 生成 Tauri 所需的 `dist/`。
- 多个 worktree 中的 Agent 统一通过 `scripts/cargo-agent.sh` 运行 Cargo，避免并发冷编译争抢内存和磁盘。
- 实现期间优先运行 `scripts/cargo-agent.sh check` 和聚焦测试；每个 Issue 交付前再运行一次 Rust 全量测试。
- 不同 worktree 保持各自的 `src-tauri/target`；Issue 合并且 worktree 不再使用后，清理其 target。

