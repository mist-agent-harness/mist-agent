# 验收清单：一位住户，一条权威生命线

对应 [D9](../docs/decisions.md) 与 issue #84。本页是判卷初稿，只钉行为与证据，
不替实现方决定 schema、字段名或端点名；下面出现的 `eventId`、`streamSeq`、
`workRef`、`replyToEventId` 都表示已经拍板的语义把手，不锁最终拼写。

## 判卷边界

- **协议不变量**：同一住户只有一条 canonical user-visible event stream。执行 viewport
  可以产生局部流水和候选事件，但无权各自长出第二本对用户有权威的 transcript，
  也无权各自宣布主流顺序。
- **第一方交互契约**：P1-conformant 客户端可以进入仍有行动意义的工作区，但不把
  归档 viewport 排成永久聊天史。协议兼容不自动等于 P1-conformant；第三方拿到授权
  后如何画界面无法由本仓数学禁止，判卷对象是本仓能力面与第一方客户端。
- **两轴分开**：progress / blocked / result 是投递用途；尝试、拒绝、失败、已提交并
  生效，以及是否需用户动作、是否自动重试、谁是权威事件源，是另一组正交语义。
  不接受一个 `completed=true` 同时回答这些问题。
- **只判可核事实**：比较稳定 id、顺序、存储字节、能力授权、回执和真实副作用；
  不判模型措辞是否“像同一个人”。

代价：单一 writer 会成为需要明确保护的顺序瓶颈；能力面拆分会增加协议与测试矩阵；
显式消歧会多一次用户动作；有界事件会拒绝一部分方便但不可审计的自由文本。这些是
把“一条生命线”从界面愿望变成协议边界必须付的成本。

## 六盏灯

每条带主证据形式。标 [集成] 的测试真实启动宿主并可注入断线、猝死和重试；
标 [协议/客户端] 的测试同时检查能力授权与第一方 read model。

- [ ] **OS-01 两个 viewport 只长一条有序主流** [集成]：同一 resident 的 viewport A、
  B 并发产生两个合法事件；桌面与手机最终得到相同的 canonical `eventId` 集合和相同
  顺序。第三个客户端在两事件发生期间离线，重连后得到同一集合与顺序且无重复。
  测试交换 A、B 的到达次序重复运行；不要求某一 viewport 固定先赢，只要求主流 writer
  给出的顺序在所有投影一致。判卷驱动还须把主流中每个事件的不可变 payload 规范化为
  字节串或内容 hash，并让各投影带回其引用的同一份摘要；同一 `eventId` 的正文、来源与
  效果语义必须逐项等价，只有明确声明的投影层展示元数据可排除。保留相同 id/顺序却改了
  payload 仍判红。任一 viewport 的局部 transcript 都不得成为第二个权威源。

  证据：`tests/one-stream-host.test.ts` 通过真实子进程宿主交换 A/B 到达顺序，并核对 desktop、
  mobile、offline 三个投影的完整事件、顺序与 payload hash；`tests/one-stream-core.test.ts`
  保留同一 id/seq 后篡改 payload，投影校验会 fail-closed。

- [ ] **OS-02 猝死重放至多入流一次，回执不冒充生效** [集成]：对同一投递分别在
  “生成后、主流写入前”和“主流写入后、回执前”杀死宿主，再恢复并重试。最终 canonical
  stream 中该投递恰有一条；同一幂等把手换内容重试必须拒绝。未取得真实入流回执时
  不得标为 delivered；仅 delivered 不得标为 committed-effective，也不得推进对应权威
  head。日志里的 attempted / started 不能充当任何一档成功回执。

  证据：`tests/one-stream-host.test.ts` 在 generated-before-write 与
  durable-write-before-receipt 两个 checkpoint 杀死宿主后恢复重试，最终都恰一条；换内容
  重试被拒且 snapshot 字节不变，delivery receipt 也不产生 effect/head。
  `tests/one-stream-core.test.ts` 另证同进程双 writer 被拒、坏 snapshot 恢复 fail-closed。

