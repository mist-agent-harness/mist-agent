# 一位住户，一条权威生命线：master plan

- 状态：draft for implementation review
- 主单：issue #84
- 验收真源：`acceptance/one-stream.md`（OS-01～OS-06）
- 决策真源：`docs/decisions.md` D9、`docs/design/session-api.md` §1.1
- 计划基线：`origin/main` at `e46f7a9`

这份文件只负责施工顺序、模块边界和验收取证，不改 D9，也不替
`acceptance/one-stream.md` 另写一套成功定义。最终字段名可以在实现中收紧；本文写死的是
权威归属、提交顺序、失败语义与每盏灯需要的证据。

## 1. 目标与完成定义

完成 #84 后，同一 resident 的所有第一方用户可见事件必须经同一个 canonical writer
排序并持久化。viewport 可以保留自己的工作树、模型上下文和证据流水，但这些都不是第二本
用户权威历史。

“完成”同时要求：

1. OS-01～OS-06 各有真实生产模块参与的可重复测试，六灯全部点亮；
2. 第一方用户面只从 canonical stream 和 live workspace navigator 读，不从
   `session.list/history` 拼聊天史；
3. 会话消息、progress、blocked、result、closure 和宿主生命周期失败都能落入同一主流；
4. crash/retry 后主流无重复、无假 delivered、无假 committed-effective；
5. control/evidence 能力面仍能读归档流水，但不能写回、续聊或被默认用户主体看到。

## 2. 明确不做

- 不做分布式共识，也不支持两个宿主进程同时持有同一 resident 的写权。v0 的部署不变量是
  一个宿主拥有一个 writer；所有 viewport 通过它提交候选事件。若未来要多宿主主动写，另开
  一张共识／租约单，不能把本计划的进程内串行冒充成跨机安全。
- 不把 `session.list/history` 删除或降级。它们继续属于 control/evidence plane。
- 不在本单接真实 frontend 插件。第一方 read model、能力检查和协议响应会做成生产模块并
  参加测试；线协议到现有 frontend 的真实交付仍受 `session-api.md` 里已写明的延期约束。
- 不让 viewport 自由发送任意 transcript、消息数组或上下文正文到主流。
- 不把 stream delivery 当成业务副作用生效；也不靠日志、attempted 或 started 代替回执。
- 不在第一刀重写所有旧 P1/P2 存储。旧 `ResidentStore.nodes` 暂留兼容形状，不能再被当作
  用户权威读源；其退役或迁移另开数据迁移单。

## 3. 现状地图与缺口

| 现有部件 | 当前职责 | 本单判断 |
|---|---|---|
| `SessionRegistry` | 多活窗、generation、head、归档 JSONL、dispatch receipt | 保留为 workspace/control 状态；不是主流 writer |
| `MessageTreeStore` | resident 级 append-only 工作树；当前为内存态 | 保留为模型上下文与证据投影；不能直接冒充 durable stream |
| `MessageTreeService` | responder → appendPair → setHead | 需要被 turn coordinator 包住；不能继续独自宣布用户可见提交成功 |
| `ResidentStore.nodes` | 旧 P1 快照里的持久节点形状 | 与新 MessageTree 已分叉；只作兼容数据，不作为 #84 基础 |
| `FactLedger` / `ViewportTurnGate` | 权威事实 seq、开工闸与 ack | 复用其 fail-closed 与“回执晚于真实提交”的原则，不合并账本 |
| `BreathCycle` | 换气、失败通知、失败后重置预告 | OS-05 的真实生产接缝；失败通知要接主流 reporter |
| intentional isolation | scope presence 与 next-turn 注入 | 只提供工作区存在感；关闭与 closure 仍缺 |
| `session.list/create/history` adapter | control/evidence 线协议 | 保留；另建 P1 first-party projection，禁止复用列表当聊天栏 |
| plugin transaction host | 持久阶段与 crash checkpoint 先例 | 复用测试方式和阶段命名纪律，不复用其 plugin schema |

