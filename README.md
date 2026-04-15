# ✨ AI Anywhere Desktop - 你的定制化全能 AI Agent 🚀

> **随时随地，便捷召唤 AI！支持 MCP、Skill 技能库、定时任务与全局追问，将 AI 从简单的“聊天机器人”升级为能够在桌面端长期协作与自动执行任务的“本地 AI 工作站”。**

<p align="center">
  <a href="https://github.com/Komorebi-yaodong/anywheredesktop">
    <img src="https://img.shields.io/badge/GitHub-anywheredesktop-black?style=flat-square&logo=github" alt="GitHub Repo">
  </a>
  <a href="https://github.com/Komorebi-yaodong/anywhere_doc">
    <img src="https://img.shields.io/badge/Docs-anywhere__doc-blue?style=flat-square&logo=readme" alt="Docs Repo">
  </a>
  <img src="https://img.shields.io/badge/Platform-Electron%20Desktop-47848F?style=flat-square&logo=electron" alt="Electron Desktop">
</p>

AI Anywhere Desktop 是一个深度定制化的桌面 AI 智能体工作站。它不仅聚合了多种大模型接口，更提供了完整的本地 AI 自动化能力：主控台、独立对话窗口、快捷输入、快捷召唤、全局追问、MCP 工具系统、Skill 技能库、定时任务与 WebDAV 多端同步，均以桌面端原生体验重新实现。

本项目已不再依赖原来的 uTools 插件运行时，而是采用 **Electron + Vue 3 + Vite** 原生重构，让 Anywhere 真正成为长期驻留本机、可与系统深度交互的桌面应用。

---

## 📸 软件主要功能

### 🚀 多模式交互窗口

1. **主控制台 (Main)**
   * 全局设置、服务商配置、MCP 管理、Skill 管理、定时任务与历史对话入口都集中在这里。
2. **独立对话窗口 (Window)**
   * 支持多轮对话、文件拖拽、图片粘贴、Markdown / 代码高亮、历史恢复、导出与自定义背景。
3. **快捷输入与快捷召唤 (Fast / Quick)**
   * 适合高频轻任务与快速投递内容。
4. **全局追问 (Append / Follow-up)**
   * 可将任意软件中的文本、图片或文件直接继续发送到已打开的目标窗口中。

### 🧠 真正的智能 Agent（MCP 支持）

* 原生支持 **Model Context Protocol (MCP)**；
* 内置文件操作、Python、Shell、联网搜索、时间与任务管理等工具；
* 支持 Super-Agent / Sub-Agent 多智能体协作。

### 📚 Skill 技能库（SOP 编排）

* 将复杂任务封装为标准作业程序；
* 支持子智能体后台静默执行复杂技能，减少主对话上下文污染。

### ⏰ 全天候定时任务

* 基于本地桌面端调度器运行；
* 可让 AI 在后台持续进行日报生成、信息抓取、文件整理与自动化执行。

### ☁️ 数据同步与隐私

* 本地优先的数据存储方案；
* 支持 WebDAV 配置同步与历史对话同步；
* 适合多台电脑间迁移与续接工作流。

### 🖥️ 桌面端专属优化

* 全局快捷键；
* 托盘常驻；
* 多窗口 IPC 协作；
* 更贴近真实桌面工作流的召唤、追问与后台执行体验。

---

## 📚 文档与用户指南

Anywhere Desktop 的用户指南已从主程序仓中拆分出来，统一维护在独立文档仓：

- GitHub 文档仓：<https://github.com/Komorebi-yaodong/anywhere_doc>
- Gitee 文档镜像：<https://gitee.com/Komorebi-yaodong/anywhere_>

### 文档模块导航

