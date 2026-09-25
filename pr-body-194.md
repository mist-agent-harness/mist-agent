## 这是什么

#194「住户运行时」首批施工（判卷先行已合，见 #200）：对话循环真正接通一窗流，`npm run acceptance:resident-runtime` **真绿 5/7** —— RT-01 / RT-02 / RT-04 / RT-06 / RT-07；RT-03（换气）与 RT-05（TUI）**明桩**进 STUBBED 名单，桩不冒充现成。

## 灯色

| 灯 | 状态 | 证据要点 |
|---|---|---|
| RT-01 对话往返 | 🟢 | 成功才落账；credential-missing / credential-invalid / channel-unavailable 机器可分、都带可操作 remedy |
| RT-02 一窗流 | 🟢 | 唯一 writer 落账；真进程硬杀重启后同一条主流只追加、同窗接代（代际递增） |
| RT-03 换气 | 🔴 明桩 | setBreathThreshold 未接线，等 D8 breathe() 换代线 |
| RT-04 通道 | 🟢 | Claude 订阅→pi-claude-bridge、其余→pi-ai；换通道不换住户、旧 2 条逐字不变（合成通道口径） |
| RT-05 TUI | 🔴 明桩 | tuiTranscript 未接线，等 pi-tui |
| RT-06 凭证 | 🟢 | credentialRef ≠ 明文；正对照（RT-06-probe-…）命中 1 处含 stream 面；蜜罐 0 泄漏 |
| RT-07 真源 | 🟢 | 一窗流/交接信/启动包定义各一份；干净树/空树/扩展根三组正对照全中 |

## 三个决策（+ 代价）

1. **写句柄走唯一开把手**：`window-host/window-history-host.ts` 新增 `openCanonicalStreamWriter`，全仓**只有一个** `new CanonicalStreamWriter` 构造点 —— WH-06 的唯一写方判据与 resident-runtime.md 理由二共享的硬不变量不动摇，#120 的判卷一行没动、6/6 全保。代价：住户运行时的写句柄要在 window-host 的组装根上拿（跨目录依赖，换「一份底座」不破）。
2. **凭证口径照安装器**（state-store）：0600 私有文件、临时写→fsync→原子 rename；扫描面（日志/一窗流/交接信/启动包）只有 `mist-cred:<id>` 引用。revoke 只翻状态不删档，让「没配过」与「配过但失效」机器可分（RT-01）。代价：密钥以文件形态住在落盘根里、靠目录权限兜底，不进系统钥匙串（等 #184 宿主身份）。
3. **显式住户号入口**：`ResidentStore.createResident(name, { residentId })` —— 判卷与安装器的号是调用方指定的事实，不能换号；与自产号同字符集校验（可作文件名）、撞号 fail-closed 拒绝覆盖。代价：撞号从发号器内部事变成调用方也会造，拒绝覆盖是防线。

## 评审意见修复（wusaki0723 复审，head 15d9678）

| 意见 | 修法 | 钉子测试 |
|---|---|---|
| 1. say() 部分落账窗口 / 重试写重复 | 幂等键由固定 turnId 派生（say-user-/say-assistant- 两份）；occurredAt 换哨兵（复用 `WINDOW_EVENT_OCCURRED_AT`）保证草稿确定性——同回合重试 = 同把手+同请求 hash，底座去重不写重；remedy 指路「带同一 turnId 重试」 | 同一 turnId 重试幂等 |
| 2. readSecret 不校验状态 | 读取边界关死：不在清单的引用、非 ready 一律不放原文（revoked 连读都读不出） | 读取边界把状态关死 |
| 3. 换凭证孤儿密钥 | 构造即清扫 `secrets/` 里清单不引用的 `*.key`；revoked 档挂清单不扫（revoke 不删档不变） | 启动清扫孤儿密钥 |
| 4. 小项 ×3 | 未知 role 的事件 fail-closed 抛错、不标 assistant；空文本 runtime 层自拦；secretScan 按户界（r-a 不串 r-ab，带正对照防假绿） | 各一条，含正/反对照 |

一处补充决策：空文本错误码归 `channel-unavailable` —— 契约的错误码枚举是判卷资产，不为单个校验加码；沿用本层 `specFailure` 把输入不合法归这码的先例（代码有注释）。

## 报一个判卷检测器的洞（不改判卷，待主笔/评审裁定）

RT-07 的「定义」检索会把 `import type { CanonicalStreamWriter }` 这种 **import 语句**误数成第二份定义。本 PR 用返回类型绕开（代码内有注释）；建议后续把检索修成只认真定义（`type X =` / `class X`），否则后来人正常写类型 import 就会踩雷。

## 验证（本机实测）

- `npx biome check .`：217 文件、exit 0；`npx tsc --noEmit`：exit 0
- `npm test`：**975 过 0 挂**（tests/resident-runtime.test.ts 16 条：通道映射、凭证 0600、落账纪律、失败机器可分、撞号防线、评审修复正/反对照）
- `npm run acceptance:resident-runtime[:strict]`：真绿 5/7（RT-03/05 明桩申报）
- `npm run acceptance:window-history`：6/6；`npm run acceptance:strict`：6/6

## 后续（不在本 PR）

RT-03 换代线（D8 breathe() + 交接信）、RT-05 pi-tui、RT-04 真实 pi 传输随通道 PR。

推进 #194。