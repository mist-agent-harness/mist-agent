# window-history 只读投影：施工设计（#120）

本页交代 `acceptance/window-history.md`「代价」段里点名**留待施工时交代清楚**的那件事
（「一份」裁定下 history 投影主流与 OS-03/04 的并存语义），以及施工期落下的几条设计决定
及其代价。判卷口径不在本页：六盏灯的真源是 `acceptance/window-history.md`，可执行判卷是
`acceptance/window-history-checks.ts`（归 #196 后继维护）。本页只写**实现侧**怎么接线、
为什么这样接、代价是什么。

先决①（2026-08-29 批字，不再重开）：canonical stream event store（`src/one-stream/`）是
唯一底座与唯一写方；window history 是它按 `(windowId, generation)` 的只读 projection，
不构成第二条写入路径。任何新的耐久事实必须经**同一个**写方落进**同一条**流水。

## 1. 三个面，一份底座

| 面 | 装什么 | 谁能读 | 代码入口 |
| --- | --- | --- | --- |
| 主流（canonical stream） | typed 事件，自带 `origin.viewport` provenance | 用户面投影 / window-history 只读投影 | `src/one-stream/store.ts`、`src/window-history/projection.ts` |
| 证据面（evidence plane） | 归档 viewport 的**逐条 transcript**（活在 MessageTree，不在主流里） | 只有宿主签发的 evidence principal，凭 canonical `result` 指针 | `EvidenceViewportReader` → `MessageTreeViewportHistory`（`src/one-stream/workspace-read-model.ts`） |
| 恢复面（recovery plane，本单新增） | **窗账事实**：某扇窗开出了第几代、当代是否已归档 | 只有宿主自己（冷启动重建窗账） | `WindowHistoryHost.#replayDurableWindows`（`src/window-host/window-history-host.ts`） |

三个面共用一条落盘流水，靠**事件信封**而不是靠第二份存储彼此分开：

- 主流条目：`origin.viewport` **非空**，指向具体 `(windowId, generation)`；
- 窗账事实：`origin.viewport` 为 **null**（它是**关于**一扇窗的记录，不是**发生在**这扇窗
  里的一句话），`payload.kind = 'mist.window-history.lifecycle/v1'`；
- 证据面根本不在这条流水上：它读的是 MessageTree，主流里只留 typed closure/result 卡片与
  权威产物指针。

只读投影（`src/window-history/projection.ts`）只收 viewport 命中本窗的事件，所以窗账事实
既不进历史页、不影响 `summarize.blank`、也不抬 `updatedAt`；WH-03 逐项比较的「旧引用事件
集合」一条不多。

## 2. OS-03 / OS-04 并存语义（清单里留的那笔账）

OS-03 要的是「归档流水只进证据面，不长成第二条聊天史」；OS-04 要的是「有界投递不夹带局部
transcript」。「一份」裁定下 window history 是主流的切片，所以必须回答：这个切片会不会变成
第二本 transcript，或者变成局部 transcript 入流的新口子。逐条对照现行代码路径：

**① 投影没有写面，所以它不可能成为入流口子（OS-04）。**
`MistWindowHistoryPort` 上恰好只有 `summarize` / `read` 两个成员，多一个或少一个都被 WH-06
的静态审计（`acceptance/window-history-write-surface.ts`）判红；投影目录 `src/window-history/`
里禁止出现写句柄与任何落盘写系统调用。viewport 面**唯一**合法的投递口仍是
`BoundedWorkEventPort`（`src/one-stream/bounded-work-events.ts`）：exact-key envelope、
三类 purpose、authority source 由宿主注入，夹带 transcript / messages / 无类型正文一概拒收且
主流字节不变（OS-04 已勾的判据）。window history 一个字节都不会多于主流已经接受的事实。

**组装约束（明写，给后续接线的人）**：`WindowHistoryHost.appendWindowEvent` 收的是任意
`JsonObject` payload，它是**宿主侧**的组装 API（在 `src/window-host/`），不是 viewport 面的
口子。把它直接暴露到线协议上就等于绕开 `BoundedWorkEventPort` 的 envelope 闸 —— 那会正犯
OS-04。生产组装必须保持：viewport 只能走有界投递口，`appendWindowEvent` 只给宿主自己用。

