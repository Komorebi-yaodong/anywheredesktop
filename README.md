# Anywhere Desktop

> 面向桌面工作流的本地 AI 工具，提供多模型接入、MCP 与 Skill、独立对话、历史管理、定时任务和 WebDAV 同步，定义专属于你的智能体（Agent）！

<p align="center">
  <a href="https://github.com/Komorebi-yaodong/anywheredesktop">
    <img src="https://img.shields.io/badge/GitHub-anywheredesktop-black?style=flat-square&logo=github" alt="GitHub Repo">
  </a>
  <a href="https://github.com/Komorebi-yaodong/anywhere_doc">
    <img src="https://img.shields.io/badge/Docs-anywhere__doc-blue?style=flat-square&logo=readme" alt="Docs Repo">
  </a>
  <a href="https://github.com/Komorebi-yaodong/Anywhere">
    <img src="https://img.shields.io/badge/Origin-Anywhere%20uTools%20Plugin-1677ff?style=flat-square&logo=github" alt="Original Plugin Repo">
  </a>
  <a href="https://www.u-tools.cn/plugins/detail/AI%20Anywhere/">
    <img src="https://img.shields.io/badge/uTools-Plugin-4F8EF7?style=flat-square&logo=utools" alt="uTools Plugin">
  </a>
</p>

AI Anywhere Desktop 是一个深度定制化的桌面 AI 智能体工作站。它不仅聚合了多种大模型接口，更提供了完整的本地 AI 自动化能力：主控台、独立对话窗口、快捷输入、快捷召唤、全局追问、MCP 工具系统、Skill 技能库、定时任务与 WebDAV 多端同步，均以桌面端原生体验重新实现。

## 功能预览

### 快捷输入

**快捷输入**：极速启动的悬浮输入条，适合划词翻译、临时提问、轻量文本处理等“阅后即焚”的高频任务。

