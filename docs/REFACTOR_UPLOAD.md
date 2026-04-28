# Upload Module Refactor Progress

## Overview
重构上传模块，实现文件夹聚合视图、右下角 FAB 面板、双语义取消按钮、速率计算。

## Decisions (All defaults accepted)
- 历史持久化：会话内保留，不持久化 localStorage
- 刷新时在传任务：beforeunload 发送 beacon 自动取消并清理
- 多个独立文件：不分组，每个文件单独一行
- 面板样式：FAB 锚定卡片（420px，右下角）
- 清空按钮：每行"移除" + 顶部"清空已完成"
- 速率单位：自动 B/KB/MB/s 切换
- 文件夹部分成功：标为 done-with-errors，按钮仅"移除"，不删已成功文件

---

## Phase 1 — 后端：speed / groupId / cancel-group / cleanup
**Status: ✅ COMPLETE (14/14 tests passed)**

### Goal
- 进度条目增加 `groupId`、`relativePath`、`groupRootPath`、`speed`、`persistedPath`
- 新增 `uploadGroups` Map，记录每组已写入文件路径
- 上传路由读取 query 参数 `groupId`、`relPath`、`groupRoot`
- 服务端计算 speed（滑动窗口 1.5s）
- 扩展 `/api/files/upload/cancel` 支持 `removeFiles`
- 新增 `/api/files/upload/cancel-group` 端点（原子清理）
- SSE payload 改为 `{ tasks: {...}, groups: {...} }`

### Files to change
- `server.js`

### Test Script
`docs/test-phase1.sh`

### Test Results
- [ ] 单文件上传成功（向后兼容）
- [ ] SSE 返回 `tasks` + `groups` 两个字段
- [ ] groupId 正确聚合到 groups
- [ ] speed 字段出现在 SSE tasks 中（> 0）
- [ ] cancel 单文件 + removeFiles=true 删除已落盘文件
- [ ] cancel-group 删除整个文件夹并返回 cleaned 计数

### Completion
- [ ] All tests pass

---

## Phase 2 — 前端数据层：UploadStore + 分组模型
**Status: ✅ COMPLETE (merged into Phase 2+3)**

### Goal
- 删除 `globalUploads`、`uploadBatches`、`nextBatchId`、`hiddenGlobalIds`
- 新增 `UploadStore`（发布订阅 + task/group 双模型）
- 速率用 1.5s 滑动窗口（EMA 补充）
- 每个文件上传时附带 `groupId`、`relPath`、`groupRoot` query 参数
- SSE 消费者读取新 `{tasks, groups}` 格式
- 历史保留（不自动删除已完成条目）

### Files to change
- `public/index.html` (script section)

### Test Results
- [ ] UploadStore.tasks.size 上传完成后不减少（历史保留）
- [ ] 一个文件夹拖入 → 1 group + N tasks
- [ ] 取消 group → 所有 XHR 中止 + 服务端文件删除
- [ ] 无 globalUploads 引用（grep 为空）

### Completion
- [ ] All tests pass

---

## Phase 3 — 前端 UI：FAB + 历史面板 + 文件夹详情子视图
**Status: ✅ COMPLETE (43/43 tests passed, merged with Phase 2)**

### Goal
- 移除旧 `.upload-panel`（顶部上传列表）
- 右下角 FAB（悬浮按钮）+ 徽章
- 点击 FAB 展开历史面板（文件夹折叠为单行）
- 点击文件夹行进入详情子视图（所有子文件 + 各自速率/进度/取消）
- 完成态按钮"移除"；进行中按钮"取消"
- "清空已完成"按钮
- beforeunload beacon 自动取消并清理在传任务

### Files to change
- `public/index.html` (markup + CSS + script)

### Test Results
- [ ] FAB 右下角可见，徽章显示在传组数量
- [ ] 上传文件夹显示为单个文件夹行（不平铺文件）
- [ ] 点击文件夹行可看到子文件明细
- [ ] 完成后按钮变"移除"，点击只清历史不动服务端文件
- [ ] 进行中点击"取消"后服务端文件被删
- [ ] 刷新页面时 beacon 发送，服务端清理在传文件

### Completion
- [ ] All tests pass

---

## Phase 4 — 收尾：清理旧代码 + 边缘情况 + 样式打磨
**Status: ✅ COMPLETE**

### Goal
- 删除旧 upload-panel CSS、HTML、相关 JS
- 移动端适配（<600px 全宽）
- DOM 虚拟滚动（>200 文件详情视图）
- A11y：FAB aria-label，面板 role=dialog，ESC 关闭
- 速率抖动处理（>2s 无样本衰减为 0）
- loadFiles 防抖（300ms）

### Files to change
- `public/index.html`

### Test Results
- [ ] 无旧 upload-panel 相关 CSS/JS 残留（grep 为空）
- [ ] 500 文件文件夹详情视图流畅（>50fps 滚动）
- [ ] ESC 关闭面板
- [ ] 移动端面板全宽

### Completion
- [ ] All tests pass

---

## Change Log
| Date | Phase | Change |
|------|-------|--------|
| 2026-04-28 | Phase 1 | 后端：groupId/speed/persistedPath/uploadGroups/cancel-group/SSE {tasks,groups} |
| 2026-04-28 | Phase 2+3 | 前端：UploadStore/FAB面板/文件夹详情/beforeunload beacon |
| 2026-04-28 | Phase 4 | 清理旧CSS/HTML/speed衰减/detail view样式修复 |