**② 投影读不到证据面的逐条 transcript（OS-03 前半）。**
`WindowHistoryProjection` 的构造入参只有 `CanonicalStreamReadPort` 与 `WindowLifecycleView`
（一个只读生命周期视图），**完全没有接 MessageTree**。归档 viewport 的逐条流水只能经
`EvidenceViewportReader` 读到，而它要求：宿主用 WeakSet 对象身份签发的 principal（不是一段
可伪造的 capability 字符串）、一个 canonical `result` eventId、并逐项核对 closure/result 配对
与 viewport 绑定。window-history 投影与这条链零接线，所以它没有把证据面搬到用户面。

**③ 窗的只读流水不是「第二本权威聊天史」（OS-03 后半）。**
判据三条，都是结构性的而不是约定：
   - 它**就是主流**按 provenance 的切片，不是第二份需要裁定权威的存储 —— 冲突时无需裁定，
     因为只有一份字节；
   - 它**没有续聊能力**：port 上只有 summarize/read（WH-06），`FirstPartyResidentView` 的
     快照里根本没有 archive/history/resume 成员，用户面 `create` 也不收 windowId/headId；
   - 归档窗**写不进去**：D7（`docs/decisions.md` D7）定「关窗归档为只读日志／导出证据」，
     本次施工把它变成了机器可核的行为 —— 归档窗的写 fail-closed，且归档态跨重启有效
     （见 §3）。所以客户端把归档窗渲染成只读日志是 D7 允许的那种「只读日志/导出证据」，
     不是第二本可续写的权威 transcript。

**④ 已知且有意的重叠：关窗卡片会出现在窗的历史页里。**
`WorkspaceLifecycleOwner`（OS-03 的关窗协调器）写的 closure-requested / result-closed 两条事件
带**非空** viewport，因此一旦与本宿主共用同一条流水，它们会作为普通历史条目出现在该窗的
只读流水里。这是「一份」的正常语义（关窗这件事本身属于该窗的历史），也正是 OS-03 要求主流
留下的 typed closure/result 卡片。代价：客户端不能把「归档后窗里还有条目」当成「这扇窗可以
续聊」—— 能否续聊的权威是 `summarize.running`（现已耐久，见 §3），不是条目有无。

**⑤ 本单的代价（承清单原文）**：投影不自带写入路径 ⇒ 排期被上游锁死；fail-closed 会把一部分
「其实没事」的读故障显式报红 ⇒ 多误报处理成本；格式版本字段与墓碑让每条记录为未必发生的
迁移付钱；窗账事实让每次开窗/换气/归档多一条底座事件 ⇒ 落盘量与写延迟增加。换来的是
「history 不活在内存里」。

## 3. 窗身份与生命周期：一本账（缺陷一的施工口径）

独立验收席（2026-09-24）钉出的根因是**两本互不相连的窗账**：`SessionRegistry` 自铸
`w_`+ULID 身份、回放自己的 journal，而宿主对外用判卷给的显式 `windowId`、另维护一张只活在
内存里的账。后果是换气与归档都不耐久：重启后旧代迟到写被接受（WH-02 的 fail-closed 只在单
进程内成立）、归档窗报 `running: true`、归档窗甚至同进程内就能写。

**决定**：窗的「当前代际」与「是否归档」是耐久事实，经先决①的唯一写方写进 canonical stream
（窗账事实，两种 state：`generation-opened` / `archived`），内存窗账降级为它的缓存；冷启动只
靠重放这些事实重建。三条纪律：

1. **耐久先行**：`openWindow` / `rotateGeneration` / `archiveWindow` 先落窗账事实，成功了才改
   内存态；写失败就 fail-closed，绝不谎报「已换气/已归档」。与 `SessionRegistry.kill`
   （先落 journal 再改内存）、`WorkspaceLifecycleOwner.close`（先落 closure-requested，归档
   成功后才落 committed-effective result）同源。
2. **幂等**：把手是 `window-lifecycle:{windowId}:{generation}:{state}`，同一个生命周期动作重试
   不会写出第二条事实。
