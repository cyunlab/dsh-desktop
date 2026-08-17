# DeepSeek Harness Desktop README 调研

调研日期：2026-08-17

## 调研范围

本笔记只采用一手资料：GitHub 官方文档，以及成熟开源项目自己的仓库、README 和贡献文档。重点回答四个问题：README 应如何组织，中英文如何并存，路线图如何表达，以及贡献、安全和许可证信息应该放在哪里。

参考项目选择了与本项目接近的跨平台桌面应用或桌面开发项目：LocalSend、AppFlowy、Zed、Tauri；另参考 World Monitor 的独立中文 README 结构。

## 核心结论

### 1. README 是项目入口，不应成为完整手册

GitHub 官方列出的 README 基本问题是：项目做什么、为什么有用、如何开始、到哪里求助、谁维护或贡献。GitHub 同时建议 README 只保留使用和参与项目所需的入门信息，长文档放到 Wiki 或其他专门文档中。[GitHub：About READMEs](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-readmes)

因此，面向 DeepSeek Harness Desktop 的 README 应优先完成以下阅读路径：

1. 首屏看懂项目名称、定位、当前成熟度和支持平台。
2. 很快看见真实界面或演示，以及下载或本地运行入口。
3. 分清“今天已经能做什么”和“未来想做什么”。
4. 再按需要进入开发、贡献、路线图、安全策略等专门文档。

