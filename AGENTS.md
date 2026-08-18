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
使用 subagent + worktree + implement skill 的方式开发代码，需要给出详细的 spec 给 subagent。