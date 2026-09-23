# HostProvider 契约与本地参考实现：验收规格

对应 [#184](https://github.com/mist-agent-harness/mist-agent/issues/184) 与 D24。
D24 当前由 [#181](https://github.com/mist-agent-harness/mist-agent/pull/181) 落台账；
本页只把已拍板边界变成可执行判卷，不替台账扩写云 provider 或信道决定。

全部灯位初始未勾。可执行版在 `host-provider-checks.ts`，两边编号必须同步。
报告模式与严格模式分别为：

```bash
npm run acceptance:host-provider
npm run acceptance:host-provider:strict
```

## 判卷纪律

- 只用合成 resident、scope、credential canary、provider 与外部地址；真实凭证、私人数据和家庭常驻服务不进入仓库或公共 CI。
- 判卷通过 typed driver 操作真实宿主路径，不 import 功能实现内部模块。驱动缺失时十四盏全红；驱动存在但坏掉时直接报错。
- 健康只认带 `probeId` 且晚于 probe 开始时间的 fresh readback；进程存在、自报在线、旧时间戳和 mock 回执都不能替代。
- 否定断言带正对照：先证明显式远端绑定、凭证解析、真实送达或迁移路径确实工作，再判零泄漏、撤权和 fail-closed。
- 失败返回后必须重读 effect、resident、provider 代际或访问日志；不能只信驱动自报的 `Result`、字段清单或状态字。
- `STUBBED` 覆盖的方法只产桩灯，不算真绿。方框由未参与施工的独立验收席依据固定 commit、正式命令与输出勾选。
- 本批允许第二 provider 使用契约测试替身，只用于证明抽象可替换；本地参考实现的生命周期、健康读回和存储路径必须是真零件。
- `host-provider-acceptance-adversarial.test.ts` 用合成作弊驱动固定十五种已知假绿；每种攻击必须在无故障正对照为绿时单独判红。

## D24：HostProvider 契约面

| 灯 | 合成输入与操作 | 层级 | 可观察通过判据 |
| --- | --- | --- | --- |
| HP-01 | 本地 provider 依次 provision、attach、wake、stop、revoke，再尝试 wake | 集成 | 每步进入稳定状态；revoke 是终态，后续 wake 返回 `PROVIDER_REVOKED` 且不改状态 |
| HP-02 | 先让进程存在且 provider 自报在线、probe 失败；再让真实 probe 成功 | 本地真实集成 | 前者不能报 fresh；后者的 readback 要匹配 `probeId`，时间晚于 probe 开始，来源为 probe |
| HP-03 | 权威派发字段逐个缺失，再试错 scope、旧 scope generation、旧 window `generation` 与完整正对照 | 集成 | 完整当前双代际先被接受；缺字段、错 scope、任一旧代际全部 fail-closed，失败不增加 effect |
| HP-04 | 同一 `dispatchId` 重复派发，再升级 scope generation 并提交旧回执 | 集成 | 只产生一个 effect；旧回执稳定报 `STALE_SCOPE_GENERATION`，随后 effect 与 resident 真源读回不变 |
| HP-05 | 一条消息跑到用户可见，另一条在 provider 执行后丢回执 | 集成＋恢复 | 第一条耐久记录 accepted → received → executed → visible；第二条停在 unknown/`RECEIPT_LOST`，不跳层伪报 |
| HP-06 | 用 secret canary 建 opaque credential ref 并真实 wake，扫描 ref、配置、日志、回执与导出 | 安全集成 | ref 非空且不含 canary，并被 resolver 使用；明文 canary 不落任何可观察产物 |
| HP-07 | 确认断线、重启重放均已注入并留账，再读取 resident 真源 | 集成＋恢复 | 故障有稳定身份和日志；residentId、canonical state hash、承诺和撤权真源不被 provider 状态覆盖 |
| HP-08 | 用同一真实 probe 读健康和完整 observability，再让政策与费用源不可用 | 集成 | 版本、能力、政策、数值＋币种、同一 fresh health 可查；缺值的数值和币种均为 typed `unavailable` |

## D24：用户控制权

| 灯 | 合成输入与操作 | 层级 | 可观察通过判据 |
| --- | --- | --- | --- |
| HC-01 | 只建本地 provider 读取 egress，再显式绑定远端测试 provider | 安全集成 | 本地默认零 egress；显式远端绑定要有 provider/resident/payload 正证据，payload 不含 private canary 值 |
| HC-02 | 从本地真实实现导出，交给第二个契约实现恢复并读取 provider 访问日志 | 迁移集成 | 全导出不含源 provider id；恢复不重访源端、确实访问目标端，residentId 与 canonical state hash 不变 |
| HC-03 | 先真实解析凭证并建立在途 wake，再 revoke，重试 wake、health 与旧请求 | 并发＋撤权 | revocation generation 前进；新旧路径稳定拒绝，凭证计数不增，终态与 effect 读回不变 |
| HC-04 | 制造断线、重复 wake、超时与回执丢失，并读取故障日志与 resident 真源 | 故障集成 | 每次注入有稳定身份并留账；结果确定，重复 wake 只一份 effect，resident 全真源不变 |
| HC-05 | 导出后撤销原 provider，再由另一实现恢复并读取 provider 访问日志 | 迁移＋恢复 | 全导出不含源 provider id；恢复不访问原 provider、确实访问目标端，身份与 canonical state 完整 |
| HC-06 | 绑定合成外部地址，替换 provider session 后重新解析 | 信道集成 | 地址始终解析到同一 `(residentId, scopeId)`；provider session 只变运行地址，不变身份 |

## 点灯记录

- [ ] HP-01 生命周期动作有稳定状态与撤权终态
- [ ] HP-02 本地健康只认 fresh probe
- [ ] HP-03 权威派发字段与双代际 fail-closed
- [ ] HP-04 dispatch 幂等且旧回执不能跨代结算
- [ ] HP-05 回执分层并外显 unknown
- [ ] HP-06 opaque credential reference 零明文落盘
- [ ] HP-07 provider 故障不改 resident 真源
- [ ] HP-08 版本、能力、政策、费用与健康可观察
- [ ] HC-01 未绑定远端时私人数据不离开本地
- [ ] HC-02 跨 provider 迁移保持身份与 canonical state
- [ ] HC-03 撤权切断新旧请求和凭证消费
- [ ] HC-04 故障矩阵有确定结果且不伪报
- [ ] HC-05 provider-neutral 导出可独立恢复
- [ ] HC-06 外部信道绑定不从属于 provider session

代价：十四盏灯包含本地真实生命周期、并发撤权、故障注入、迁移与安全扫描，判卷会比普通单测慢。本批第二 provider 仍是契约测试替身，所以第一个真实云 provider 接入时必须整卷复跑，并允许回修抽象。