关键缺口不是“再加一个事件数组”，而是当前没有一个同时负责以下四件事的唯一操作 owner：
分配顺序、持久提交、幂等裁决、发出 delivery receipt。

## 4. 目标架构

### 4.1 数据流

```text
viewport / host lifecycle / turn coordinator
                  │ typed candidate + idempotency key
                  ▼
        CanonicalStreamWriter（唯一写口）
                  │ validate → canonicalize → serialize
                  ▼
        CanonicalStreamStore（resident 物理隔离）
                  │ durable commit receipt
          ┌───────┴────────┐
          ▼                ▼
  canonical projections   internal projectors
  desktop/mobile/offline  message tree / workspace state
          │                │
          └──── first-party read models ────┐
                                            ▼
                                stream + live navigator

session.list/history ── separate authorized control/evidence reader
```

### 4.2 权威边界

- 只有 writer 可以分配 `eventId` 与单调 `streamSeq`。
- viewport 只能提交 candidate；来源字段是 provenance，不带 authority。
- store 的已提交字节是 canonical stream 真源。桌面、手机与离线补拉都只按 cursor 读同一
  真源；投影层不能改正文、来源、效果语义或 payload hash。
- MessageTree 是可重建的内部投影。它回答“某个工作区下一轮模型从哪继续”，不回答
  “用户最终看见了什么”。
- `SessionRegistry` 的 head 只在相应内部投影成功后推进；stream delivered 本身不能冒充
  对应业务 authority 或会话 head 已提交。

### 4.3 模块边界（拟定）

第一刀预计新增 `src/one-stream/`：

- `event-contract.ts`：闭合的 candidate/event union、精确字段闸、规范化字节与 hash；
- `store.ts`：每 resident 的 durable commits、恢复校验、cursor 读取；
- `writer.ts`：唯一序列分配、幂等裁决、串行提交、delivery receipt；
- `projection.ts`：按 cursor 读主流并校验 payload hash；
- `turn-coordinator.ts`：后续把 user/assistant 事件与 MessageTree/head 投影接起来；
- `workspace-read-model.ts`：live navigator、closure/result card、evidence pointer；
- `lifecycle-reporter.ts`：宿主签发的失败事件；
- `reply-router.ts`：blocked candidate 索引与精确回话路由。

文件可以在实现时合并，但每项职责只能有一个 owner。特别是 writer 与 store 不能同时各自
发号，read model 不能反向写任何底层状态。

## 5. Canonical event 契约

### 5.1 两组正交语义

每个用户可见事件都必须同时表达：

1. 用途：message、progress、blocked、result、closure、lifecycle；
2. 效果：not-applicable、attempted、rejected、failed-not-effective、
   committed-effective；
3. 是否需要用户动作；
4. 自动重试、等待外部条件或不重试；
5. reporter/authority source；
6. subject、来源 viewport、`workRef`、发生时刻与可选权威产物／证据指针。

不能用一个 `completed` 或 `success` 布尔值折叠这些轴。字段名可以调整，语义不能合并。

### 5.2 两条写入口

- **turn 入口**只接明确的 user/assistant message event，由 turn coordinator 调用。它允许
  消息正文，但不允许 viewport 自造 role 或替宿主签 lifecycle 事件。
- **bounded dispatch 入口**只接 progress/blocked/result。它使用闭合字段表；额外键、
  transcript、messages、context、未声明自由文本 envelope 一律整单拒绝。

closure 与 lifecycle 由各自的宿主 adapter 签发，不开放给普通 viewport。来源 viewport
只能当 subject 或 provenance，不能把自己写成 host authority。

### 5.3 规范化与 payload hash

candidate 先做精确结构校验，再按固定键序列化为 UTF-8 字节；writer-assigned 的 id/seq
加入最终 immutable payload 后计算摘要。所有投影返回同一个 digest。测试会做两类变异：

- 保留 id/seq，改正文、来源或效果语义，必须被 hash 比对抓住；
- 同 idempotency key 改 candidate 任一权威字段，必须报冲突且主流字节不变。

只排除明确列入 projection-only allowlist 的展示字段；不能用“客户端元数据”当万能豁免。