| 模块 | 说明 | 文档链接 |
| :-- | :-- | :-- |
| **定时任务** | 创建自动化任务，让 AI 定时执行并生成结果。 | [查看文档](https://github.com/Komorebi-yaodong/anywhere_doc/blob/main/docs/task_doc.md) |
| **历史对话** | 管理本地与云端会话记录，支持恢复、清理与导出。 | [查看文档](https://github.com/Komorebi-yaodong/anywhere_doc/blob/main/docs/chat_doc.md) |
| **快捷助手** | 创建不同类型的助手，掌握快捷召唤与全局追问。 | [查看文档](https://github.com/Komorebi-yaodong/anywhere_doc/blob/main/docs/ai_doc.md) |
| **MCP 服务** | 启用内置工具，接入第三方 MCP 服务。 | [查看文档](https://github.com/Komorebi-yaodong/anywhere_doc/blob/main/docs/mcp_doc.md) |
| **Skill 技能库** | 编写 SOP、封装技能、使用子智能体模式。 | [查看文档](https://github.com/Komorebi-yaodong/anywhere_doc/blob/main/docs/skill_doc.md) |
| **服务商管理** | 配置 API 服务商、模型与多 Key 轮询。 | [查看文档](https://github.com/Komorebi-yaodong/anywhere_doc/blob/main/docs/provider_doc.md) |
| **设置与同步** | 配置桌面行为、快捷键、语音与 WebDAV 同步。 | [查看文档](https://github.com/Komorebi-yaodong/anywhere_doc/blob/main/docs/setting_doc.md) |

> 主控台顶部左侧的“使用指南”会直接从独立文档仓拉取这些文档内容。

---

## 🏗️ 项目架构

本项目抛弃了原有的 uTools 兼容层，采用现代化的 **Electron + Vue 3 + Vite** 从零原生构建。项目严格按照进程与功能职责进行目录划分：

```text
Anywhere_desktop/
├── main/                   # 【后端】Electron 主进程代码
│   ├── index.js            # 主进程入口 (生命周期、托盘管理)
│   ├── windowManager.js    # 窗口管理器
│   ├── ipcHandler.js       # IPC 通信注册中心
│   ├── dataConverter.js    # 前后端数据转换器
│   ├── core/               # 核心业务逻辑
│   └── ...
├── preload/                # 【桥梁】预加载脚本
├── render/                 # 【前端】渲染进程代码
│   ├── main/
│   ├── window/
│   ├── fast_input/
│   └── quick/
├── package.json
└── vite.config.js
```

### 🔄 数据流与转换规范

由于脱离了原插件运行时的自动序列化机制，主进程与渲染进程之间的所有数据交互，都必须通过 `preload` 安全暴露，并经过 `main/dataConverter.js` 进行格式转换（例如 File 对象路径提取、Buffer / Base64 转换、错误对象序列化等），确保接口行为一致、稳定、可维护。

---

## 🛠️ 开发环境

* **操作系统**：Windows 11（主要开发平台，兼容 macOS / Linux）
* **Node.js**：>= 24.x
* **包管理器**：`pnpm`
* **核心框架**：
  * `Electron`
  * `Vue 3`
  * `Vite`
  * `Element Plus`

---

## 💻 本地开发指导

### 1. 环境准备

克隆项目并安装依赖：

```bash
# 克隆桌面版项目
git clone https://github.com/Komorebi-yaodong/anywheredesktop.git Anywhere_desktop
cd Anywhere_desktop

# 安装依赖
pnpm install
```

### 2. 运行与调试

```bash
# 启动开发环境
pnpm dev
```

### 3. 项目构建

```bash
# 执行构建
pnpm build
```

### 4. 文档联动说明

如果你修改了主控台“使用指南”的文档内容，请不要直接改本仓 README 之外的旧内嵌文档，而应前往独立文档仓维护：

```text
https://github.com/Komorebi-yaodong/anywhere_doc
```

桌面端帮助系统当前会优先从以下地址拉取：

* GitHub raw：`https://raw.githubusercontent.com/Komorebi-yaodong/anywhere_doc/main/`
* Gitee raw：`https://gitee.com/Komorebi-yaodong/anywhere_/raw/main/`

---

## 🤝 社区与支持

Anywhere Desktop 是一个持续进化的开源项目，欢迎交流、反馈与贡献：

* **主程序仓库**：<https://github.com/Komorebi-yaodong/anywheredesktop>
* **文档仓库**：<https://github.com/Komorebi-yaodong/anywhere_doc>
* **Gitee 文档镜像**：<https://gitee.com/Komorebi-yaodong/anywhere_>
* **QQ 交流群**：`1065512489`

如果你发现“主程序行为”和“文档描述”不一致，建议同时提及对应代码仓与文档仓，便于同步修正。

---

## 📄 说明

本仓库承载 **Anywhere Desktop 主程序代码**。用户指南与帮助文档已经独立拆分到文档仓维护。二者分工如下：

* `Anywhere_desktop`：负责桌面端功能实现与发布；
* `Anywhere_doc`：负责官方用户指南、帮助文档与截图资源维护。

欢迎一起把 Anywhere Desktop 打磨成更稳定、更强大、更适合真实桌面工作流的本地 AI Agent 平台。