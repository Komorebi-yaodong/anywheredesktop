# Agent Recoder

## 2026-03-20

### 任务：采用方案 B（非隔离上下文 + `window.api` 直挂载）
- 目标：让桌面端更接近 uTools 插件的开发模型，减少 IPC 对活对象/信号对象的限制。

#### 实际修改
- 已更新 `main/windowManager.js`
  - `BrowserWindow.webPreferences.contextIsolation` 从 `true` 调整为 `false`。
  - 保持 `nodeIntegration: false`，继续使用 preload 注入，但改走 preload 中已有的 `window.api = api` 直挂载分支。
- 结合前序修复，当前 `pathJoin`、`getDroppedFilePath` 等能力可直接以插件风格在渲染进程使用。

#### 安全说明
- 该模式适用于受信任的本地应用页面。
- 若未来需要在客户端内嵌打开任意网页/远程内容，必须额外使用单独的低权限窗口或 BrowserView，不能复用当前这些高权限窗口。

#### 验证
- 执行：`pnpm build`
- 结果：构建通过。


### 任务：同步上游 Skill 导入兼容性修复到桌面端
- 项目：`E:\Programming\Anywhere_desktop`
- 对齐来源：上游提交 `8c6394307ed7518c48d6411c72b54ac68ca4f0a1`

#### 修改结果
- 已更新 `main/core/skill.js`
  - 增强 frontmatter 解析：支持多行 `|` / `>`、数组、布尔值、引号字符串、缩进列表。
  - 新增 `findSkillEntryDir`，`.skill/.zip` 解包后递归查找 `SKILL.md`，修复部分包结构导入失败。
- 已更新 `render/main/components/Skills.vue`
  - 编辑态新增 `extraMetadata` 保留额外字段。
  - 保存时改为更稳健的 YAML 序列化。
  - 导入时增强 frontmatter 解析并兼容 `SKILL.md` / `skill.md`。
  - 导入应用元数据时保留额外字段，避免字段丢失。

#### 验证
- 执行：`pnpm build`
- 结果：主进程与 preload 构建通过；整体构建失败。
- 阻塞项：`render/window/main.js` 中 `@/assets/dark.css` 无法解析。
- 结论：该阻塞为既有 `window` 侧路径别名问题，与本次 `main + render/main` 的 Skill 导入修复无直接关系。

#### 文档索引
- 进度文档：`E:\Programming\Anywhere_desktop\进度.md`
- 本次修改文件：
  - `E:\Programming\Anywhere_desktop\main\core\skill.js`
  - `E:\Programming\Anywhere_desktop\render\main\components\Skills.vue`

### 任务：按插件项目语义修复 anywhere_main 的 Skill 拖拽导入失败
- 范围：`anywhere_main` 对应桌面端主控台
- 结论：插件项目本身逻辑正确，桌面端失败根因在于 `skill:*` IPC / preload 返回语义偏离插件，导致前端把结构化返回对象当作原始路径或布尔值使用。

#### 实际修复
- 已更新 `main/ipcHandler.js`
  - `skill:save/delete/exportPackage/extractPackage` 改回直接返回插件式原始值。
- 已更新 `preload/main_preload.js`
- 已更新 `preload/window_preload.js`
- 已更新 `preload/fast_preload.js`
  - 新增 `invokeOrThrow`：统一把 `{ ok:false, error }` 转成异常抛出。
  - `skill/file` 相关 API 恢复为“成功返回原值、失败抛异常”的插件调用习惯。

#### 验证
- 执行：`pnpm build`
- 结果：构建通过。
- 二次修复补充：
  - 运行态进一步定位到 `window.api.pathJoin` 被桌面端错误实现为异步 IPC，导致插件前端按同步函数使用时拿到 `Promise`，从而在目录 / `.zip` / `.skill` 导入链路中误报“未找到 SKILL.md”。
  - 已将三个 preload 的 `pathJoin` 改回本地同步 `path.join(...args)`，与插件项目完全对齐。
  - 再验证：`pnpm build` 通过。
- 用户运行态回归结果：已确认拖拽导入恢复正常，目录 / `SKILL.md` / `.zip` / `.skill` 均可成功导入。
- 当前状态：为方便后续观察，`[Skills][drag]` 与 `[preload:*]` 调试日志暂未移除；如需可在下一轮做一次日志清理提交。


- 备注：保留一个既有非阻塞告警：`main/core/mcp.js` 同时被静态与动态引入。


### 任务：修复桌面端拖拽文件无 `path` 导致 Skill 导入无效
- 现象：拖拽 `SKILL.md` / `.zip` / `.skill` 无效果、无报错。
- 运行态日志定位：`drop` 已触发，但拖拽得到的 `File` 对象仅有 `name/type/size`，`path` 为 `undefined`，旧逻辑在 `drop:ignored:no-item-path` 处直接返回。

#### 实际修复
- 已更新 `preload/main_preload.js`
- 已更新 `preload/window_preload.js`
- 已更新 `preload/fast_preload.js`
  - 新增 `getDroppedFilePath(file)`，通过 Electron `webUtils.getPathForFile(file)` 解析拖拽文件真实路径。
- 已更新 `render/main/components/Skills.vue`
  - 拖拽导入改为使用 `resolvedItemPath = file.path || window.api.getDroppedFilePath(file)`。
  - 无法解析路径时给出明确提示，不再静默失败。
  - 保留详细调试日志，便于继续跟踪。

#### 验证
- 执行：`pnpm build`
- 结果：构建通过。

#### 本轮涉及文件
- `E:\Programming\Anywhere_desktop\main\ipcHandler.js`
- `E:\Programming\Anywhere_desktop\preload\main_preload.js`
- `E:\Programming\Anywhere_desktop\preload\window_preload.js`
- `E:\Programming\Anywhere_desktop\preload\fast_preload.js`