## 6. Durable writer、幂等与 crash 恢复

### 6.1 v0 持久形状

沿用仓内已经验证过的同步原子快照策略：每 resident 一份版本化 stream snapshot，候选写入
先在内存副本上完成，再写同目录临时文件、`fsync`、原子 rename；成功后才替换内存视图并
返回 receipt。snapshot 至少保存：

- contiguous events；
- 下一条 seq；
- `idempotencyKey → requestHash + event receipt` 索引；
- schema version 与 resident identity。

启动时逐项校验 seq 连续、eventId 唯一、幂等键唯一、request hash 与 payload hash 可重算。
坏 schema 或中段坏账 fail-closed；孤立 `.tmp` 只表示 rename 前猝死，权威仍是旧 snapshot。

选择快照而不是追加 JSONL，是为了第一阶段直接继承 `ResidentStore` / `FactLedger` 已有的
rename 恢复证据，先把 OS-02 做真。代价是每次写 O(stream size)。计划在测试里记录写放大；
达到真实瓶颈后再以相同接口换 framed journal/SQLite，不在没有数据时先造阈值。

### 6.2 单写保护

- host assembly 只构造一个 writer；viewport、reporter、router 只拿窄 submission port；
- writer 对每个 resident 串行处理请求，store 写方法不对 viewport 导出；
- 同一进程尝试为同一 data root 建第二个 writer 时显式拒绝；
- crash 测试永远先确认旧宿主已经退出，再让恢复宿主接管同一 data root；
- v0 不声称文件存储能阻止两个独立进程同时打开同一 data root。当前保护边界是“一个宿主
  进程内只有一个 writer，所有 viewport 经它排队”。若部署需要共享根上的多宿主，就必须
  先换成带事务排他能力的存储或新增经实测的 OS lock；本单不靠有竞态的 pid 文件或拍脑袋
  stale TTL 冒充锁。

### 6.3 幂等状态机

1. `generated`：生产者形成 candidate；尚无交付事实；
2. `queued`：writer 接受等待串行；尚无交付事实；
3. `delivered`：snapshot 已 fsync + rename，writer 返回 durable receipt；
4. `committed-effective`：仅当对应业务 authority 的真实 commit receipt 已存在时，事件的
   effect 语义才可如此声明。writer 不从 delivered 推导它。

- 同 key、同 request hash 重试：返回原 receipt，不追加。
- 同 key、不同 request hash 重试：拒绝冲突，主流一个字节不动。
- 生成后写前猝死：恢复后没有事件，重试正常写一条。
- 写后回执前猝死：恢复索引已有事件，重试返回原 receipt，仍只有一条。

stream head 在 durable append 后自然前进；任何会话 head、事实账 ack 或业务 authority head
都不能仅凭这个 delivery 前进。

## 7. MessageTree 与主流的关系

MessageTree 不删除，但降为内部工作区投影。最终接线遵守下面的方向：

```text
canonical message event(s) committed
        → idempotent tree projection
        → session head update
        → projection receipt
```

不能反过来先让 tree/head 成为对用户可见的成功，再“有空补主流”。projector 使用 canonical
eventId 派生或携带稳定 node identity；重放时若节点已存在且内容一致就返回原 projection
receipt，内容不一致则 fail-closed。进程在 stream commit 后、tree update 前死亡，重启从
cursor 补投影；用户生命线不丢，内部工作树最终追上。

`reviseNode` 也不能原地改 canonical event：它追加 typed amendment message event，再把
MessageTree 投影到新 sibling。旧说法仍在证据里，新说法从新事件开始生效。

在这条接线完成前，PR 不得声称整个 D9 已经落地；第一刀只声称 OS-01/02 的主流内核成立。

## 8. OS-03：first-party 与 evidence 分面

新增两个不可互换的 read port：

- **FirstPartyResidentView**：canonical stream + live workspace navigator。navigator 只列
  `SessionRegistry.windowsOf(residentId)` 中仍有行动意义的工作区；不列 archived window，
  不暴露可续写的 transcript handle。
