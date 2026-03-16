# Phase C 重新整理计划（2026-03-16）

## 已完成部分 ✅

### C.1 对话框基础 UI 组装

| 子任务 | 状态 | 说明 |
|--------|------|------|
| C.1-1 窗口壳层接入 | ✅ | TitleBar + ChatHeader + App.vue 壳层结构 |
| C.1-2 ChatInput 首版壳层 | ✅ | 输入区、附件选择、MCP/Skill 开关 |
| C.1-3 启动桥接修复 | ✅ | fallbackDefaultConfig 容错 |
| **C.1-4 openWindow + coderedirect** | ✅ | createDialogWindow + window.preload.receiveMsg |

## 进行中部分 🟡

### C.2 核心聊天组件适配

> 说明：从原项目 `Anywhere_window/src/components/` 逐步迁移 Vue 代码，对接桌面端 API

| 子任务 | 状态 | 说明 |
|--------|------|------|
| **C.2-1 ChatMessage.vue 迁移** | 🟡 | Markdown/KaTeX/Mermaid渲染、代码块复制、长图导出 |
| C.2-2 App.vue 核心逻辑对齐 | [] | 补齐缺失 API（getUser/savePromptWindowSettings等） |
| C.2-3 追问/投递功能 | [] | onAppendMessage + window-append-msg channel |

## 待开始部分 ⏳

### C.3 独立窗口创建链路完善

> 说明：完善 `runTaskNow` / `summon_agent` 等调用 `createDialogWindow` 的链路

| 子任务 | 状态 | 说明 |
|--------|------|------|
| C.3-1 runTaskNow 任务触发 | [] | 修改 ipcHandler，调用 createDialogWindow |
| C.3-2 summon_agent MCP 工具 | [] | 修改 mcp_builtin.js，调用 createDialogWindow |
| C.3-3 handlePrompt/handleAssistant | [] | 复用 createDialogWindow 打开 Prompt 窗口 |

### C.4 工具审批与协同机制

| 子任务 | 状态 | 说明 |
|--------|------|------|
| MCP 工具审批弹窗 | [] | 测试自动执行与手动审批 |
| 多窗口协同通信 | [] | 测试 summon_agent 后新窗口传递数据 |

---

## 下一步工作计划

**当前优先级：C.2-1 ChatMessage.vue 迁移**

1. 从原项目复制 `ChatMessage.vue` 到桌面端
2. 对接桌面端 API（window.api）
3. 实现代码块一键复制
4. 实现长图导出（html2canvas）

**后续优先级：**

5. 完成 C.2-2 / C.2-3（App.vue API 对齐 + 追问功能）
6. 完成 C.3-1（runTaskNow）
7. 完成 C.3-2（summon_agent）
8. 完成 C.4（工具审批测试）