3. **不进用户面**：窗账事实 `origin.viewport` 为 null（见 §1）。识别它按 `payload.kind` + 信封
   一致性，**不按 `purpose` 一刀切** —— 交接信（`src/one-stream/handover-letters.ts`）用的也是
   `purpose: 'lifecycle'`，按 purpose 过滤会把交接信卷进窗账。

**为什么不复用 SessionRegistry 的换气实现**：它的 `open()` 只给**新窗**自铸 `w_`+ULID，显式
`windowId` 只在「重开一扇已停止的窗」时才收。要复用就必须另存一份「显式 windowId ↔ 注册表
自铸 id」的映射，而这份映射本身是一条新的耐久事实 —— 那就是第二条落盘写路径，正犯先决①。
所以宿主不再持有 SessionRegistry，改为直接在唯一底座上表达同一套换气纪律（代际单调、归档
只读、重开即 +1）。
**代价（明写）**：这套纪律在 `src/window-host/` 重述了一遍，要随 MV-A01~A03 同步维护；换来的
是只有一份耐久水位、跨进程可恢复、且没有第二条写路径。
边界不变：`SessionRegistry` 仍是运行期**活窗表**的权威（scope 授权、`DispatchReceipt` 回执、
`headId`、迟到结果过滤），它的 journal 记的是活窗与归档证据，不是 history 的权威。

**归档窗的写为什么报 `stale-generation`**：归档过的那一代已封存，同代写也是对一条已关闭代际
的迟到写。判卷契约的错误码并集已冻结（`acceptance/window-history-driver.ts`），本层不擅自加码。
**代价**：「归档」与「旧代」在错误码上同值，要分辨得读 `message`。专设 `window-archived` 码需要
与判卷契约联动改动，已作为 #196 后继的待议项交回。

## 4. 窗的「存在」权威 vs 唯一底座

一扇窗**存在**当且仅当：底座里有它的事实（窗账事实，或带该 `windowId` 的历史事件）**且**本地
还有它的格式记录 `*.wh-format.json`（记「这批事件按哪个 `formatVersion` 呈现」）。

- 底座是 append-only 的唯一底座，**永不删事件**：删事件会连带毁掉同住户其他窗，并破坏
  `streamSeq` 连续性（`store.ts` 的 `parseRecord` 会在恢复时直接拒绝）。
- 所以 WH-04 的 `deleteDurableWindowData` 删掉的只是**格式记录**（呈现记录）。删掉之后投影
  说不清这批字节该按哪个格式版本呈现，于是 fail-closed 报 `window-not-found` —— 不是拿空页
  冒充「这窗没有历史」。
- 底座里的事实没被销毁：重新 `openWindow` 时，这扇窗的代际与归档态原样重放回来，**绝不倒退
  回第 1 代**（倒退会让旧代迟到写复活）。

**代价（明写）**：存在权威因此是「底座事实 ∧ 本地呈现记录」的合取，两者缺一读就 fail-closed；
换来的是「唯一底座永不被删改」与「读不到 ≠ 读到是空」这两条同时成立。

## 5. 迁移/回滚的次序纪律（缺陷二的施工口径）

单份格式记录的写是原子的（tmp + fchmod + fsync + rename），但**多份记录的重写不是一次原子
操作**。旧实现把控制账留到循环全部跑完才落盘，所以死在循环中间会得到「前几份 v2、后几份 v1，
控制账仍报旧状态」的盘：一次既没完成、也看不出没完成的操作。

新次序（migrate 与 rollback 同构）：
1. 备份每份格式记录的字节到 `window-history.backup/`（唯一的回滚素材）；
2. **先把 `status='incomplete'` + `target` + `operation` 落盘**（读闸关上，投影一律
   fail-closed 到 `migration-incomplete`）；
3. 才逐份原子重写（migrate）／逐份从备份还原（rollback）；
4. 只有终态（`complete` / `rolled-back`）落盘之后读闸才放开。

