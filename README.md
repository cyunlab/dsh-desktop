<div align="center">
  <img src="./assets/dsh-desktop-logo.svg" width="160" alt="DeepSeek Harness Desktop Logo">
  <h1>DeepSeek Harness Desktop</h1>
  <p>更开放的 DeepSeek Harness 桌面应用，所有桌面能力同样支持定制！将“一切皆插件”的理念进一步延伸至桌面。欢迎 ⭐ <a href="https://github.com/XLCYun/dsh-desktop">Star</a>！</p>
  <p><a href="./README.en.md">English</a> · <a href="#下载">下载</a> · <a href="#roadmap">路线图</a> · <a href="#参与项目">参与项目</a></p>
</div>

## 项目简介

DeepSeek Harness Desktop 是一款安装即用的跨平台桌面应用。用户无需单独安装 Node.js，也不用从终端启动服务。

## 为什么还要做一个桌面版

桌面应用拥有网页无法替代的原生能力，例如全局快捷键、多窗口、系统托盘、通知和悬浮组件。遗憾的是，现有桌面应用通常不够开放，这些能力大多只能由应用自身使用。

**我们希望继续发扬“一切皆插件”的理念，把桌面能力也开放为插件能力，供插件直接调用，从而拓展 DeepSeek Harness 插件的能力边界。**

项目目前处于早期开发阶段。第一个可运行版本已经完成，公开发行、签名和自动更新仍在规划中。

## ⬇️ 下载

前往 [GitHub Releases](https://github.com/XLCYun/dsh-desktop/releases) 下载最新版本。每个 Release 提供以下四种安装包，请根据你的操作系统和处理器架构选择：

| 系统 | 适用设备 | 下载 |
| --- | --- | --- |
| Windows | Intel / AMD 64 位 | `windows-x64` |
| macOS | Apple 芯片（M 系列） | `macos-arm64` |
| macOS | Intel 芯片 | `macos-x64` |
| Linux | Intel / AMD 64 位 | `linux-x64` |

## 🧩 一切皆插件

[DeepSeek Harness](https://www.deepseek.com/harness/) 的核心思路是“一切皆插件”。模型、工具、技能、会话、沙箱、存储、调度和 UI 等 Agent 能力都由插件组合而成。

DeepSeek Harness Desktop 希望把这套思路继续带到桌面。我们希望 Desktop 最终成为一个面向插件的桌面能力层。它负责运行客户端，也会把窗口、快捷键、通知和悬浮组件等能力开放给插件直接使用。未来的积木式 UI 可以添加、移动和替换界面区块，核心保持轻量，具体使用方式交给用户和插件决定。

![DeepSeek Harness 一切皆插件，Desktop 将积木式 UI 与原生桌面能力开放给插件](./assets/diagrams/everything-is-a-plugin.svg)

## ✨ 已有能力

✅ 支持 Windows x64、macOS arm64 与 x64、Linux x64

✅ 内置版本匹配的 DeepSeek Harness 运行时，无需预装 Node.js 或 Harness CLI

✅ 自动启动 DeepSeek Harness Host，并在同一窗口打开 Web Client

✅ 单实例运行，重复启动时聚焦已有窗口

✅ 提供启动失败恢复、脱敏诊断和日志目录入口

✅ 包含单元测试、真实 Host 集成测试和 Electron 端到端测试

<a id="roadmap"></a>

## 🗺️ 路线图

路线图会随着使用反馈调整。以下内容代表当前方向，不承诺固定的交付顺序。

### 近期方向

| 方向 | 计划 |
| --- | --- |
| 🔌 为插件提供原生桌面能力 | 把窗口、快捷键、托盘、通知和悬浮组件等原生桌面能力开放给插件调用 |
| 🧩 积木式 UI 与主题定制 | 自由添加、移动和替换页面区块，保存个人布局，并调整颜色、字体、密度和窗口外观 |
| 💬 更快进入会话 | 通过全局快捷键唤出轻量聊天窗口，同时支持多窗口打开不同会话 |
| 🖥️ 更完整的桌面体验 | 加入系统托盘、后台驻留和原生消息提醒，并支持透明、置顶、可穿透的悬浮组件，让桌宠等体验可以走出主窗口 |
| 📱 局域网手机控制 | 通过明确授权和安全配对，让手机成为桌面端的便捷遥控器 |
| 🧰 更好用的插件体验 | 预置一组实用插件，统一管理安装、启停、更新和权限，并允许插件贡献面板、工具栏动作与桌面组件 |

欢迎通过 [GitHub Issues](https://github.com/XLCYun/dsh-desktop/issues) 提议功能或补充使用场景。

## 工作方式

![DeepSeek Harness Desktop 启动本地 DeepSeek Harness Host、显示 Web Client，并允许插件扩展桌面、运行时和界面](./assets/diagrams/desktop-architecture.svg)

Desktop 负责应用生命周期、安全边界和桌面集成。DeepSeek Harness Host 在本机运行并提供服务，Web Client 承载会话与工作区体验。Desktop 还会逐步把原生桌面能力、运行时和界面区块开放给插件调用。

## 本地开发

需要 Node.js 24，并启用 Corepack。仓库固定使用 pnpm 11.7.0。

```sh
git clone --recurse-submodules https://github.com/XLCYun/dsh-desktop.git
cd dsh-desktop
corepack pnpm install
corepack pnpm dev
```

运行检查

```sh
corepack pnpm typecheck
corepack pnpm build
corepack pnpm test
corepack pnpm test:integration
```

运行完整 Electron 端到端测试

```sh
corepack pnpm test:e2e
```

## 构建桌面包

请在目标操作系统上运行原生构建。

```sh
corepack pnpm package
```

产物会写入 `release/`。

| 平台 | 架构 | 格式 |
| --- | --- | --- |
| Windows | x64 | NSIS `.exe` |
| macOS | arm64、x64 | `.dmg` |
| Linux | x64 | `.AppImage` |

当前构建可能没有代码签名。macOS 可能需要在 Finder 中按住 Control 点击应用并选择“打开”；Windows 可能显示 SmartScreen 提示。请只运行来自可信构建的产物。

## 参与项目

- 在提交改动前运行类型检查和相关测试
- 将功能建议与问题提交到 [GitHub Issues](https://github.com/XLCYun/dsh-desktop/issues)
- `deepseek-harness/` 是只读 Git 子模块，请勿直接修改
- 设计与实现约束见 [`docs/spec.md`](./docs/spec.md) 和 [`docs/adr/`](./docs/adr/)

如果你也希望桌面应用 UI 可以像搭积木一样调整，欢迎一起完善它。
