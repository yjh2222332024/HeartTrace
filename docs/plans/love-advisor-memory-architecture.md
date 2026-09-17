# Love Advisor Memory 方案

## 1. 目标

Memory 不是聊天记录的副本，也不是把所有历史永久塞进模型上下文。

它的目标是：

> 从过去经历中提炼出未来仍可能有用的信息，并通过分层路由按需提供给模型。

核心原则：

- Memory 是提炼后的数据，不是原始聊天副本。
- Memory 可以做上下文路由，但不替代 Runtime 权限控制。
- Memory Store 可以很大，但每轮进入模型的 Memory 必须很小。
- Memory 需要去重、合并、替代、失效和归档，不能只增不减。
- Memory 的生产应该低频、显式、可控，而不是每轮都调用模型提炼。

---

## 2. Memory 和其他数据层的区别

### Evidence

保存原始事实。

例如：

- 原始聊天消息
- 某个时间段的互动数据
- 具体事件的原文

回答的问题：

> 当时到底发生了什么？

### Conversation History

保存用户和军师以前聊过什么。

回答的问题：

> 我们之前讨论过什么？

### Memory

保存从过去经历中提炼出的、以后可能继续有用的信息。

例如：

- 她工作忙时回复通常变慢
- 连续追问曾多次造成冲突
- 用户容易把回复延迟理解成关系降温

回答的问题：

> 过去经历里，有什么值得以后继续利用？

### Workspace

保存目前对关系形成的结构化认识。

例如：

- her
- me
- relationship
- baseline

回答的问题：

> 当前我们对这段关系的整理结果是什么？

### Skill

保存方法论。

例如：

- 如何判断关系降温
- 如何分析回复节奏
- 如何处理冲突
- 如何判断推进时机

回答的问题：

> 以后遇到这类问题，应该怎么做？

---

## 3. Memory 的生产方式

Memory 不建议由主 Agent 每轮顺手写入。

更适合 Love Advisor 的方式是：

```text
正常对话
↓
累计若干完整 Turn
↓
用户决定是否进行 Memory Review
↓
启动独立 Memory Review Run
↓
生成 Memory Candidates
↓
用户确认 / 修改 / 忽略
↓
Runtime 正式写入 Memory Store
```

### 推荐触发方式

#### 1. 手动触发

用户主动选择：

- 最近几轮对话
- 某个时间范围
- 某段私聊
- 某几个事件

然后执行：

> 提炼这段内容的 Memory

#### 2. 周期提醒

例如每 5 个完整 Turn：

```text
已积累 5 轮新对话
是否整理一次 Memory？
```

默认只提醒，不自动调用模型。

#### 3. 特定事件触发

例如：

- 导入大量聊天
- 完成一次关系复盘
- 用户明确说“记住这个”
- 出现明确边界或承诺

可以立即进入 Memory Candidate 流程。

---

## 4. 为什么要先生成 Candidate

不要让模型直接修改正式 Memory Store。

推荐流程：

```text
LLM
↓
Memory Candidate
↓
Runtime 校验
↓
去重 / 冲突检查 / 合并判断
↓
用户审批
↓
正式写入
```

第一版候选结构可以是：

```ts
interface MemoryCandidate {
  content: string;

  type:
    | "episodic"
    | "semantic"
    | "risk"
    | "preference";

  kind:
    | "fact"
    | "conclusion";

  evidenceIds: string[];

  confidence: number;

  refs: ContextPath[];
}
```

---

## 5. Memory 类型

### episodic

保存重要事件。

例如：

> 9 月 12 日，她第一次主动提出周末见面。

特点：

- 有明确时间
- 对未来判断仍可能有价值
- 不等于普通聊天流水

### semantic

保存从多次经历中形成的稳定认识。

例如：

> 她工作忙时通常会明显降低回复频率。

### risk

保存不能轻易忘记的风险、雷区、边界。

例如：

> 连续追问回复速度曾多次导致冲突。

### preference

保存长期偏好。

例如：

> 她更接受轻松直接的邀约方式。

---