- [ ] **OS-03 归档流水只进证据面，不长成第二条聊天史** [协议/客户端]：活工作区可从
  first-party workspace navigator 进入；关闭后其活动入口消失，canonical stream 留下
  typed closure/result card 与权威产物指针。测试夹具声明两种调用主体：默认 P1 用户主体
  （无 evidence/control 授权）和显式获授权的证据主体，不锁最终权限名。viewport 关闭后，
  对默认主体同时断言：first-party navigator 的活动项消失；用户面投影不出现可 resume、
  可追加或可导航到逐条 transcript 的永久聊天入口；直接请求归档流水被拒绝或该能力根本
  不暴露。对证据主体断言：只能沿 closure/result 的权威指针读到与该归档 viewport 绑定的
  只读流水，不能续聊或写回。`session.create` 的成功回执是工作区已存在，不是“创建了一条
  新聊天”。这四项由协议响应和 first-party read model 的结构化结果判定，不靠肉眼看 UI。

  证据：`FirstPartyResidentView` 只投影 canonical stream 与仍活着的 workspace handle，接口不含
  archive/history/resume；`WorkspaceLifecycleOwner` 先写 durable closure request，再归档窗，
  最后写 committed-effective result，两个间隙都可按同一幂等键 reconcile；closure 同时保存
  host 恢复归档所需的 scope/head 快照，因此 file-backed stream 与 SessionRegistry 一起重建后也
  能闭合第一段间隙。用户面的 `create` 只收 context 与可选 scope，不能传 windowId/headId 重开
  归档窗。`EvidenceAuthority` 只认宿主签发的对象身份，不把一段可伪造的 capability 字符串当
  授权；`EvidenceViewportReader` 还会核 closure/result 都由同一 host 签发，并逐项配对
  workRef、artifactRef、operationId、subject 与 viewport identity，不相干 result 不能压掉待恢复
  closure，viewport 自签的事件对也不能解锁历史。获授权的 reader 只能拿 canonical result
  eventId 调只读 `MessageTreeViewportHistory`；无权主体、closure intent 或裸 windowId 都不能成为
  读取入口。`tests/one-stream-workspace.test.ts` 用真实 file store、SessionRegistry、MessageTree
  分支与 canonical writer 验证两扇活窗、两处 crash recovery 以及上述三支反例；另走完
  generation 1 关闭、同窗合法重开 generation 2、closure-delivered 后宿主死亡、全量重建并
  reconcile 的链路，证明 journal replay 不会拿旧代 archive 冒充当前代。

- [ ] **OS-04 有界投递不夹带局部 transcript** [集成]：progress、blocked、result 三类
  合法 envelope 各投一次，来源 viewport、发生时刻、工作把手、权威产物指针与效果状态
  可核，三条均进入 canonical stream。随后在同类 payload 中夹带局部 transcript、消息数组
  或未声明的上下文正文，必被拒绝且主流字节不变；无类型自由文本同样不得借投递接口入流。
  来源字段只提供 provenance，不自动赋予 authority。

  证据：`BoundedWorkEventPort` 是 viewport 面唯一的三类投递口；来源窗只能提交固定
  envelope，authority source 由宿主组装时注入，不由窗自报。`tests/one-stream-host.test.ts`
  启动真实子进程，逐类投递 progress / blocked / result，并核对三条进入同一本 durable
  canonical stream；随后分别夹带 transcript、messages、context、伪造 authority source，
  以及直接提交无类型字符串，五种输入均被拒且 snapshot 字节不变。临时移除 envelope
  exact-key 闸时，专项稳定转红（非法 transcript 成为第 4 条事件）。