LocalSend 的 README 依次提供项目定义、截图、下载、工作原理、入门和贡献；AppFlowy 把用户安装放在开发说明之前；Zed 的 README 也先给安装入口，再给开发和贡献链接。这些桌面项目都优先服务想试用产品的人，而不只服务源码贡献者。[LocalSend README](https://github.com/localsend/localsend/blob/main/README.md) · [AppFlowy README](https://github.com/AppFlowy-IO/AppFlowy/blob/main/README.md) · [Zed README](https://github.com/zed-industries/zed/blob/main/README.md)

### 2. 推荐的 README 结构

推荐按以下顺序组织中文主 README，英文版保持同样的段落顺序：

1. **Hero 首屏**：Logo、项目名、一句话价值主张、语言切换、下载/路线图/参与项目入口。
2. **项目状态**：用一句醒目的说明标明早期开发、可运行范围、签名或发布限制。
3. **产品截图或短演示**：优先展示真实工作区；如果 UI 还不稳定，可以暂时放“待补”而不使用概念图冒充成品。
4. **为什么是桌面端**：用三到五点解释桌面窗口、快捷键、托盘、通知、悬浮组件等浏览器难以覆盖的能力。
5. **当前能力**：只写仓库今天确实已经实现并验证的能力。
6. **愿景与插件理念**：解释积木式 UI、可组合能力，以及 “Everything is a plugin” 对用户意味着什么。
7. **路线图摘要**：使用近期/下一步/长期或 Now/Next/Later，仅描述方向；详细状态链接到 GitHub Issues、Projects 或独立 `ROADMAP.md`。
8. **安装或试用**：有正式产物时把下载放在源码开发之前；当前无公开发行时明确写出这一事实。
9. **本地开发与构建**：给出最短的可复制命令，并链接到更完整的开发说明。
10. **架构摘要**：一张小图解释 Desktop、Harness Host、Web Client、Plugins 的边界即可。
11. **贡献、求助与安全**：README 只做短入口，分别链接 Issues、`CONTRIBUTING.md` 和 `SECURITY.md`。
12. **许可证与致谢**：明确代码许可证、Logo/商标的不同许可（如有）和关键上游依赖。

Tauri 的 README 是“简介 → 快速开始 → 能力和平台 → 贡献 → 许可证”的紧凑范例，并把深入架构链接到单独的 `ARCHITECTURE.md`。[Tauri README](https://github.com/tauri-apps/tauri/blob/dev/README.md)

### 3. 首屏文案应把能力翻译成用户价值

Logo 和项目名下面应是一句可复述的定位，不要直接堆叠实现名词。建议围绕这个核心表达：

> 把 DeepSeek Harness 带到桌面，并把桌面变成可自由组合的 AI 工作空间。

“Everything is a plugin” 适合作为愿景口号，但紧接着要解释其用户含义，例如：

> 功能可以安装、替换和组合；界面区块、桌面能力与工作流都能按需拼装，核心保持轻量，每个人都能搭出适合自己的工作空间。

这类写法与 AppFlowy 的处理方式一致：它先说明用户获得数据控制和原生体验，再把“社区驱动的可扩展性”落到插件、模板和可组合工具箱上，而不是只写抽象理念。[AppFlowy README](https://github.com/AppFlowy-IO/AppFlowy/blob/main/README.md)

首屏还应避免三个问题：

- 不把尚未实现的路线图功能写成当前卖点。
- 不在没有正式安装包时放一个看似可用的下载按钮。
- 不用大量 badges 挤占定位、状态和核心行动入口；只有 CI、许可证、最新发布等能帮助决策的 badge 才值得保留。

### 4. 中英文采用独立文件，中文作为默认入口

结合项目当前受众和用户提出的中文内容，建议：

- 根目录 `README.md` 使用简体中文。
- 根目录 `README.en.md` 使用英文。
- 两份文件首屏都放显眼的 `简体中文 / English` 切换链接。
- 两份文件保持相同标题层级和能力清单，变更时同一提交同步更新。
- 仓库内图片和文档使用相对链接；GitHub 会根据当前分支转换相对路径，克隆到本地后也更可靠。[GitHub：About READMEs](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-readmes)

LocalSend 将英文作为默认 README，并在首屏链接多份本地化 README；World Monitor 也维护单独的 `README.zh-CN.md`，并在顶部链接其他语言。这说明“一个语言一个文件、首屏互链”是成熟项目中可执行的策略。[LocalSend README](https://github.com/localsend/localsend/blob/main/README.md) · [World Monitor 中文 README](https://github.com/koala73/worldmonitor/blob/main/README.zh-CN.md)

不建议在同一 README 内逐段中英对照，因为它会加倍首屏长度，让目录、锚点和后续维护都更混乱。两份 README 的风险是内容漂移，因此应把“同步更新 README.md 与 README.en.md”加入 PR 检查清单。

### 5. 路线图要表达方向、确定性和反馈入口

README 中的路线图适合使用 **近期 / 下一步 / 长期建设** 三档，并在开头明确：内容会随反馈调整，不代表固定顺序或交付承诺。每一项应描述用户结果，不只是内部技术任务。

建议把当前设想整理为三层：

| 层级 | 建议内容 |
| --- | --- |
| 近期 | 积木式 UI、快速唤出聊天、多窗口会话、系统托盘、原生消息提醒、主题定制 |
| 下一步 | 悬浮桌面组件、局域网手机控制、默认实用插件、插件管理界面、UI 插件扩展点 |
| 长期建设 | 插件权限与能力声明、插件 API 版本和兼容策略、自动更新与正式签名、启动项和后台策略、配置与会话备份迁移、无障碍与界面多语言 |

其中，建议新增的事项并非单纯扩展功能列表，而是在为插件化桌面产品补齐可信运行所需的基础设施：

- **插件管理**：安装、启停、更新、卸载和故障隔离。
- **能力与权限声明**：文件、网络、通知、快捷键、悬浮窗口等敏感能力要可见且可控。
- **兼容策略**：插件 API 版本、弃用周期和兼容性检查。
- **可靠发布**：代码签名、自动更新、稳定/预览通道和回滚策略。
- **数据可迁移**：配置、布局、会话和插件数据的备份与恢复。
- **无障碍与多语言**：快捷键可达、读屏、缩放、高对比度和本地化。

AppFlowy 在主 README 中只保留 Roadmap 入口，把细节链接到单独的路线图和公开看板，并同时提供 feature request 与 bug report 入口；这比在 README 中长期维护巨大的 checkbox 清单更不易过时。[AppFlowy README](https://github.com/AppFlowy-IO/AppFlowy/blob/main/README.md)

当路线图变大后，建议迁移到独立 `ROADMAP.md` 或 GitHub Projects，README 只保留三到六个主题和链接。GitHub 会为 README 自动生成标题目录，因此清楚、稳定的标题层级已经足够，无需手写超长目录。[GitHub：About READMEs](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-readmes)

### 6. 贡献说明应短，但仓库要有独立规范

README 中可以保留以下最短贡献入口：

- 功能建议和 bug 去哪里提交。
- 开始大功能前是否需要先开 Issue 或 Discussion。
- 提交前要运行哪些检查。
- `deepseek-harness/` 是只读子模块，不能直接修改。
- 完整流程链接到 `CONTRIBUTING.md`。

GitHub 会在仓库总览、Contribute 页面、创建 Issue 和 PR 时自动展示 `CONTRIBUTING.md` 链接；独立文件因此比把全部规则塞进 README 更容易被正确看到。[GitHub：Setting guidelines for repository contributors](https://docs.github.com/en/communities/setting-up-your-project-for-healthy-contributions/setting-guidelines-for-repository-contributors)

Zed 的贡献文档还给出一个适合本项目的边界：小修复可以直接 PR，大功能先通过 Discussion 或 Issue 确认方向，以减少实现后才发现不符合产品路线的浪费。[Zed CONTRIBUTING](https://github.com/zed-industries/zed/blob/main/CONTRIBUTING.md)

### 7. 安全信息不要只写在 README，更不能让漏洞走公开 Issue

该项目运行本地 Host，未来还计划开放插件权限、局域网控制和悬浮窗口，因此安全披露是项目入口的一部分。建议：

- 新增 `.github/SECURITY.md` 或根目录 `SECURITY.md`。
- 写明受支持版本和更新范围。
- 提供非公开漏洞报告渠道，例如 GitHub Private Vulnerability Reporting 或专用邮箱。
- README 的“安全”小节只链接该策略，并提醒不要通过公开 Issue 披露漏洞。
- 对局域网控制在 README 路线图中明确“显式授权和安全配对”，避免读者误解成默认暴露本地服务。

GitHub 官方明确建议 `SECURITY.md` 至少说明受支持版本以及如何报告漏洞；仓库的 Community Profile 也会检查安全策略和其他社区健康文件。[GitHub：Adding a security policy](https://docs.github.com/en/code-security/how-tos/report-and-fix-vulnerabilities/configure-vulnerability-reporting/add-security-policy) · [GitHub：Community profiles](https://docs.github.com/en/communities/setting-up-your-project-for-healthy-contributions/about-community-profiles-for-public-repositories)

### 8. 许可证是当前仓库最需要补齐的信任信息

截至调研时，仓库根目录未发现 `LICENSE`、`CONTRIBUTING.md`、`SECURITY.md` 或 `CODE_OF_CONDUCT.md`。其中许可证优先级最高：GitHub 官方说明，开源许可证赋予他人使用、修改和分发项目的权利；可识别的许可证也会直接显示在仓库页面上。[GitHub：Adding a license](https://docs.github.com/en/communities/setting-up-your-project-for-healthy-contributions/adding-a-license-to-a-repository)

因此，在维护者选定许可证之前，README 不宜笼统宣称项目已经是“开源软件”。选定后应：

- 在根目录加入标准 `LICENSE` 文件。
- 在 README 末尾写明许可证并链接该文件。
- 如 Logo、名称或上游 DeepSeek Harness 有不同授权，单独说明代码、品牌资源和上游组件的边界。
- 再逐步补齐 `CONTRIBUTING.md`、`SECURITY.md` 和 `CODE_OF_CONDUCT.md`。GitHub 将 README、LICENSE、CONTRIBUTING 和 CODE_OF_CONDUCT 作为推荐的社区健康文件。[GitHub：Community profiles](https://docs.github.com/en/communities/setting-up-your-project-for-healthy-contributions/about-community-profiles-for-public-repositories)

## 针对本仓库的落地建议

### README 本轮应直接完成

- 使用现有 `assets/dsh-desktop-logo.svg`，显示项目全名和一句定位。
- 中文 `README.md` 与英文 `README.en.md` 首屏互链。
- 明确“早期开发”“首个可运行版本已完成”“公开发行、签名和自动更新仍在规划中”。
- 分开写“已有能力”和“路线图”。
- 把“Everything is a plugin” 解释为可安装、替换、组合的界面、桌面能力与工作流，而不是停留在口号。
- 保留简短架构图、本地开发命令、构建目标和 unsigned 提醒。
- 路线图采用三段时间范围，并给 GitHub Issues 反馈入口。

### 后续独立任务

1. 选择并加入 `LICENSE`，确认 Logo、项目名称和上游组件的许可边界。
2. 新增 `CONTRIBUTING.md`，吸收现有 `docs/agents/issue-tracker.md`、代码检查和只读子模块规则。
3. 新增 `SECURITY.md`，启用或公布私密漏洞报告渠道。
4. 需要公开发版后，在首屏加入真实下载入口、版本 badge 和产品截图/短演示。
5. 路线图开始频繁变化后，迁移到 `ROADMAP.md` 或 GitHub Projects，并让 README 只保留摘要。

## 验收清单

- [ ] 首屏五秒内能回答项目是什么、适合谁、现在是否可用。
- [ ] Logo、项目名、定位和语言切换不需要滚动即可看到。
- [ ] 当前能力与规划能力没有混写。
- [ ] 中文和英文版标题结构、链接、能力列表保持一致。
- [ ] 开发命令可以从干净环境复制执行。
- [ ] 下载、平台、签名和项目阶段没有夸大或模糊表述。
- [ ] 路线图注明会调整，并提供反馈入口。
- [ ] 贡献入口、求助入口和安全披露入口彼此分开。
- [ ] README 链接到可识别的许可证；如果尚未决定，避免宣称“开源”。
- [ ] 所有仓库内图片和文档链接使用相对路径并可在 GitHub 与本地克隆中打开。
