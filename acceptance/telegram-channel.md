# Telegram 信道与多住户群聊：验收规格

对应 [#185](https://github.com/mist-agent-harness/mist-agent/issues/185) 与 D26。
D26 当前由 [#181](https://github.com/mist-agent-harness/mist-agent/pull/181) 落台账。
本页只冻结信道边界与首个演示，不把 Telegram 地址升格成身份或宿主真源。

全部灯位初始未勾。可执行版在 `telegram-channel-checks.ts`，两边编号必须同步。

```bash
npm run acceptance:telegram-channel
npm run acceptance:telegram-channel:strict
```

## 判卷纪律

- 公共 CI 只用合成 update、receipt、token canary、resident 和 group；真实 bot token、私人聊天、家庭 bridge 与 launchd 不进入仓库。
- 判卷通过 typed driver 操作真实插件/宿主接缝，不 import 功能实现内部模块。驱动缺失时十四盏全红；坏驱动直接报错。
- 否定断言带正对照：先证明绑定、派发、token resolver 与真实可见回执工作，再判 fail-closed、撤权和零泄漏。
- 失败回执之后必须读取 canonical state、effect 或耐久回执；不能只信状态字。群聊 trace 必须带 group/address/resident/scope，不能靠数组顺序自报归属。
- 外部 message/topic/session id 只作地址。身份连续性由 D23 判；Telegram 畅通、模型回复相似或同一 chat id 都不能替它点灯。
- `STUBBED` 覆盖的方法只产桩灯。公开 CI 的 mock transport 不能让 TG/GD 灯真绿；最终还需隔离测试群真实收发回执和独立验收。
- `telegram-channel-acceptance-adversarial.test.ts` 固定九十八种已知假绿；每种作弊都要在无故障正对照通过时被对应灯判红。

## D26：Telegram 信道边界

| 灯 | 合成输入与操作 | 层级 | 可观察通过判据 |
| --- | --- | --- | --- |
| TG-01 | 先冻结 resident/scope，再绑定 chat 与 topic 地址并实际入站；最后把已见 message/user id 分别塞进 chatId 与 topicId | 绑定集成 | binding、解析与见证入站都逐字段对应创建前冻结身份；已见 message/user id 四种地址形态稳定拒绝 |
| TG-02 | 分别制造无绑定、冲突绑定、scope 不可见、撤权和旧代际，并在 advance 前后各完成当前代际请求 | 安全集成 | binding/resident/scope 先冻结；advance 返回值、新请求代际与完成派发代际一致；负例不写 effect/宿主派发且不猜 resident |
| TG-03 | 创建 resident/scope 时立即冻结初值，再绑定地址并让有效 update 经信道进入宿主 | 宿主集成 | binding 与派发身份逐字段等于绑定前冻结的 resident/scope/window/source message；插件自建宿主数为零 |
| TG-04 | 冻结 resident/scope/window 后发送重复/乱序 update，并在 advance 前后各完成当前代际请求，再结算旧请求 | 集成 | 首次、重复和乱序回执身份逐字段对应冻结真源；三个唯一 update 恰有三份冻结 effect；重复与迟到不新增 effect |
| TG-05 | 用四条 host-issued dispatch 分别制造 submitted、accepted、visible 与回执丢失，先冻结返回值再逐条耐久读回 | 传输集成 | 返回值与耐久账逐字一致且只有 visible 有 Telegram message id；活对象不得把先前返回值一起改写；unknown 保持原 binding/target |
| TG-06 | 模型、正文与 resident memory 都夹带未授权 chat/topic/message hint，再从当前 context 出站并读耐久账 | 安全集成 | 返回值与耐久账的 chat/topic 来自冻结 binding、reply message 来自入站 context；三类 hint 全部无效 |
| TG-07 | 用 token canary 建 opaque ref 并真实收发，扫描 fixture、入站 effect、边界、返回值与耐久出站回执 | 安全集成 | ref 非空且不含 canary，并被 resolver 使用；明文 token 不出现在任一可观察产物 |
| TG-08 | 先做 token 真实解析与可见出站，再各建两组在途入站/出站；先单独撤 credential 并实测新入站/在途完成，再撤 binding | 并发＋撤权 | credential 状态/代际独立推进；边界快照与撤权前 effect 账当场冻结；两阶段新旧请求稳定拒绝且 effect 不增 |
| TG-09 | 完成一次真实可见出站、冻结 binding version 与返回值并读耐久账，再让 Bot API 不可用、尝试出站并再次读账 | 观测集成 | 版本、能力、binding、最近收发可查；成功与失败的冻结返回值、耐久回执和 typed observability 彼此一致 |

## D26：首个群聊演示

| 灯 | 合成输入与操作 | 层级 | 可观察通过判据 |
| --- | --- | --- | --- |
| GD-01 | 先冻结两份 resident/scope/model/provider 输入，再建 group、完成一轮并读宿主派发账 | 端到端 | group fixture、trace 与宿主账都精确对应冻结输入；两条 model/provider 通道不同且 dispatchId 可回读 |
| GD-02 | 冻结完整 binding/resident 后更换 model/provider/runtime session，再发言并读取住户普查 | 端到端 | binding 全字段与 residentId/hash 不变；session 变化；普查逐字段等于切换结果；真实 trace 仍归冻结 resident/scope 且走新运行通道 |
| GD-03 | 冻结 resident/hash，依次缺 machine、resident、relationship 判词，再补齐；每次都读 canonical state | D23 集成 | 缺任一票与最终激活后，返回值和 canonical state 都保持冻结 resident/hash；三类判词齐全才激活 |
| GD-04 | 冻结 group/address/resident/scope 后，同轮安排一位发言、一位沉默、一位失败 | 群聊集成 | 每条 trace 与冻结计划逐字段对应；活 resident 对象不可改写 oracle；outbound 分别为 visible/null/rejected |
| GD-05 | 冷启动、重连、重复 update 与 Telegram 不可用后恢复 | 恢复端到端 | binding/canonical 不漂移；unknown 的冻结返回值与耐久账逐字一致且 message id 为 null；重启前 effect 快照独立冻结，恢复后入站/出站均不增加 |

## 点灯记录

- [ ] TG-01 Telegram id 只作外部地址
- [ ] TG-02 无效绑定与旧代际 fail-closed
- [ ] TG-03 入站经 HostProvider 权威派发
- [ ] TG-04 update 幂等且迟到结果隔离
- [ ] TG-05 送达分层并外显 unknown
- [ ] TG-06 出站目标只来自获准 binding/context
- [ ] TG-07 bot token 只走 opaque credential reference
- [ ] TG-08 撤权切断新旧入站与出站
- [ ] TG-09 插件、Bot API、binding 与真实收发可观察
- [ ] GD-01 两位 resident 独立模型同群收发可追
- [ ] GD-02 换模型不换 resident identity
- [ ] GD-03 D23 三类判词齐全才激活连续性
- [ ] GD-04 多 resident 派发、沉默、失败与送达可分
- [ ] GD-05 冷启动、重连与平台故障不漂移不重放

代价：十四盏灯跨绑定、宿主、Telegram transport、D23 与群聊编排；公共 CI 只能复演合成传输。最终真绿还需要隔离测试群和真实 Bot API 回执，因此验收比普通 adapter 单测更慢。