- [ ] **OS-05 宿主失败必须外显且明确未生效** [集成]：模拟一次由宿主执行的生命周期
  动作失败（至少覆盖换气失败）。canonical stream 必须收到宿主签发的 typed user-visible
  event，明确动作未生效；受影响 viewport 是 subject，不是 reporter。若宿主会自动重试，
  事件不得伪装成需要用户处理的 blocker；若确需用户决策，则必须明确给出所需动作。
  只有日志、没有主流事件判红。失败后的下一次阈值穿越必须重新产生预告或尝试，不得因
  上一周期发过而静默。本条的换气判据与 [MV-D09](./multi-viewport.md) 共用，不另造第二套。

  证据：`HostLifecycleFailurePort` 只接受宿主装配口给出的换气失败封套，签发
  `purpose=lifecycle` 的 canonical event；宿主是 reporter，受影响 viewport 是 subject，
  `effect.state=failed-not-effective`。自动重试与需人处理是两种封闭 handling：前者明确
  `requiresUserAction=false`，后者必须带非空 action。`tests/breath-host.test.ts` 复用
  MV-D09 的真实 `BreathCycle` 子进程夹具，分别注入时间线 append 失败与换代 reopen 失败，
  同时断言本地 notice、canonical stream 事件、自动重试／需人捞窗分档和失败后重新预告；
  只有 notice、删掉主流写入，或把需人处理压成自动重试时专项稳定转红。
  `tests/one-stream-lifecycle.test.ts` 另证需人捞窗时动作文字必填，viewport 不能自签为 host。

- [ ] **OS-06 用户回话按把手路由，歧义时不猜** [集成]：两个工作区同时产生需要回答的
  blocked 事件。带 `replyToEventId` / `workRef` 的两次回复分别到达对应工作区；只有一个
  活候选时，裸回复可以确定路由；同时存在两个候选时，裸回复必须返回显式消歧要求，两个
  工作区均不得收到该回复。按最近事件、当前焦点、viewport 创建时间或模型推测偷偷分配，
  任一种都判红。

  证据：`BlockedReplyRouter` 的候选集只来自 canonical stream 中仍需回答的 blocked event 与
  SessionRegistry 当前活代；输入面只有 `replyToEventId`、`workRef` 或裸回复，没有 recent、
  focus、createdAt、active tab 等猜测口。成功投递后，宿主把 resolved receipt 写回同一条
  canonical stream；router、port 与 stream store 从磁盘重建后仍能拒绝重复回复，同一 blocker
  的并发回复也在首次派发前串行化。若 workspace pair 已提交而 resolved receipt 尚未落盘，
  blocker event 派生的稳定投递键会在 MessageTree 自己的不可变节点中找回同一 pair；重建
  tree/service/router 后只补 resolved receipt，不再调用 responder 或追加第二对节点。即使同窗
  已继续一轮、当前 head 位于该 pair 的后继链上，恢复也只复用旧 pair 并保持新 head，不会
  回退会话；若 head 属于别的分叉则继续 fail closed。临时拔掉投递键或后继链识别时，对应
  crash-gap 回归均精准转红。`MessageTreeWorkspaceReplyDelivery` 走真实
  MessageTreeService 派发，并把签发的 generation receipt 带到 responder 返回后的同步
  tree/head commit boundary；in-flight kill 后以同一 windowId 重开时，旧代回复响亮拒绝且
  user/assistant 树与新代 head 都零写入。`tests/one-stream-reply-router.test.ts` 还同时建立两扇
  blocked 窗：裸回复零投递并返回两个把手；显式 event/work 抵达第一窗；剩唯一候选后裸回复
  抵达第二窗；陌生、冲突、失效把手与 responder 失败均不旁落另一窗。

## 变绿条件

本页合入只代表判卷程序已写清，六盏默认保持未勾。实现 PR 必须给出相应的可重复测试，
并在真实主流存储、宿主故障注入和第一方 read model 上取证；用 mock 直接返回期望对象，
或只核日志文字，不足以把灯点绿。与 #66 C2、MV-D09 已有判据重叠的地方共用断言来源，
不复制一套日后会漂移的成功语义。
