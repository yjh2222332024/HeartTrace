# 模拟聊天训练场 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 让用户从训练入口选择工作区，由选定军师生成动态训练场景，并在独立的微信式聊天界面中与按工作区档案扮演的对方练习对话。

**Architecture:** 训练会话使用独立持久化模型和 `/api/training` 路由，绝不复用普通咨询 `conversation`。场景生成与点评使用选定军师的受保护 persona；对方模拟器使用固定角色规则和训练快照，不能访问普通会话、其他工作区或任何写入工具。

**Tech Stack:** Vue 3 Composition API、Express、Node JSON store、OpenAI-compatible streamChatCompletion、node:test。

---

### Task 1: 独立训练会话存储与校验

**Files:**
- Modify: `love-advisor/server/store.js`
- Test: `love-advisor/server/training.test.js`

**Step 1:** 为训练会话写失败测试：创建绑定工作区的训练、追加用户/对方消息、读取与更新模拟时间；拒绝不存在工作区和非法角色。

**Step 2:** 在 `store.js` 增加 `training-sessions.json` 存储、`createTrainingSession`、`getTrainingSession`、`appendTrainingMessages` 与状态更新函数；训练消息仅允许 `me` / `peer` / `coach`。

**Step 3:** 运行 `node --test server/training.test.js`。

### Task 2: 训练上下文与固定模拟器规则

**Files:**
- Create: `love-advisor/server/training.js`
- Test: `love-advisor/server/training.test.js`

**Step 1:** 为 `buildTrainingSnapshot`、场景 JSON 与对方回复 JSON 的规范化写失败测试。

**Step 2:** 构建仅含当前工作区档案、记忆、关键事件、绑定会话证据包摘要的训练快照；设置字节上限。实现容错 JSON 解析和每回合 1–3 条、0–240 分钟模拟等待的对方回复约束。

**Step 3:** 固定对方模拟器系统规则：只扮演对方、不教学、不声称知道真实想法、不能写入或访问普通咨询。军师生成/点评使用单独调用与相同快照。

**Step 4:** 运行训练单测。

### Task 3: 训练 API 与应用注册

**Files:**
- Modify: `love-advisor/server/index.js`
- Modify: `love-advisor/server/training.js`
- Modify: `love-advisor/src/api.js`
- Test: `love-advisor/server/training.test.js`

**Step 1:** 为场景生成、创建训练、发送回合、提示与复盘路由写失败测试，验证工作区隔离与不会修改普通会话/记忆。

**Step 2:** 注册 `/api/training/scenarios`、`/sessions`、`/sessions/:id/turn`、`/coach`、`/review`。所有路由只接受当前工作区 id；训练模型调用没有工具定义。

**Step 3:** 从 `index.js` 注入 LLM 设置、证据包和军师运行时；前端增加 `trainingApi`。

**Step 4:** 运行训练单测。

### Task 4: 训练入口与工作区选择

**Files:**
- Modify: `love-advisor/src/components/Sidebar.vue`
- Modify: `love-advisor/src/composables/useShell.js`
- Modify: `love-advisor/src/composables/useAdvisorApp.js`
- Modify: `love-advisor/src/App.vue`
- Create: `love-advisor/src/views/TrainingView.vue`

**Step 1:** 增加“模拟训练”入口；入口先展示工作区选择页，而不是直接使用当前会话。

**Step 2:** 训练页列出有私聊绑定的工作区，并在选中后列出默认军师与自定义军师；请求动态生成的 3 张场景卡。

**Step 3:** 创建训练会话后进入独立训练状态；返回按钮不影响普通咨询当前会话。

**Step 4:** 运行 `npm run build`。

### Task 5: 微信式气泡训练界面与陪练动作

**Files:**
- Create: `love-advisor/src/components/TrainingChat.vue`
- Modify: `love-advisor/src/views/TrainingView.vue`
- Modify: `love-advisor/src/style.css`

**Step 1:** 实现绿/白两侧气泡、头像、模拟时间分隔、对方“正在输入”与逐条出现动画。

**Step 2:** 用户发送后显示短暂模拟等待；服务端已返回的对方消息按照 `afterSeconds` 依次展示并落库。

**Step 3:** 加入“提示”“暂停点评”“结束复盘”；指导内容作为可折叠军师卡片而非对方消息。

**Step 4:** 实现窄屏响应式：训练聊天单栏可用，不出现横向溢出。

**Step 5:** 运行 `npm run build` 与完整 `npm test -- --run`。

### Task 6: 训练专用上下文与最新聊天数据更新（后续增量）

**Files:**
- Modify: `love-advisor/server/context.js` 或新增训练证据模块
- Modify: `love-advisor/server/index.js`
- Modify: `love-advisor/src/components/WorkspaceModal.vue`
- Modify: `love-advisor/src/components/ImportDialog.vue`

**Step 1:** 增加从既有工作区发起的“更新聊天记录”，显式替换当前数据源版本，避免全局导入产生重复工作区。

**Step 2:** 保存 source revision；新版导入只生成档案差异草稿，不自动覆盖人工确认档案与正式记忆。

**Step 3:** 为新训练建立当前 source revision 快照；进行中的训练固定使用旧快照。
