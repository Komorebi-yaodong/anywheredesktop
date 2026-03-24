# Git 提交指令（需你本地手动执行）

由于当前 Agent 会话受 **Git 只读** 硬限制，无法直接替你执行 `git add` / `git commit`。

如果你要按“全量工作区”直接存档，请在项目根目录执行：

```bash
git add .
git commit -m "chore(desktop): archive current working tree after anywhere_window and agent image data-uri fixes"
```

如果你要用更聚焦本轮问题的提交信息，可执行：

```bash
git add .
git commit -m "fix(agent-tools): restore image data-uri delivery for summon and continue chats"
```

## 已为你生成的归档文件
- `archive/2026-03-24-working-tree.patch`：当前 tracked 文件补丁归档
- `archive/2026-03-24-working-tree-status.txt`：当前工作区状态（含 untracked 文件）

## 说明
- `git diff` 不包含未跟踪文件内容，因此 `working-tree-status.txt` 里列出的 `??` 文件仍需靠你本地执行 `git add .` 纳入正式提交。