- **EvidenceViewportReader**：必须有显式 evidence principal，并沿 canonical closure/result
  里的权威 pointer 读取绑定 window 的只读流水。没有 pointer 不允许按 resident 扫全库；
  reader 没有 write/resume 方法。

关闭 workspace 由一个 lifecycle owner 协调：先形成 durable typed closure/result，再让
first-party navigator 消失。中途猝死由 reconciliation 依据 closure 事件补做幂等归档；
不能出现“归档了但主流没有解释”或“主流说关了但导航永久还活着”。`session.create` 只返回
workspace handle，客户端文案与结构都不能把它当作新聊天。

## 9. OS-04：有界 dispatch

生产验证器使用 closed union 与 exact-key check。三类合法事件都必须带可核 provenance、
`workRef`、时间、效果状态；result/closure 的产物指针按事件类型要求。拒绝测试在调用前后
读取完整 stream bytes，证明以下输入零写入：

- transcript 或 messages 数组；
- 任意 context/content dump；
- 未声明字段；
- 缺 event kind 的自由文本；
- viewport 自称 host authority。

不靠任意字符上限冒充“有界”；边界来自 schema 的表达能力。如果后来要加大小上限，必须用
真实 transport/store 数据给参数出生证明。

## 10. OS-05：宿主失败 reporter

给 `BreathCycle.notify` 接 `CanonicalLifecycleReporter`。对 `failed` 通知：

- reporter 是 host，window 是 subject；
- effect 明确 `failed-not-effective`；
- `windowRecovered`、stage 和 retry 语义保真；
- host 自动重试时 `requiresUserAction=false`；真需要人捞窗时才给具体动作；
- delivery 失败要向宿主上抛或进入 durable retry，不能只写日志。

测试复用 MV-D09 的同一份换气失败 fixture 与“失败后下一次阈值重新 announced”断言；不复制
一套会漂移的 breath 成功定义。再加 mutation：把 reporter 换成 viewport、把 effect 改成
committed-effective、只写日志不入流，三支都必须转红。

## 11. OS-06：reply router

router 只从 canonical stream 的未解决 blocked 事件与 live workspace 状态建立候选集：

- `replyToEventId` 精确命中事件；
- `workRef` 精确命中工作；
- 裸回复仅在候选集恰好一个时放行；
- 候选为零返回无目标；候选大于一返回显式消歧，任何 workspace 都收不到原回复。

focus、最近事件、window 创建时间、当前 UI tab 与模型猜测都不进入路由输入。成功投递后才
写 resolved receipt；派发失败仍保持 blocked 可回答。

## 12. 三段施工与决策闸

### PR A：canonical stream core（先做，点 OS-01/02）

范围：event core、durable store、writer、cursor projection、subprocess host fixture。

主要改动：

- `src/one-stream/{event-contract,store,writer,projection}.ts`；
- `tests/one-stream-core.test.ts`：结构、hash、幂等、resident 隔离；
- `tests/one-stream-host.test.ts` + fixture host：真实进程猝死、恢复、离线补拉；
- `acceptance/one-stream.md`：只在真实证据成立后勾 OS-01/02 并附测试名。

退出条件：

- A/B 并发到达顺序交换后，三个投影 id/seq/hash 一致；
- 两个 crash window 都恰一条；changed-content retry 拒绝；
- 同一宿主内第二个 writer 被拒绝；旧宿主退出后恢复宿主可读取原账并继续；
- 保留 id/seq 改 payload 的 mutation 转红；
- 全仓 typecheck、相关 tests、acceptance 通过；
- 明确报告写放大数据与“尚未接 message turn”的剩余缺口。

**决策闸 A**：PR A 本地证据成立后再评估 PR B/C。若核心接口稳定、剩余规模与本文相符，
Elio 继续；若 OS-03～05 暴露独立项目量，则保持本文架构，由其他 builder 分 lane。无论谁做，
不重开 D9、不复制 writer。

### PR B：first-party semantics（预案，点 OS-03/04/05）

