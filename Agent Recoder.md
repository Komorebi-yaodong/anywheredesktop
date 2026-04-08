# Agent Recoder

## 2026-04-08 - Step EI quick 自动上传与 3 秒阈值收口
- 结果：已修复 quick 自动上传慢、3 秒阈值失真，以及“相同内容重新复制不自动上传”。
- 文档索引：`进度.md` Step EI ~ EI.6
- 关键过程：
  - 后端 `main/core/system.js` 增加 clipboard watcher 启动期初始化与 Windows clipboard sequence 感知。
  - `captureQuickPayload()` 改为优先 recent clipboard 快路径，只有快路径拿不到 fresh 内容时才回退到 PowerShell 选区/文件探测。
  - `render/quick/App.vue` 初始化时取消重复 `captureSelectionPayload()` 慢路径，仅走轻量 `readClipboardPayload()`。
  - 已执行 `pnpm build`，构建通过；保留既有 `main/core/mcp.js` 静态+动态引入告警（非阻塞项）。
