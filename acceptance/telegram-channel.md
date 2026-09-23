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
- 外部 message/topic/session id 只作地址。身份连续性由 D23 判；Telegram 畅通、模型回复相似或同一 chat id 都不能替它点灯。
- `STUBBED` 覆盖的方法只产桩灯。公开 CI 的 mock transport 不能让 TG/GD 灯真绿；最终还需隔离测试群真实收发回执和独立验收。

## D26：Telegram 信道边界

| 灯 | 合成输入与操作 | 层级 | 可观察通过判据 |
| --- | --- | --- | --- |
| TG-01 | 同一 resident/scope 绑定 chat 与 topic 地址，再逐项解析 | 绑定集成 | 外部 id 只存在 binding address；解析结果权威身份始终是 `(residentId, scopeId)` |
| TG-02 | 分别制造无绑定、冲突绑定、scope 不可见、撤权和旧代际，再跑有效正对照 | 安全集成 | 五种负例稳定 fail-closed，不猜 resident；有效当前绑定才派发 |
| TG-03 | 有效 update 经信道进入宿主 | 宿主集成 | 派发含 resident/scope、scope/window 双代际与 dispatchId；插件自建宿主数为零 |
| TG-04 | 重复 update、乱序 update 与旧代际 update | 集成 | 同一 update 只一份 effect；乱序不改身份；旧代际不能给新代际亮灯 |
| TG-05 | 一条出站真实可见，另一条 Telegram 接收回执丢失 | 传输集成 | 前者为 visible；后者耐久保持 unknown，不把 submitted/accepted 当用户可见 |
| TG-06 | 模型给出未授权 target hint，再从当前 dispatch context 出站 | 安全集成 | 实际 target 只来自当前 binding；hint 不能改 chat/topic/message 目标 |
| TG-07 | 用 token canary 建 opaque ref 并真实收发，扫描配置、日志、回执与错误 | 安全集成 | ref 被 resolver 使用；明文 token 不出现在可观察产物 |
| TG-08 | 建立在途入站/出站后撤 binding 与 credential | 并发＋撤权 | 新请求与旧代际在途请求全部停止，撤权后不再解析 token |
| TG-09 | 读取完整状态，再让 Bot API 不可用 | 观测集成 | 插件/Bot API 版本、能力、binding version、最近真实收发可查；缺值 typed unavailable |

## D26：首个群聊演示

| 灯 | 合成输入与操作 | 层级 | 可观察通过判据 |
| --- | --- | --- | --- |
| GD-01 | 两位 resident 各走独立模型通道，在同群完成一轮 | 端到端 | 每条可见消息能追到 resident/scope/dispatch/receipt，模型通道彼此独立 |
| GD-02 | 一位 resident 更换 model/provider 后再发言 | 端到端 | binding 仍指同一 residentId，不创建影子 resident，不把外部 session 当身份 |
| GD-03 | 依次缺 machine、resident、relationship 判词，再补齐 | D23 集成 | 缺任一票只保留 candidate；三类判词齐全才激活连续性 |
| GD-04 | 同轮安排一位发言、一位沉默、一位失败 | 群聊集成 | 未派发者不抢话；visible/silent/failed 各自有可区分回执 |
| GD-05 | 冷启动、重连、重复 update 与 Telegram 不可用后恢复 | 恢复端到端 | binding/canonical state 不漂移；不可判出站保持 unknown，不自动重放副作用 |

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