范围：turn coordinator、MessageTree 投影、workspace/evidence read model、bounded dispatch、
BreathCycle lifecycle reporter。

退出条件：

- 第一方默认主体看不到 archived transcript capability；证据主体只能沿 pointer 只读；
- 三种有界事件可投，夹带 transcript 的 mutation 零写入；
- breath failure 主流可见、未生效、retry/user action 正确，并复用 MV-D09；
- user/assistant 用户可见路径已切到 canonical stream，MessageTree 可从主流补投影。

PR B 若超过一个可独立 review 的变更面，允许拆成 B1（turn + bounded events）、B2
（workspace/evidence）、B3（lifecycle reporter）；它们仍共享同一个 master plan 和 writer。

### PR C：reply routing 与总验收（预案，点 OS-06）

范围：blocked index、reply router、真实派发 fixture、六灯总回归、文档收口。

退出条件：

- 显式 handle 各到各窗；唯一裸候选放行；多候选零投递并要求消歧；
- 最近事件/focus/time 猜测 mutation 全转红；
- 六灯全绿后才更新 `session-api.md` 的“方向未定”；
- #84 关闭前给出测试命令、commit/PR 与仍未接真实 frontend 的诚实说明。

## 13. 测试矩阵

| 灯 | 主测试 | 失败注入 | 必须转红的 mutation |
|---|---|---|---|
| OS-01 | real host + A/B + offline C | 交换 A/B 到达序 | 同 id/seq 改 payload；viewport 自建权威流 |
| OS-02 | child process kill/restart | write 前；rename 后 receipt 前 | same key/different body；attempted 当 delivered；delivered 推 authority head；同宿主双 writer |
| OS-03 | production read models + principals | closure 与 archive 间中断 | 默认主体读 archive；evidence reader 可写；session.create 生成聊天史 |
| OS-04 | production exact validator | 每种拒绝前后比 bytes | transcript/messages/context/extra key/free text/伪 host |
| OS-05 | BreathCycle shared fixture | append/inject/swap failure | log-only；host/subject 颠倒；假 effective；失败后 announce 被吞 |
| OS-06 | two live blocked workspaces | 派发失败、候选变化 | recent/focus/createdAt 猜路由；歧义仍投一窗 |

测试层次：纯函数只测 parser/hash；store 测真实文件；OS-01/02/04/05/06 必须经过生产组合；
OS-03 必须同时经过 capability 与 first-party structured read model。mock 直接返回期望对象不点灯。

## 14. 风险、代价与回滚

- **写入瓶颈**：单 writer 与全量 snapshot 会增加延迟和写放大。先测真实数据，不写魔法阈值；
  接口隔离允许以后换 journal。
- **双投影漂移**：stream 与 MessageTree/head 中途失败。以 stream 为真源、projection cursor
  重放；内容不一致 fail-closed，不静默覆盖。
- **能力误接**：现有 `session.list/history` 很容易被 frontend 当聊天栏。第一方 reader 使用
  独立类型与端口，不让默认主体拿到 evidence reader。
- **事件流拥挤**：过多 progress 会淹没对话。先保证语义有界；展示折叠属于 projection，
  不能删除主流事件或改变排序。
- **迁移风险**：旧节点与新主流无一一对应。v0 不把旧历史伪造为新 canonical event；如需
  导入，必须有单独 migration schema、来源标记和重复运行测试。
- **回滚**：每段 PR 可独立回退。PR A 未接用户面，不改变现行行为；PR B 切读前保留 feature
  gate 与旧 control/evidence 口，出错时退回旧 user path，但不得把两条同时宣称为权威。

## 15. 开工前检查与完成回执

每段开始前：读最新 #84 thread 与 `acceptance/one-stream.md`，确认没有新裁定；记录 base
commit；先写红测试和 mutation，再写生产实现。

每段交付只报三类证据：

1. 哪几盏灯由哪个测试真实点亮；
2. 哪些 crash/mutation 被证明确实转红；
3. 哪些能力仍未接、哪些成本仍未测。

不以“文件写了”“接口存在”“测试对象能返回期望值”冒充完成。