![快捷输入模式](https://raw.githubusercontent.com/Komorebi-yaodong/anywhere_doc/main/image/%E5%BF%AB%E6%8D%B7%E8%BE%93%E5%85%A5%E6%A8%A1%E5%BC%8F-%E6%B7%B1%E8%89%B2.gif)

### 独立对话窗口、Better Work 与全局追问

**独立对话窗口**：提供完整的多轮对话体验，支持文件拖拽、图片粘贴、Markdown / 代码高亮、Token 用量展示、历史恢复与自定义背景。编辑按钮右侧的 Fork 可将该消息及之前的上下文复制为新会话，依次命名为 `fork-原名`、`fork1-原名`，并打开新会话。同端重复打开会复用已有窗口；不再启用跨客户端数据库冲突锁，请勿同时在插件与桌面编辑同一会话。

**Better Work**：在对话内提供选择卡片与会话临时任务面板，适合让 AI 在长任务中边确认、边执行、边展示进度。

**全局追问与消息缓冲**：可将任意软件中的文本、图片或文件继续发送到已打开的目标窗口；当 AI 正在回复或调用工具时，后续消息会先进入缓冲队列，当前任务结束后自动续接。

![独立对话窗口](https://raw.githubusercontent.com/Komorebi-yaodong/anywhere_doc/main/image/%E7%8B%AC%E7%AB%8B%E5%AF%B9%E8%AF%9D%E7%AA%97%E5%8F%A3%E7%95%8C%E9%9D%A2.gif)
![全局追问展示](https://raw.githubusercontent.com/Komorebi-yaodong/anywhere_doc/main/image/%E8%BF%BD%E9%97%AE%E5%B1%95%E7%A4%BA.gif)

---

## 核心特性

### MCP 支持（内置强大工具满足智能体（Agent）基本功能）

通过 MCP，Anywhere Desktop 可以把文件、Shell、Python、联网搜索、任务调度等能力真正接到模型手上，让 AI 从“会聊”变成“会做事”。

* `view_image` 支持本地图片和 HTTP(S) 图片地址（包括不带扩展名的下载链接），远程读取沿用应用网络代理。输入框粘贴/添加的图片与工具返回的图片统一在发送前单轮压缩，保留原尺寸与透明度，仅采用更小的编码；模型请求与会话历史使用同一份优化结果，不修改原文件。
* `execute_bash_command` 不再在命令结果前附加启动目录 `[CWD: ...]`，避免与命令实际切换后的目录混淆；需要确认目录时可显式输出 `Get-Location`。

![MCP 管理界面](https://raw.githubusercontent.com/Komorebi-yaodong/anywhere_doc/main/image/MCP%E7%AE%A1%E7%90%86%E7%95%8C%E9%9D%A2.png)

### 记忆笔记本（Memory MCP）

* 笔记本独立存在，不绑定 Agent 或名称，也不需要用户分配。AI 根据当前角色、名称和自由文本用途说明，自主选择相关记忆。
* `get_memory_summary` 的工具描述直接列出所有笔记本的名称、用途和稳定 ID；不再提供 `list_memories`。正文按需读取，下一次模型请求会刷新索引，不向聊天历史追加更新记录。
* `create_memory` 支持可选 `description`；`update_memory` 可改名/修改用途且 ID 不变。旧数据无需迁移，备份导入导出保留用途字段。
* 支持章节改名/删除、`replace_memory_text` 字面精确替换及列表项删除；多处命中默认拒绝，列表可使用唯一 `item_identifier` 或刚读取的零基 `item_index`。
* `search_within_memory` 使用 `memory_id` 或 `memory_ids` 明确搜索范围；支持 `limit`、`offset`、`snippet_length`、`max_chars`，返回命中片段及分页/截断状态，不默认搜索全部笔记本。
* 不做后台提炼、自动人格分类或修改历史。两端记忆专项测试：`pnpm run test:memory`（插件在 `backend` 目录运行）。


### Skill 技能库（SOP 编排）

将复杂任务沉淀为可复用的 Skill，让桌面端能够以更稳定的方式执行标准流程，并支持子智能体静默执行复杂任务。

![Skill 下载示例](https://raw.githubusercontent.com/Komorebi-yaodong/anywhere_doc/main/image/skill%E4%B8%8B%E8%BD%BD%E7%A4%BA%E4%BE%8B.gif)

### 全天候定时任务

支持本地调度执行，让 AI 在后台自动完成日报生成、监控巡检、资料整理与定时通知等工作。目标可选择智能体或已有本地会话，两者互斥；会话目标需要开启本地存储，执行时复用窗口并延续历史，忙碌或受 Mobile 控制时不会抢占。

![定时任务界面](https://raw.githubusercontent.com/Komorebi-yaodong/anywhere_doc/main/image/%E5%AE%9A%E6%97%B6%E4%BB%BB%E5%8A%A1%E7%95%8C%E9%9D%A2.png)

---

## 界面概览

<details>
<summary><b>点击展开更多桌面端界面截图</b></summary>

|                                                                      智能体管理                                                                      |                                                                 服务商配置                                                                 |
| :----------------------------------------------------------------------------------------------------------------------------------------------------: | :-----------------------------------------------------------------------------------------------------------------------------------------: |
| ![智能体（Agent）管理](https://raw.githubusercontent.com/Komorebi-yaodong/anywhere_doc/main/image/%E5%BF%AB%E6%8D%B7%E5%8A%A9%E6%89%8B%E7%95%8C%E9%9D%A2.png) | ![服务商界面](https://raw.githubusercontent.com/Komorebi-yaodong/anywhere_doc/main/image/%E6%9C%8D%E5%8A%A1%E5%95%86%E7%95%8C%E9%9D%A2.png) |

|                                                             设置中心                                                             |
| :------------------------------------------------------------------------------------------------------------------------------: |
| ![设置界面](https://raw.githubusercontent.com/Komorebi-yaodong/anywhere_doc/main/image/%E8%AE%BE%E7%BD%AE%E7%95%8C%E9%9D%A2.png) |

</details>

---

## 软件主要功能

### 多模式交互窗口

1. **主控制台 (Main)**
   * 全局设置、服务商配置、MCP 管理、Skill 管理、定时任务与历史对话入口都集中在这里。
2. **独立对话窗口 (Window)**
   * 支持多轮对话、文件拖拽、图片粘贴、Markdown / 代码高亮、Token 用量展示、历史恢复、导出与自定义背景。
   * 支持 Better Work 选择卡片与任务面板，让 AI 可在长任务中请求确认、展示待办、实时更新执行状态。
3. **快捷输入与快捷召唤 (Fast / Quick)**
   * 适合高频轻任务与快速投递内容。
   * 图片类智能体可接入截图捕获与截图后标注工作流。
4. **全局追问与消息缓冲 (Append / Follow-up)**
   * 可将任意软件中的文本、图片或文件直接继续发送到已打开的目标窗口中。
   * 请求进行中继续发送的消息会进入缓冲区，等待当前 AI 回复或工具调用完成后自动续接。

### MCP 与工具调用

* 原生支持 **Model Context Protocol (MCP)**；
* 内置文件操作、Python、Shell、联网搜索、网页抓取、时间、任务管理与 Better Work 交互工具；
* 内置文件编辑工具支持变更片段回显、失败诊断与误带行号容错；
* `grep_search` 支持输出限流，减少长结果占用上下文；
* `builtin_web_fetch` 支持通过 `markitdown-js` 增强网页内容到 Markdown 的转换效果；
* 支持 Super-Agent / Sub-Agent 多智能体协作。

### Skill 技能库（SOP 编排）

* 将复杂任务封装为标准作业程序；
* 支持子智能体后台静默执行复杂技能，减少主对话上下文污染。

### 全天候定时任务

* 基于本地桌面端调度器运行；
* 当前会话已保存到本地时，内置 Super-Agent 的 `list_agents` 工具描述会附带本会话的 `conversation_id`，AI 可将其用于 `create_task` / `edit_task` 的会话目标；未保存或仅云端会话不展示该 ID。
* 目标为已有会话时，空闲直接执行；正在生成、压缩、准备发送、控制交接或运行其他任务时加入消息缓冲队列。手机控制期间也能接收，不抢控制权、不打断当前请求。
* 队列保存成功即确认受理，避免调度重复投递；任务指令/配置独立，按顺序开启各自回合，待发队列随会话恢复。不覆盖草稿，不额外激活已打开或隐藏的窗口；待发消息存在时不自动关闭。
* 可让 AI 在后台持续进行日报生成、信息抓取、文件整理与自动化执行。

### 模型协议与请求配置

* 支持 OpenAI 兼容协议，并新增 **Codex API** 协议类型；
* 支持 **Claude / Anthropic API** 协议，可直接配置 Anthropic 风格服务；
* Provider 支持自定义请求 Header，可为不同服务商配置 `User-Agent`、网关鉴权等附加请求头；
* 助手回复可展示输入 / 输出 Token 与推理 Token 用量，便于观察消耗与调优模型选择。

### 数据同步、聊天项目与隐私

* 本地优先的数据存储方案；
* 支持 WebDAV 配置同步与历史对话同步；
* 历史对话支持按项目分组、折叠、拖拽归档、批量拖拽与未分组管理；
* 保存、云端保存、重命名会话时可选择所属项目；
* 本地与云端可同步聊天项目归属，适合多台电脑间迁移与续接工作流。

---

## 文档与用户指南

Anywhere Desktop 的用户指南已从主程序仓中拆分出来，统一维护在独立文档仓：

- GitHub 文档仓：[https://github.com/Komorebi-yaodong/anywhere_doc](https://github.com/Komorebi-yaodong/anywhere_doc)
- Gitee 文档镜像：[https://gitee.com/Komorebi-yaodong/anywhere_](https://gitee.com/Komorebi-yaodong/anywhere_)

### 文档模块导航

| 模块                   | 说明                                                             | 文档链接                                                                                   |
| :--------------------- | :--------------------------------------------------------------- | :----------------------------------------------------------------------------------------- |
| **定时任务**     | 创建自动化任务，让 AI 定时执行并生成结果。                       | [查看文档](https://github.com/Komorebi-yaodong/anywhere_doc/blob/main/docs/task_doc.md)     |
| **历史对话**     | 管理本地与云端会话记录，支持项目分组、恢复、清理与导出。         | [查看文档](https://github.com/Komorebi-yaodong/anywhere_doc/blob/main/docs/chat_doc.md)     |
| **智能体（Agent）** | 创建不同类型的智能体，掌握快捷召唤、全局追问、消息缓冲与截图标注。 | [查看文档](https://github.com/Komorebi-yaodong/anywhere_doc/blob/main/docs/ai_doc.md)       |
| **MCP 服务**     | 启用内置工具、Better Work 交互工具，并接入第三方 MCP 服务。      | [查看文档](https://github.com/Komorebi-yaodong/anywhere_doc/blob/main/docs/mcp_doc.md)      |
| **Skill 技能库** | 编写 SOP、封装技能、使用子智能体模式。                           | [查看文档](https://github.com/Komorebi-yaodong/anywhere_doc/blob/main/docs/skill_doc.md)    |
| **服务商管理**   | 配置 API 服务商、模型协议、多 Key 轮询与自定义 Header。          | [查看文档](https://github.com/Komorebi-yaodong/anywhere_doc/blob/main/docs/provider_doc.md) |
| **设置与同步**   | 配置桌面行为、快捷键、语音与 WebDAV 同步。                       | [查看文档](https://github.com/Komorebi-yaodong/anywhere_doc/blob/main/docs/setting_doc.md)  |

> 主控台顶部左侧的“使用指南”会直接从独立文档仓拉取这些文档内容。

---

## 项目架构

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

### 数据流与转换规范

由于脱离了原插件运行时的自动序列化机制，主进程与渲染进程之间的所有数据交互，都必须通过 `preload` 安全暴露，并经过 `main/dataConverter.js` 进行格式转换（例如 File 对象路径提取、Buffer / Base64 转换、错误对象序列化等），确保接口行为一致、稳定、可维护。

---

## 开发环境

* **操作系统**：Windows 11（主要开发平台，兼容 macOS / Linux）
* **Node.js**：>= 24.x
* **包管理器**：`pnpm`
* **核心框架**：
  * `Electron`
  * `Vue 3`
  * `Vite`
  * `Element Plus`

---

## 本地开发指导

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

## 社区与支持

Anywhere Desktop 是一个持续进化的开源项目，欢迎交流、反馈与贡献：

* **主程序仓库**：[https://github.com/Komorebi-yaodong/anywheredesktop](https://github.com/Komorebi-yaodong/anywheredesktop)
* **文档仓库**：[https://github.com/Komorebi-yaodong/anywhere_doc](https://github.com/Komorebi-yaodong/anywhere_doc)
* **Gitee 文档镜像**：[https://gitee.com/Komorebi-yaodong/anywhere_](https://gitee.com/Komorebi-yaodong/anywhere_)

如果你发现“主程序行为”和“文档描述”不一致，建议同时提及对应代码仓与文档仓，便于同步修正。

---

## 说明

本仓库承载 **Anywhere Desktop 主程序代码**。用户指南与帮助文档已经独立拆分到文档仓维护。二者分工如下：

* `Anywhere_desktop`：负责桌面端功能实现与发布；
* `Anywhere_doc`：负责官方用户指南、帮助文档与截图资源维护。

欢迎一起把 Anywhere Desktop 打磨成更稳定、更强大、更适合真实桌面工作流的本地 AI 智能体（Agent）平台。

---

## 开源协议

本项目采用 **GNU Affero General Public License v3.0（AGPL-3.0-or-later）**。

这意味着：

- 你可以在遵守 AGPL 的前提下使用、修改与分发本项目；
- 你可以商用，但**如果你分发了修改版，或基于修改版对外提供网络服务**，则必须按 AGPL 要求公开对应源码；
- 任何衍生版本不得绕过 AGPL 的开源义务进行闭源再发布。

完整协议文本见仓库根目录下的 [LICENSE](./LICENSE) 文件。

版权所有 © 2026 Komorebi
