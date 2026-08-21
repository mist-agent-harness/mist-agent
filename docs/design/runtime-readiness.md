# 运行态就绪验证（#101）

本图纸只管 **runtime readiness / readback**，不新增 capability registry、调度器或持久化后端。
能力协议 v0 的生命周期、`verifiedScope` 和 `CAPABILITY_UNVERIFIED` 口径以
[plugin-protocol-v0.md](plugin-protocol-v0.md) 为基线；本图纸补足它留给后续实现的独立运行证据。

## 边界

五类事实各有唯一责任人，不能用一种事实替另一种事实背书：

| 事实 | 回答的问题 | 运行态验证能否改它 |
|---|---|---|
| definition | 这是什么能力、哪个版本、哪个稳定 id | 不能 |
| binding | 当前宿主/网络路径指向哪个实现 | 不能；只核对是否与目标一致 |
| authorization | 哪个 resident、lane、operation 获准调用 | 不能；只核对覆盖关系 |
| readiness | 这条 scope 的真实运行路径现在是否可用 | 只能产生带 scope/time/version 的收据 |
| telemetry | 调用次数、延迟、失败率等观察读数 | 不能单独改变上述任何状态 |
| projection | 启动包、目录或 UI 此刻展示什么 | 不能成为 readiness 证据 |

`definition present + binding missing` 是诚实的 `readiness=unknown`，不是 active/ready。
`enabled`、文件存在、导入成功、进程自报健康都不能越过运行态读回。

## v0 contract

`ReadinessScope` 至少绑定：

```text
residentId, lane, operations, host, networkPath, version, lastVerifiedAt
```

`ReadinessReceipt` 还保存 definition、binding、authorization、证据清单和稳定 reason code。
`verifiedScope` 与 `lastVerifiedAt` 始终成对出现；没有成功验证时 timestamp 为 null，状态明确为
`unknown`，不能把空对象当作空 scope。

独立证据分三腿，三腿都需要才可为 `ready`：

1. `existence`：从被测物外部确认目标存在；它不能证明进程运行。
2. `running`：从外部确认运行态确实存活；它不能证明住户路径可达。
3. `readback`：从目标运行路径取回真实操作的确定性结果（initialize、版本查询或无副作用探针）。

证据必须来自 `external` probe，并逐条绑定 scope、runtime version、moduleRef、observedAt 和
conditions。量化 measurements 只能跟在同一证据行，不得脱离条件单独投影。

## 状态与失败语义

| 观察 | 结果 | reason code |
|---|---|---|
| 三腿独立证据通过，scope/版本/条件完全相等 | `ready` | — |
| 仅 definition 存在、缺 binding/证据/运行读回 | `unknown` | `CAPABILITY_UNVERIFIED` |
| 自报证据、scope/host/network/lane/operation/version 不匹配 | `unknown` | `CAPABILITY_UNVERIFIED` |
| 证据过期或条件不一致 | `unknown` | `CAPABILITY_UNVERIFIED` |
| existence 或 running 明确失败 | `blocked` | `PLUGIN_RUNTIME_FAILED` |
| 真实 readback 失败，操作子集仍通过 | `degraded` | `PLUGIN_RUNTIME_FAILED` |
| 真实 readback 对请求操作均失败（即便 health=200） | `blocked` | `PLUGIN_RUNTIME_FAILED` |
| authorization 不覆盖请求 scope | `blocked` | `PERMISSION_DENIED` |

任何非 `ready` 结果都不得进入 ready 工具集。`quarantined` 仍由 #97 资源撤销语义负责，投影时
保持 fail-closed；readiness receipt 不会让它重新变绿。

## 与 #97 的接线

`PluginAuthorityRecord.verifiedScope` 继续是 #97 的边界字段；运行态收据作为可选同代 receipt
持久化。未提供收据的 active lifecycle 只能通过 host readiness projection 得到 `unknown`。
停用、回滚、恢复隔离会删除旧收据，避免把上一代成功投影到当前运行态。#101 不引入新的
canonical registry，也不把 receipt 当作 binding/authorization 的第二真相源。

## 可判卷矩阵

自动化验收位于 `tests/plugin-runtime-readiness.test.ts`，PV0 F 系列在
`tests/pv0/pv0-f-readiness-semantics.test.ts` 保持映射：

- 文件/定义存在但从未运行：缺 `running/readback` → `unknown`；
- health 绿但真实路径不可达：readback fail → `blocked`，不被 health 覆盖；
- 仓库、部署、运行时版本或 moduleRef 不一致：scope mismatch → `unknown`；
- host/network/lane/operation/resident 不匹配：scope mismatch → `unknown`；
- 自报、过期、条件漂移或探针不可回答：证据不足 → `unknown`；
- 三腿外部证据、授权和 scope 全部一致：才生成 `lastVerifiedAt` 并返回 `ready`。

### 代价

真实路径读回会增加验证延迟、探针维护和故障可见性成本；某些能力无法被无副作用探测时，
会更常停在 `unknown`，但这是避免假 ready 的诚实代价。收据是时间和 scope 的快照，过期后
必须重新验证，不能用 telemetry 或 projection 续命。
