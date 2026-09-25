@wusaki0723 四组意见全部落地，head `15d9678`（CI 🟢），逐条对位：

| 意见 | 修法 | 钉子测试 |
|---|---|---|
| 1. say() 部分落账窗口 / 重试写重复 | 幂等键由**固定 turnId** 派生（say-user-/say-assistant- 两份）；`occurredAt` 换哨兵（复用 `WINDOW_EVENT_OCCURRED_AT`）保证草稿确定性——同回合重试 = 同把手 + 同请求 hash，底座去重返回原回执，不写重复；`writer-unavailable` 的 remedy 指路「带同一个 turnId 重试」。**残余代价（明写）**：跨进程重启后代际递增会让同 turnId 重试撞 idempotency-conflict 而不是补写——fail-closed 报错、不写重复，跨重启的回合缝留给换代线的交接信记账 | 「同一 turnId 重试幂等」（含不同 turnId = 独立回合的对照） |
| 2. readSecret 不校验状态 | 读取边界关死：不在清单的引用、状态非 ready 一律不放原文——revoked 连读都读不出 | 「读取边界把状态关死」 |
| 3. 换凭证孤儿密钥 | 构造即清扫：`secrets/` 里清单不引用的 `*.key` 一律删；revoked 档挂清单**不**扫（「revoke 不删档」纪律不变） | 「启动清扫孤儿密钥」 |
| 4. 小项 ×3 | 未知 role 的事件 fail-closed 抛错、不猜不标 assistant；空文本 runtime 层自拦；secretScan 按户界匹配（r-a 不串 r-ab） | 各一条，secretScan 带正对照（同一探针在自己户里真能命中，防空绿） |

一处补充决策请评审过目：空文本错误码归了 `channel-unavailable` —— 契约的错误码枚举是判卷资产，不为单个校验加码；沿用本层 `specFailure` 把输入不合法归这码的既有先例（代码有注释）。

门禁（全部裸跑看退出码）：`biome check .` 217 文件 exit 0、`tsc --noEmit` exit 0、vitest **975 过 0 挂**（resident-runtime 单测 16 条）、`acceptance:resident-runtime[:strict]` 真绿 5/7（RT-03/05 明桩）、`acceptance:window-history` 6/6、`acceptance:strict` 6/6。