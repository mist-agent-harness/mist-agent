# WindowNavigationIndex：跨窗导航索引 Phase 0 图纸

对应 [#150](https://github.com/mist-agent-harness/mist-agent/issues/150)
（[#131 最终指针](https://github.com/mist-agent-harness/mist-agent/issues/131#issuecomment-5612163491)），
收编 [#131 主笔拍板](https://github.com/mist-agent-harness/mist-agent/issues/131#issuecomment-5612141592)
（D15，已由 [决策台账](../decisions.md) 收账，本稿不另行拍板）、
[Elio 契约审阅](https://github.com/mist-agent-harness/mist-agent/issues/131#issuecomment-5487847875)、
[内容检索前门边界收紧](https://github.com/mist-agent-harness/mist-agent/issues/131#issuecomment-5538244883)
与[阿问生产侧数据](https://github.com/mist-agent-harness/mist-agent/issues/131#issuecomment-5555888480)。
本单交付设计与[全未勾选验收](../../acceptance/window-navigation.md)，不实现、不接生产；
「全红」指未实现、未运行的语义规格。接缝核对基线 main `21d3c45`。

## 目标与边界

住户面对很多已经结束的窗时，回答「哪一扇旧窗、哪一条原始记录可能相关」。
WindowNavigationIndex 是可重建、非权威的只读投影：真源仍是 canonical stream /
window history / handoff；命中只返回 source handle 与召回回执，不返回「记忆结论」。
记忆回答「我现在相信什么」，导航索引回答「原文可能在哪」，本单只做后者。

钉死的边界（施工时不许改口）：

1. 索引是 projection，可删可重建；删除、损坏或落后不影响任何权威状态。
2. 命中只返回 source handle；snippet、score、向量本身永远不是证据。
3. 不接管 message tree、generation、事实 supersede；不把命中自动塞进下一窗 prompt。
4. `baoer_signal_grep` 可做 Agent 可见的内容检索前门，不替代 canonical source；
   前门不禁内部 `resolveSource(handle)`、权限复核与运维诊断，`glob/find` 只找路径、
   不算平行事实搜索面；path/line 只是临时 locator。
5. 索引消费权威底座提供的只读枚举／投影接口；canonical stream / window history /
   handoff 是 source channel，不是三条各自 ingest 的真源链（#120 已批「一份底座」，
   见接缝表）。

下游分工照 [history-search-phase-0.md](history-search-phase-0.md) 已合入的口径：
#150 管「原文可能在哪」——可重建 projection、候选 handle、分页和召回回执；
#152 管「怎么查、证据够不够、何时停」。索引不能宣布事实确认。

代价：多一层投影要维护一致性回执；索引挂了只能降级导航；「命中不是证据」意味着
每次取证都要多付一跳回源。

## 数据流：闸在实际位置

```text
权威真源（canonical stream / window history / handoff，经权威底座只读枚举）
  ↓ 【闸一】入索引前按当时 policy 脱敏／可见性过滤，保留稳定 source handle
WindowNavigationIndex（只读投影；可删可重建；允许最终一致）
  ↓ 查询 【闸二】按当前 residentId + scopeId + policy 限定范围
候选 source handle + snippet + 召回回执
  ↓ 回源 【闸三】重新授权、核对身份与 hash（归宿主 resolver 与 #152，本单不代判）
权威原文
```

闸一在投影形成之前，不存在「原文先入库再过滤」的窗口。闸一通过不等于永久可见：
闸二按查询时刻的 policy 重判，闸三在回源时刻再判。命中后撤权的反例必须成立——
即使缓存或旧 snippet 仍留在库里，也不得带出内容。归档不等于隐藏：归档记录是否
仍可取证由权威 visibility policy 决定，索引不自行发明隐藏语义。

代价：同一条权限被判三次；索引层要接受「库里存着但永远查不出」的死重，
不能拿库内存量反推 policy。

## Port 形状与职责边界

`MistWindowNavigationIndexPort` 独立于 `MistWindowHistoryPort`：后者回答「这扇窗
的历史是什么」，是权威底座的 projection，由 #120 判卷；前者回答「哪些窗、哪些
记录可能相关」，是可丢的导航投影。检索职责不塞进 history port；导航 port 挂掉时
history 不得因此失真。Phase 1 只做词法，只提供宿主内部只读查询；不恢复用户可见的
永久 session 列表（#131 边界第七条，非目标）。

语义表（只钉语义，不冻字段拼写）：

| 面 | 必须表达什么 |
| --- | --- |
| 查询输入 | resident、scope、query、limit、cursor；每次查询不得越过用户硬约束与本次授权，可在其内调整检索范围，变更按 #152 记录为新 attempt |
| 候选输出 | 按域的 source handle、snippet（找线索的材料，非证据）、召回 channel、score |
| 分页 | cursor 绑定原查询与候选 snapshot；快照两支语义见回执节 |
| 召回回执 | projection/index version、policy version、水位、截断／降级原因；披露范围随获准 scope |
| 结构化失败 | unavailable／degraded／stale 与零命中机器可分，原因可读 |
| 宿主 resolver 接缝 | handle 交宿主 resolver 回源，解析时重新授权；索引不自带回源实现 |

代价：两个 port 是两份运维面；「可丢」的那份挂掉时要能证明权威那份没受影响。

## source handle：按域定义，语义现在就钉

字段拼写不在本单冻（D15 第三条），但 handle 的语义不挂起：

- **handle 是版本化的 discriminated union，按 `sourceDomain` 区分。** 三个域的
  身份形状与 resolver 不同，不为统一表格伪造同一种 eventId：
  - canonical stream 域：#84 已拍板的 `residentId / eventId / streamSeq / payloadHash`
    （[event-contract.ts](../../src/one-stream/event-contract.ts) 现状，schemaVersion 1）；
  - window history 域：以 `(windowId, generation, seq)` 为来源 provenance；
    寻址主键与拼写归 #120 判卷落定，本单不提前定；
  - handoff 域：#81 已实物的标题锚点
    （[handover-letters.ts](../../src/one-stream/handover-letters.ts)，recall 区分
    found / not-found / unavailable）。
- **不默认跨域字段等同。** `eventSeq` 与 `streamSeq`、`sourceHash` 与 `payloadHash`
  在上游明确规定映射前不默认同义；判据拒绝的是来源域、事件范围、hash 校验对象
  的错配，不是数值恰好相同。#84 的三件把手可引用为 canonical 域的已有接缝，
  不得宣布为所有来源的统一 handle。
- **多事件 chunk 必须覆盖完整事件范围。** handle 用明确的 seq range 或 event-id
  list，不拿单个 eventId 给整段背书；Phase 1 若嫌复杂，退路是先按单事件建文档——
  二选一，不许中间态。
- **hash 校验对象与序列化版本必须明确。** canonical 域的 `payloadHash` 校验对象＝
  去掉 `payloadHash` 自身的完整 canonical event（全部 draft 字段加
  schemaVersion / residentId / eventId / streamSeq）的 stable JSON sha256
  （event-contract.ts 现状）；其余域各自声明校验对象。hash 绑定 serialization
  version，否则同一内容换一版序列化会产生假损坏。
- path/line 只是当前 projection 的临时 locator，会随切块、压缩、迁移漂移，
  不进稳定契约，不作回源依据。

代价：union 比统一表格难摊平，查询层多一次按域分发；「完整范围」使 chunk 命中在
范围内任一事件失效时都要重判可信状态。

## 索引单元准入（Phase 1，D15 第二条）

- handoff title：进。#81 已定必填、唯一、可检索的召回锚点，低噪声词法入口。
- event chunk：进，且必须精确回源（上节范围规则）。
- 摘要：仅当它是权威主流里正式持久化的 typed record、带稳定 eventId 与可核证的
  原始事件指针才进；`summary` 类型标签本身不够。索引自产摘要不进；OS-03/04 尚未
  给出这种源记录时，Phase 1 先不收。

Phase 2 向量只作 shadow candidate，不覆盖词法命中，未过判卷不进住户可见结果；
Phase 3 关系导航只有一跳检索确实不够时再议（#131 分阶段原文，此处不重复拍）。

代价：摘要准入几乎收干，Phase 1 召回上限就是「标题＋原文片段」；换来的是索引里
没有一条无法回源的字。

## 召回回执与一致性

回执是本单交给下游的事实，不留给 SearchEpisode 猜。每份召回回执至少携带：
projection/index version、policy version、索引水位（目标水位与已索引水位）、
截断／降级原因。四件失败语义各自独立：

| 项 | 失败判据 |
| --- | --- |
| 服务不可用 | 结构化 unavailable 带降级原因；不得返回正常空结果冒充零命中 |
| 候选截断 | top-k／分页未完不得报告完整覆盖；保留数与展示数分开记 |
| 索引水位 | 落后、未知不得冒充已追齐；水位差应能解释「刚写的为什么查不到」 |
| cursor | 绑定原查询与候选 snapshot；不串快照——原 snapshot 仍可读则按原快照续页（重新过当前权限闸），不可读则显式失效 |

回执的披露范围随获准 scope：水位与版本按查询获准的范围报告，隐藏 scope 的新增
不得经全局水位／版本侧漏存在（与隔离判据合并检查；下游 #152 图纸同款披露约束）。

重建另列：从权威真源清空重建后，所有已收录 hit 的 handle 精确回源；没有可服务
snapshot 时查询走「服务不可用」语义，不冒充零命中。「重建期间一律停查」是更强的
额外策略，实现若选它须单列决定与代价，本单不预设。

失败恢复不许洗绿：对某 handle 的失败回执，不被改了 query／handle／范围／snapshot
的另一次成功覆盖为「已恢复」；同一 handle 的后续成功也不单独证明是同一请求的恢复，
须显式关联。索引层保留原失败与后续尝试的关系即可，不再造 episode 状态机——
「B 不得替 A 的调查结案」归 #152（SE-11）。

代价：回执比单一 status 长；水位与版本字段让每次查询多付一份记账。

## 与上游／下游的接缝

以下为基于 main `21d3c45` 的源码与清单核对，不是运行验收。

| 接缝 | 已有 | 本单不能当作已完成的部分 |
| --- | --- | --- |
| #84 canonical stream | [event-contract.ts](../../src/one-stream/event-contract.ts) 的 eventId / streamSeq / payloadHash、authoritySource / origin；[writer.ts](../../src/one-stream/writer.ts) 唯一写方；OS 六灯 2026-09-10 主笔授权勾 | 独立复验尚未落章；closure / result 已有带 summary 的 typed 实物与证据读取入口（[bounded-work-events.ts](../../src/one-stream/bounded-work-events.ts)、[workspace-read-model.ts](../../src/one-stream/workspace-read-model.ts)），但尚未按摘要准入条件验证，生产回源接缝待齐 |
| #120 window history | 先决①已批「一份底座」（[批字](https://github.com/mist-agent-harness/mist-agent/issues/120#issuecomment-5461037014)，2026-08-29）：canonical event store 唯一底座唯一写方，window history 为 `(windowId, generation)` 只读 projection；[WH-01–06](../../acceptance/window-history.md) 全未勾规格已收编；楼内已联合认领 | 生产实现未落地（src 零命中）；稳定寻址、分页、迁移接缝待其判卷；局部 transcript 只进证据面（OS-03/04），不因索引把局部流水塞进用户主流 |
| #81 handoff | [handover-letters.ts](../../src/one-stream/handover-letters.ts) 标题必填唯一、recall 三态；MV-D05/D10 绿 | 标题检索只是导航；统一 handle 契约与回源时的权限刷新待对齐 |
| baoer_signal_grep | 纯纸面（D15 与 #152 图纸文字） | 作前门的适配、strict scope 与证据契约全部未动工 |
| #152 history_search | [图纸](history-search-phase-0.md)与 [SE-01–15](../../acceptance/history-search.md) 全红规格已合 main——已合入的下游消费契约 | 其实现依赖本单的 handle 与回执语义；两单各自全红，不互相借灯 |

实现前置：#120 生产 projection 落地并给出稳定 ID 前，本单不进入实现；字段级
schema、fixture 与端点在那之后的实现单里冻结。

代价：排期被上游锁死；但语义与判据可以先评审，这正是 Phase 0 的用途。