续跑两条硬纪律：**不重新备份**（中断时盘上已版本混杂，再备份就覆盖掉唯一素材）；**未完成的
回滚只能继续从备份还原**，绝不走 `#rewriteRecords(1)` —— 那条路会把 `legacyMark` 写成 null，
等于把要还原的旧信号点亲手销毁。有未完成操作时拒绝再起一次 migrate。
`interruptMigration` 是同一条真实路径的**前缀**（备份 + 关闸，然后由调用方杀宿主），不是旁路。
重写循环中途的故障由 `WindowStorageFormatAdminOptions.onRecordPersisted` 注入，所以「死在重写
中间」也走真实 migrate/rollback。
**代价（明写）**：每次 migrate/rollback 多一次控制账落盘（关闸），加上原本的全量备份拷贝，落盘
量约为窗数的两倍；生产类型上多一个只有测试/演练会传的可选钩子（不传时零开销）。换来的是
「读端永不见半写页」「中途猝死可识别、可续跑、可退回」「退回字节可复原」三条硬保证。

## 6. 两个待决项的裁断

### 6.1 `occurredAt`：定值哨兵，直到底座把「请求同一性」与「宿主观测时间」解耦

窗事件与窗账事实的 `occurredAt` 是常量 `1970-01-01T00:00:00.000Z`
（`WINDOW_EVENT_OCCURRED_AT`）。它不是忘了改：`occurredAt` 参与底座的请求 hash
（`hashSubmission(residentId, draft)`），而幂等判定是「同一把手 + 同一请求 hash」。一旦换成
挂钟，同一个逻辑写的重试就会算出不同 hash，被底座判成 `idempotency-conflict` —— 幂等直接
失效。所以在底座支持「与宿主观测时间无关的请求同一性」（或调用方把时间随幂等把手一起传进
来，属 #84 OS-01/02 与冻结判卷契约的联动改动）之前，本层不引入任何挂钟时间源。
**排序与「多新」的权威是 `streamSeq`，不是 `occurredAt`。**
**代价（明写）**：任何把 window-history 事件的 `occurredAt` 当真实时间读的消费方都会读到 1970。
这个字段在本层只有「无宿主挂钟权威」一个含义，必须这样记进契约，不许当时间用。解锁条件写明
在此，交回 #84 与生产组装决定谁先动。

### 6.2 `summarize.updatedAt`：单调修订号，不是时间戳

`updatedAt` 返回该窗健康历史条目里最大的 `streamSeq`（无历史为 0）。契约只声明它是 `number`
且不带单位，所以这里把语义钉死：它是**单调修订号**（越大越新，跨重启稳定、完全由落盘事实
派生），**不是时间戳**。理由：本层没有可信挂钟（见 6.1），返回一个 1970 派生的「时间」比返回
一个诚实的修订号更坏 —— 那是撒谎。
**代价（明写）**：想显示「最后活动时间」的消费方在本层拿不到，必须另找带挂钟权威的面；
`updatedAt` 也不再等于流水长度（窗账事实占号但不进条目集合）。webui 侧 `HistoryEntry` 的映射
按主笔 2026-09-24 裁定不在 #120 范围内，那边若要渲染日期，必须先有一个带时间权威的字段。

## 7. 判卷之外、测试钉住的行为

六盏灯不覆盖的恢复路径由仓内测试钉死（是否升格进判卷程序归主笔裁定）：

- `tests/window-history-lifecycle-recovery.test.ts`：换气跨**真实 SIGKILL 重启**后旧代写仍
  `stale-generation`；归档窗同代写被拒且重启后仍只读；归档窗重启后 `running: false`；窗账事实
  不进历史页/不破 `blank`/不改 WH-03 的旧引用事件集合；格式记录丢失后读 fail-closed 而底座事实
  不被销毁。真实猝死夹具：`tests/fixtures/window-history-lifecycle-crash.ts`。
- `tests/window-history-migration-faults.test.ts`：**真实** migrate/rollback 重写循环中途写失败
  与**真实 SIGKILL**后，重启态可识别为未完成且可续跑/可退回、读端 fail-closed、修复后不出混合
  页；未完成的回滚续跑必须从备份还原（`legacyMark` 必须非空 + 逐条字节等价）；有未完成操作时
  拒绝再起 migrate 且备份字节一个不动。真实猝死夹具：
  `tests/fixtures/window-storage-migration-crash.ts`。

全套 window-history 验收与测试须以**非 root** 跑（仓里另有约十处 chmod-based 写失败测试在 root
下假红），见 `docs/runtime-config.md`。
