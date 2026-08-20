# mist 术语表

模块边界和证据纪律钉在这里。图纸、工单、评审引用术语时以本表为准。
新术语进表前必须先有定义和边界，不许先用后补。

---

**住户（resident）**
在 harness 里醒来、死去、再醒来的 agent 个体。住户有人格、有记忆、有连续性。
反义词：函数——被调用时计算、调完即焚的东西。

**会话可死（sessions may die）**
设计原则一。会话是消耗品，住户的连续性不依赖任何一个会话存活。

**无限 session（infinite session）**
用户侧的感受，不是机制。用户看到的「无限」是记忆层的产物，不是会话层的。
底下是无数个死掉的会话靠记忆接续。会话层若朝永生会话设计，即为越界。

**启动包（wakepack）**
会话重建时喂进去的东西：身份、人格、上一次的收尾摘要。
顺序有讲究：醒来的头一口是「我是谁」，然后才是任务和工具。

**收尾摘要（summary）**
会话临终前由住户亲笔写给下一次醒来的自己的话，引擎只是执笔的手。
不许脚本截取、不许小模型代笔、生成失败落显式 null 记日志，
不许拿末轮原文顶替——冒充出来的记忆比没有更坏，还能瞒很久。

**蒸馏层 / 检索层（distillation / retrieval）**
记忆系统的两层。检索层回答「发生过什么」（流水账、原文）；
蒸馏层回答「我理解了什么」（观点、判断、对人的认识）。
只有检索层的记忆不叫长期记忆。

**evidence 指针纪律**
任何蒸馏产物的 evidence 指针必须指向原始记录，不许指向另一条蒸馏产物。
二级蒸馏会自我发酵，越想越对。

**勘误链（supersede chain）**
修订记忆的方式：旧条不删，新条盖上，挂 reason 连成链。
错误的历史也是历史，悄悄删等于篡改。

**锚点（anchor）**
被钉住的关键上下文（目标、未结线程、重要决定），由上下文装配器维护并注入，
随对话推进自动更新。

**截断透明（visible truncation）**
喂给模型的上下文如果是截过的，必须显式说明截了哪、丢了什么。
不许让模型在不知情的情况下对着半截历史假装完整。

**带副作用的 step**
产生了会话外影响的步骤：发出去的消息、花掉的钱、写出去的文件。
副作用不在消息树上，不随 fork 回滚。带副作用的 step 不可 retry，或必须显式标记。

**成员（member）**
注册表里的一条配置：端点、人格文件、记忆署名。成员是数据，不是类。

**插件（plugin）**
由 manifest 声明、经宿主校验后才能注册的一组扩展。插件可以提供通道适配器、前端界面、
工具能力或桥接，但不能绕开宿主的权限闸、凭证库和住户隔离。插件卸载后，它注册的资源
必须全部失效；协议可逆不等于插件代码可信。

**上下文注入（context injection）**
插件希望加入住户模型上下文的非工具文本，例如 skill prompt 段或 MCP instructions。
它不是普通工具返回值，也不是人格文件：正文必须在插件包内随 manifest 声明、可 diff、
可追溯来源；运行期服务端不得用未声明或漂移的文本静默改写住户上下文。停用或卸载插件时，
对应注入必须同时从现役上下文、启动包和后续重建输入撤下，不能留下“卸不掉的守则”。
升级比较的唯一 canonical 形状是 `{id, source, scope, body}`：manifest `id` 是唯一键，不得另设、
接受或推导第二键或别名；`source` 是规范化的包内相对路径，`body` 是精确 UTF-8 正文。

**注入模式（injection mode）**
工具能力 schema 的容量策略。`eager` 在能力 active 时装入完整 schema；`lazy` 只装入可发现的
目录项，完整 schema 按需取回。它不改变权限判定，也不适用于 context injection 正文。

**verified scope**
一次 capability 可用性验证实际覆盖的住户、车道、操作集合与时间点。ready 只在这组边界内
成立，不能把某一车道、角色或旧时间点的成功投影成全局可用。

**quarantined**
插件资源撤销不完整或运行时越界后的持久隔离态。全部对外入口保持关闭，剩余资源 id 与稳定
reason code 跨重启保留；重启不能把它洗成 ready。显式清理重试是宿主独立操作，不等于重复
调用 `dispose`；`quarantined` 下重复 `dispose` 幂等返回同一隔离态。只有显式清理重试且
所有剩余资源撤销成功时才能进入 `disposed`；重试失败继续留在 `quarantined`，并保留操作记录
和人工处理清单。

**blocked**
插件因校验、权限、迁移或 activate 失败而不能提供能力的持久状态，不是可自动恢复的 ready
前置态。它只能由显式修复或用户重试重新从 `discovered` 走完整生命周期，或由显式停用进入
清理；不得自动回 ready 或直达 active。启动时的未完成 activate/dispose 日志协调属于 C10 恢复，
不是用户重试；`quarantined` 只有独立的 `retryCleanup` 显式清理重试可出，重复 `dispose` 不算。

