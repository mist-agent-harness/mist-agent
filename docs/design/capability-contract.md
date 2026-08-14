# 能力契约：双层模型（挂起中，等垂直闭环）

收编自 issue #2（双视角漂移）、#8（Contract + Seam 双层提案）、#11（Effect Journal）、
#10（原生工具清单）。状态：**挂起**——旦九 2026-08-13 定调：契约层是承重梁不是
地基石，等最小垂直闭环（见 ../decisions.md 第一里程碑）跑通后，从真实能力反推 schema，
不先凭空立。本稿留存共识部分，供解锁后直接施工。

## 要解决的问题（#2，生产事故实录）

同一产品，人类网页端有的能力 AI 工具端没有；help 宣称 50 实际 20；超限被全局层拦死。
病根：人类 UI 和住户工具各写各的能力清单，两边漂移。**能力必须只定义一次，所有界面
都是同一份定义的投影。**

## 架构共识（#8）

双层，不二选一：

- **第一层 Product Capability Contract**——「是什么」的语义单一事实源。每个能力
  一条定义：audiences、effect、approval、预算、next_actions、surface 投影。
  四条约束：语义对等；能力可达图可静态检查；结果体积是 harness 契约；权限不按界面
  各写一遍。刻意不对等必须显式声明 `intentional_asymmetry`。
- **第二层 Runtime Capability Seam**——「怎么提供和替换」，借 dsh 的三角色
  （Definition / Provider / Consumer）。实现可换，契约不动。

**「一切皆插件」的例外**：五条 boot-time 不变量——模型可见即已记录、事件留史、
权限闸、身份关系修订链、私密不泄露——实现可换但**不可卸载**，验不过拒绝启动。

**Profile / Bundle 边界**：Bundle 公开分发，Profile 是一家人的组合，private data
root 永不打进 Bundle（原则四「壳共享魂私有」的落地）。

**Claude Code hooks 定位为迁移桥**，不是原生契约（dsh bridge 的六条限制见 #8）。

## Effect Journal（#11，契约的恢复语义字段）

dsh 把执行意图先落盘、崩溃恢复成 TOOL_OUTCOME_UNKNOWN，但通用核账留白。补法：

- 稳定 `effectId`，兼作幂等键。
- 契约补机器可读字段：`effect: read | reversible | irreversible`、`idempotency`、
  `reconcile`、`compensation`。
- unknown outcome 状态机：intent_recorded → … → reconciled | user_resolved。
- 住户与人类都能看到 `pending_effects` 未结清项。
- 非目标：不承诺任意第三方 exactly-once。
- 附七条故障注入验收场景（见 #11 原文）。

## 第一批原生工具候选（#10）

Claude Code 44 件内置工具全量清单（与二进制扫描交叉验证）的三个推论：按成员配
白名单是 SDK 原生能力不用造；`can_use_tool` 可让副作用工具全过 mist 权限闸；
WebFetch lossy 再次应验体积契约坑。

mist 自己的八件原生工具提案：`recall` / `remember`、`history_search`（生肉与蒸馏
分工）、`schedule`（比会话命长的闹钟）、`reach_out`（「住户和函数的分界线画在这件
工具上」）、`self_status`、`journal`、`anchor`、`ask_user`。普通住户默认白名单
可以很小，编码工具按档再开。