## 6. Memory 必须保留来源

Memory 不能变成“模型说过，所以就是真的”。

每条 Memory 应尽量保留 provenance。

例如：

```ts
interface MemoryItem {
  id: string;

  type:
    | "episodic"
    | "semantic"
    | "risk"
    | "preference";

  kind:
    | "fact"
    | "conclusion";

  content: string;

  confidence: number;

  evidenceIds: string[];

  refs: ContextPath[];

  createdByRunId: string;
  createdAt: string;

  status:
    | "active"
    | "superseded"
    | "invalid"
    | "archived";
}
```

其中：

- `evidenceIds`：指向原始证据
- `refs`：告诉模型相关详细资料在哪里
- `confidence`：区分强事实和弱推断
- `status`：支持 Memory 生命周期管理

Runtime 必须验证：

- evidence 是否存在
- evidence 是否属于当前 Workspace
- 引用是否越权
- 是否存在重复或冲突

---

## 7. Memory 可以做 Context 路由

Memory 不只是内容，也可以帮助模型判断下一步应该读什么。

例如：

```json
{
  "content": "她忙时回复节奏通常会下降",
  "refs": [
    "her",
    "baseline",
    "evidence.stats"
  ]
}
```

下一轮用户问：

> 她最近为什么回复这么慢？

模型看到这条 Memory 后，可以快速决定：

```ts
read_context({
  paths: [
    "her",
    "baseline",
    "evidence.stats"
  ]
})
```

因此：

> Memory = 压缩知识 + Context Navigation

但 Memory 只是导航。

真正能不能读取，仍然由 Runtime 决定。

---

## 8. Memory 也需要分层路由

如果最终只是一个不断增长的 `MEMORY.md`：

```text
Memory 太大
↓
每轮全部注入
↓
成本上升
注意力污染
旧结论干扰当前判断
```

所以 Memory 自己也要渐进式披露。

推荐四层：

```text
L0 Memory Index
↓
L1 Memory Topic Summary
↓
L2 Memory Item
↓
L3 Original Evidence
```

---

## 9. L0：Memory Index

模型每轮只看到很小的目录。

例如：

```text
Memory Index

her
对方的长期模式、偏好、沟通习惯
12 条 active memories

me
用户自己的重复行为模式
9 条 active memories

relationship
关系阶段、关键变化、长期判断
18 条 active memories

risk
边界、雷区、高代价行为模式
7 条 active memories

events
重要关系事件
31 条 memories
```

这一层不放正文。

它只回答：

> 我们有哪些记忆类别？

---

## 10. L1：Memory Topic Summary

模型判断某一类相关后再展开。

例如：

```text
communication

当前总结：
- 忙碌时回复间隔通常增加
- 回复长度变化比单纯速度更有判断价值
- 她不喜欢连续追问回复原因

相关 Memory：
m_102
m_177
m_203
```

这一层回答：

> 关于这个主题，我们目前大概知道什么？

很多任务可能到这里就已经够了。

---

## 11. L2：具体 Memory Item

如果模型需要确认某条具体记忆，再读取：

```ts
read_memory({
  ids: ["m_177"]
})
```

返回：

```json
{
  "id": "m_177",
  "content": "她在高工作压力时期多次出现回复间隔增加，但主动发起率没有同步下降。",
  "kind": "conclusion",
  "confidence": 0.82,
  "evidenceIds": [
    "msg_12",
    "msg_31",
    "msg_88"
  ]
}
```

---

## 12. L3：追溯原始 Evidence

如果模型还需要验证：

```text
Memory
↓
evidenceIds
↓
read_context / read_evidence
↓
原始聊天
```

因此完整路径是：

```text
Memory Index
↓
主题摘要
↓
具体 Memory
↓
原始 Evidence
```

---

## 13. Memory Tree 尽量和 Workspace 对齐

为了降低路由复杂度，Memory 分类不要和 Workspace 完全使用另一套世界观。

推荐第一版：

```text
memory
├── her
├── me
├── relationship
├── risk
└── events
```

这样和当前 Workspace：

