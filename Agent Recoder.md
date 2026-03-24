# Agent Recoder

## 2026-03-24 - Agent 工具图片发送链修复归档

### 结果
- 已修复 `summon_agent` / `continue_agent_chats` 的图片发送链。
- 已确认本地图片会以 `data:image/...;base64,...` 形式进入 `image_url.url`。
- 用户已复测确认当前图片发送恢复正常。

### 关键修复点
1. 对齐原插件底层附件发送思路：回到 `sendfileDirect -> parseFileObject`，再与文本合并为同一条 user message。
2. 修复 `main/dataConverter.js#isFileLike` 误判：
   - 删除对 `value.url.startsWith('data:')` 的 FileLike 判定。
   - 避免把 OpenAI 消息结构中的 `image_url.url` 当作文件对象重序列化。
3. 清理本轮临时 `AgentToolSend` 调试日志。

### 影响文件
- `main/dataConverter.js`
- `render/window/App.vue`
- `main/core/chat.js`
- `进度.md`

### 验证
- `pnpm build` 通过。
- 既有非阻塞告警仍保留：`main/core/mcp.js` 静态/动态同时引入，不影响产物。

### 存档说明
- 当前会话遵循 Git 只读约束，未执行 Git 写操作。
- 建议人工提交信息：
  - `fix(agent-tools): restore image data-uri delivery for summon and continue chats`