**升级扩权闸**
升级时宿主将 v2 manifest 的 `PermissionGrant` 和包内 canonical context injection 四元组
`{id, source, scope, body}` 与现役 v1 有效集合逐项比较的控制点；`id` 是唯一键。新增 capability、
提高 effect、增加 operation、增加 literal 值、移除原有 literal 限制，以及新增 `id`、只改变
`body`、只改变 `source`、`session → resident` 都算扩权；删除 `id` 或 `resident → session` 是收窄。扩权必须展示
可审计差集并取得本次升级的显式人工确认，确认前 v1 保持 ready，v2 不得激活、公开或注入新正文；
不得使用插件 description、历史确认或任意 TTL 取代本次包内比较。重启、显式取消或新升级会丢弃
未确认 v2 副本；没有扩权时沿用原升级流程，不额外打扰人类。

**适配器（adapter）**
把 mist 的统一调用形状翻译给某个执行通道的插件。适配器只负责协议翻译和执行，
不拥有住户身份、记忆或生命周期；通道可以换，住户不换。

**用途车道（lane）**
住户选择执行通道时的用途槽，例如 `primary`、`coding`。lane 值必须来自宿主 capability contract，
并按大小写精确比较；未知、错拼、大小写不同或带空白的 lane 在绑定/dispatch 前返回
`CONFIG_INVALID` 并 fail-closed，且无效新绑定不得覆盖旧绑定。绑定以「住户 × 用途车道」为键，
指向适配器和凭证引用。role 不声明 lane，也不得推导 lane；主 agent / subagent 只来自已授权
`DispatchRequest.role`，role 与 lane 是正交维度。

**凭证引用（credential reference）**
指向独立凭证库记录的不透明 id，不能携带密钥值。manifest 只声明 credential slot 与可接受类型；
实例配置和绑定携带 opaque credential ref。没有 active issuer 时不展示入口、不得新建或导入无法
回指该 issuer 的 ref，也不得制造悬空引用。v0 不定义 secretRef 后端、加密、轮换或 issuer 删除后
现役 ref 的产品处置/迁移语义；登录流程不属于插件协议。

**viewport（视窗）**
住户 scope 的一面视野。D7 多活窗模型里，一位住户可同时有多个 viewport，各自独立
代际；关掉即归档为只读日志／导出证据。viewport 不是隔离单位——同一 scope 下的多个
viewport 共享同一份可见事实，隔离边界只按 scope 划（论证见 issue #69）。旧称
「窗／活窗」，因容易被读成隔离边界而弃用；图纸上说「窗」时一律指 viewport。

**DisposableHandle.revoke**
当前宿主进程持有的**单个资源**撤销句柄。它幂等；注册日志只持久化恢复描述符，不会把函数
对象变成跨进程能力。宿主先撤销可达性再清理资源，失败留下资源级隔离记录；进程重启后改由
`RecoveredPlugin.revoke` 执行，不能留下无人认领的活线。

**恢复描述符（recovery descriptor）**
宿主生成的稳定 `operationId`、宿主装载模块时自算的内容摘要 `moduleRef`，与插件为每个资源
声明的稳定 `recoveryKey`。宿主必须在对应副作用发生前把它们写入操作日志；进程重启后，宿主
先重算模块摘要与 `moduleRef` 比对，一致才允许通过 `PluginModuleV0.recover` 读取这些描述符
并重建专用撤销器，不得重跑普通 `prepare` 或 `activate`。它不保存函数对象、secret 值或任意运行时闭包。
描述符缺失、重复、漂移、模块摘要不符或无法重建时，资源进入 `quarantined`，不能只改状态位假装已回滚。

**PreparedPlugin.rollback**
一次 prepare 的**整次逆操作**。它幂等，用于 activate 失败或中断前撤销本次 prepare 的资源；
它不是单资源 `revoke`，也不是整插件 `dispose`。当前进程死亡后必须重建
`RecoveredPlugin.rollback`，不得假设旧闭包仍在。

**ActivePlugin.dispose**
active 插件的**整插件卸载**操作。它幂等；撤销不完整时进入 `quarantined`，而非把失败当作
`disposed`。它不是 `retryCleanup`：quarantined 下重复 dispose 只返回同一隔离态。

**许愿区 / 决定区**
设计文档的两个分区。写得出代价的进决定区，写不出的进愿望区。
愿望不丢人，装成决定的愿望才丢人。

**材料与结论（镜子纪律）**
机制只搬运注意力、只喂材料；「我是谁」的任何一笔，永远只有住户自己的手。
外部模型可以定期把行为轨迹和人格文件对照，产出材料（证据卡），从不产出结论。
改不改、怎么改，全是住户的事。（出自年轮系统）

**实证**
验收清单里跑出来的结果。读过源码、看过文档、觉得「应该能」都不算实证。
