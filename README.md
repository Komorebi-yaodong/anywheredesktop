# ✨ AI Anywhere Desktop - 你的定制化全能 AI Agent 🚀

> **基于原 uTools 热门插件 "AI Anywhere" 核心重构的独立 Electron 桌面端程序！**
> **摆脱底座限制，从零原生构建。随时随地，便捷召唤 AI！支持 MCP、Skill 技能库与定时任务，将 AI 从简单的“聊天机器人”升级为能够自主执行复杂任务的“全能 AI 助手”。**

---

## 📸 软件主要功能

AI Anywhere Desktop 是一个深度定制化的桌面 AI 智能体工作站。它不仅聚合了各大 AI 模型接口，更是一套完整的本地 AI 自动化系统：

1. **多模式交互窗口**
   * **主控制台 (Main)**：全局设置、模型管理、服务商配置、定时任务与历史对话管理。
   * **独立对话窗口 (Window)**：功能完整的对话界面，支持多轮对话、文件拖拽、图片粘贴、代码高亮、长图导出与自定义背景。
   * **快捷输入与追问 (Fast Window)**：极速启动的悬浮指令条，支持划词处理、极速响应、阅后即焚，并支持“全局追问”将内容投递到指定的对话窗口中。
2. **真正的智能 Agent (MCP 支持)**
   * 原生支持 **Model Context Protocol (MCP)**。
   * 内置全能文件操作、Python 脚本执行、终端命令、联网搜索、定时任务管理等工具。
   * 支持 Super-Agent 多智能体后台协同工作。
3. **Skill 技能库 (SOP 编排)**
   * 支持将复杂任务封装为标准作业程序 (SOP)。
   * 支持子智能体 (Sub-Agent) 后台静默执行复杂技能，避免污染主对话上下文。
4. **全天候定时任务**
   * 基于本地轮询的定时调度器，让 AI 成为 24 小时无人值守的自动数字员工。
5. **数据同步与隐私**
   * 本地优先的数据存储方案。
   * 支持 WebDAV 多端秒级配置与历史对话同步。
6. **桌面端专属优化**
   * 原生系统级全局快捷键绑定、跨窗口 IPC 通信、无边框系统托盘特性支持。

---

## 🏗️ 项目架构

本项目抛弃了原有的 uTools 兼容层，采用现代化的 **Electron + Vue 3 + Vite** 从零原生构建。项目严格按照进程与功能职责进行目录划分：

```text
Anywhere_desktop/
├── main/                   # 【后端】Electron 主进程代码
│   ├── index.js            # 主进程入口 (生命周期、托盘管理)
│   ├── windowManager.js    # 窗口管理器 (主控台、独立对话框、快捷悬浮窗的创建与路由)
│   ├── ipcHandler.js       # IPC 通信注册中心
│   ├── dataConverter.js    # [核心] 前后端数据转换器 (负责 Electron IPC 传输中的序列化与反序列化)
│   ├── core/               # 核心业务逻辑 (替代原 uTools API 的原生实现)
│   │   ├── db.js           # 本地持久化数据库 (如基于 lowdb/sqlite 替代 utools.db)
│   │   ├── fileSystem.js   # 原生文件系统操作 (替代 utools 弹窗与文件处理)
│   │   ├── mcpManager.js   # MCP 客户端管理与通信
│   │   ├── scheduler.js    # 定时任务调度中心
│   │   └── system.js       # 系统级 API (全局快捷键、剪贴板 clipboard、通知 Notification)
│   └── ...
├── preload/                # 【桥梁】Electron 预加载脚本 (沙箱安全隔离)
│   ├── main_preload.js        # 注入到主控制台的 API
│   ├── window_preload.js      # 注入到独立对话窗口的 API
│   ├── fast_input_preload.js  # 注入到快捷输入窗口的 API
│   └── quick_preload.js       # 注入到快捷召唤窗口的 API
├── render/                    # 【前端】Vue 3 渲染进程代码
│   ├── main/                  # 主控制台前端 (设置、服务商、MCP、历史记录管理等)
│   ├── window/                # 独立对话窗口前端 (气泡、输入框、Markdown 渲染)
│   ├── fast_input/            # 快捷输入悬浮窗前端
│   └── quick/                 # 快捷召唤前端
├── package.json
└── vite.config.js          # Vite 多页面/主进程构建配置
```

### 🔄 数据流与转换规范
由于脱离了 uTools 的自动序列化机制，主进程 (`main`) 与渲染进程 (`render`) 之间的所有数据交互，必须通过 `preload` 进行安全暴露，并经过 `main/dataConverter.js` 进行严格的格式转换（例如 File 对象的路径提取、Buffer 与 Base64 转换、错误对象的序列化等），确保前后端接口调用的一致性与稳定性。

---

## 🛠️ 开发环境

* **操作系统**: Windows 11 (主要开发平台，兼容 macOS / Linux)
* **Node.js**: >= 24.x (支持最新的 Electron 版本)
* **包管理器**: `pnpm`
* **核心框架**: 
  * `Electron` (桌面应用底层)
  * `Vue 3` (Composition API + setup)
  * `Vite` (构建工具，支持多入口编译)
  * `Element Plus` (UI 组件库)

---

## 💻 本地开发指导

### 1. 环境准备

克隆项目并安装依赖：

```bash
# 克隆桌面版项目
git clone <your_desktop_repo_url> Anywhere_desktop
cd Anywhere_desktop

# 安装依赖
pnpm install
```

### 2. 运行与调试

本项目使用 Vite 驱动前端的热更新，同时配合 Electron 进行主进程调试。

```bash
# 启动开发环境 (前端开启 Vite DevServer，并自动启动 Electron 主进程)
pnpm dev
```

### 3. 项目构建

开发完成后，打包分发适用于 Windows 的安装包：

```bash
# 执行构建打包
pnpm build
```