```text
her
me
relationship
baseline
```

保持接近。

不要一开始拆成过细的：

```text
psychology
attachment
behavior
communication
strategy
emotion
...
```

粒度应该由真实访问模式决定，而不是提前拆满。

---

## 14. Memory 不应该只增不减

真正可扩展的 Memory Store 必须有生命周期。

例如旧 Memory：

```text
她不太喜欢电话。
```

后来出现大量新证据：

```text
她开始主动打电话。
```

不应该简单再追加一条相反 Memory。

推荐：

```text
旧 Memory
status = superseded

新 Memory
status = active
```

长期管理至少支持：

```text
新增
合并
更新
替代
失效
归档
```

---

## 15. Memory Review 不只是新增

每次 Memory Review 应该判断：

```text
这是新信息吗？

是否和现有 Memory 重复？

是否只是原始 Evidence 的复述？

是否只是短期状态？

是否和旧 Memory 冲突？

应该新增、合并还是替代？

是否应该什么都不写？
```

优秀的 Memory System 很多时候应该选择：

> 不产生任何新 Memory。

---

## 16. 成本控制

Memory Review 不需要每轮运行。

推荐默认：

```text
memoryReviewInterval = 5 turns

reviewMode = suggest
writeMode = confirm
```

含义：

```text
每 5 个完整 Turn
↓
只提醒用户是否整理

用户确认
↓
才调用模型进行 Memory Review

生成候选
↓
用户确认后正式写入
```

这样避免：

- 每轮额外模型调用
- Memory 泛滥
- 用户不知情地形成长期判断

---

## 17. 推荐的 Runtime 责任

模型负责：

```text
判断哪些信息值得成为 Memory Candidate
判断它属于哪一类
给出可能相关的 evidenceIds / refs
```

Runtime 负责：

```text
验证 Workspace 归属
验证 evidenceId
验证 path
限制大小
去重
冲突检测
状态管理
最终持久化
```

用户负责：

```text
确认
修改
忽略
```

核心边界：

> LLM 提议记住，Runtime 决定能不能写，用户决定要不要长期保留。

---

## 18. 与整个 Agent Context Architecture 的统一

最终 Love Advisor 可以形成统一模式：

```text
                    Model
                      │
        ┌─────────────┼─────────────┐
        │             │             │
 Skill Catalog   Context Catalog   Memory Index
        │             │             │
        ▼             ▼             ▼
    SKILL.md       Workspace      Memory Topic
        │             │             │
        ▼             ▼             ▼
   Reference        Evidence      Memory Item
                                      │
                                      ▼
                                   Evidence
```

这三个系统遵循同一个原则：

```text
小目录
↓
路由
↓
摘要
↓
详情
↓
原始依据
```

也就是：

> 不把所有知识直接塞给模型，而是先给模型地图，再让它按需展开。

---

## 19. 第一版建议

第一版不要做复杂自动学习。

先实现：

```text
1. 用户手动或每 N Turn 触发 Memory Review
2. Review 只生成 Candidate
3. 用户确认后写入
4. Memory 带 evidenceIds / refs / confidence
5. Memory 有 active / superseded / invalid / archived
6. Memory Index 常驻，正文按需读取
7. read_memory 支持 topic 和 id 两级读取
8. 原始依据始终留在 Evidence
```

等真实使用数据积累后，再决定是否增加：

```text
自动 Review
自动 Merge
自动 Supersede
Memory 热度
冷 Memory 归档
更细的 Topic Tree
```

---

## 20. 最终一句话

Love Advisor 的 Memory 应该被设计成：

> **一个可追溯、可分层、可路由、可淘汰的长期知识层，而不是一个越来越长的记忆文件。**

Memory Store 可以持续增长，但每一轮真正进入模型的，只应该是：

```text
少量 Memory Index
+
当前任务相关的 Topic Summary
+
按需展开的具体 Memory
+
必要时追溯到原始 Evidence
```

这样才能同时控制：

- 成本
- 上下文污染
- 旧结论干扰
- 错误记忆
- 长期可扩展性
