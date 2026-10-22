# 验收清单：住户运行时与终端入口（对应 issue #194，D28）

判卷先行：本清单全未点亮进仓，实现完成的标准是逐条可勾。
本页只钉行为与证据，不改 #194、D28 已拍板的任何判据。

可执行版在 `resident-runtime-checks.ts`，驱动契约在 `resident-runtime-driver.ts`，
RT-07 的静态审计在 `resident-runtime-write-surface.ts`；两边编号必须同步改，
**判卷以代码为准**。报告模式与严格模式分别为：

```bash
npm run acceptance:resident-runtime
npm run acceptance:resident-runtime:strict
```

## 安装快照与 runtime 的边界

RT-01 的 `provisionChannel()` 正对照直接准备 runtime 住户和凭证，不经过安装器正式
提交，不能证明 `npm run setup → npm run resident` 已接通。当前安装器提交
`current.json → snapshots/<install-id>/config.json` 与专属私有凭证；runtime 使用
`credentials/` 与 `residents/`，缺凭证时不能再把用户送回 setup 当成修复办法。

`tests/installer-run.test.ts` 用 scripted PromptPort 驱动真实 `runInstaller()` 完成正式
提交，再从相同临时数据根启动独立 CLI 进程，分两道边界验证：**第一段真实负例**——
不创建、不自签任何 candidate，CLI 以真实 residentId 启动，退出码 1、stderr 报
`resident-not-found` 及处理建议，identity registry 未被自动创建 resident、`residents/`
为空、runtime 凭证清单缺席、无流、无模型回声，安装快照与原凭证字节保持；**第二段诊断
正对照**——显式构造一个 synthetic accepted candidate 把住户推过身份闸，CLI 以 candidateId
启动才能确实到达 `credential-missing` 分支（否则只会停在 `resident-not-found`，测不到要
看的诊断），同时复核没有复制凭证、没有伪造回复、原字节仍保持。身份闸（D22 / #182）先于
凭证面成立；CLI 从 candidateId 在边界 resolve 一次，运行时只认 canonical residentId。
模型传输仅 synthetic，无真实用户数据。身份闸的 pending/rejected 两码与「不自动接受、
不造 room、不复制凭证、无流」的 CLI 回归钉在 `tests/resident-runtime.test.ts`。

`tests/resident-runtime.test.ts` 另覆盖 ready 清单引用的密钥文件缺失：返回
`credential-invalid`，给出 runtime 私有凭证修复建议，模型零调用、一窗流不写入、
清单不变；启动包、触发线和信时间线的缺住户入口同样说明 D22 入住边界。

这项交付修正诊断与证据边界，不宣称完成安装交接。完整接线需补 committed config 的
模型/provider 选择，以及 [D22 入住实现](resident-continuity.md) 的住户自认激活路径；
不能用 `provisionChannel()` 自动生成档案替代该权威。

**2026-10-13 接线（#182 setup 到聊天）**：上面两段说的是带 `--resident` 的老入口，边界
和负例都不变。新入口是不带 `--resident` 的 `npm run resident`：读当前安装快照的主通道
（第一版只接 API key），把人递的人格稿交给候选本人，请它第一行答「认」或「不认」，
答清了才建候选、按它的回答经 `attestCandidate` 落账（没答清不落账，免得一份没答的稿占住
住户号、主人换不了稿）；认了才经 `provisionChannel()` 把安装里的 key 和所选
模型配进 runtime 凭证面，再进 TUI。模型在第一次启动时选，存在 runtime 凭证面，不进安装
快照。`tests/installer-run.test.ts` 加了端到端正对照：真实 `runInstaller()` 提交后，同一
数据根先让候选答「不认」（不建住户、不复制凭证、无流），再换一份人格稿答「认」，同一次
启动落 user、assistant 各一条；密钥不进终端输出、一窗流和住户档案。合成通道的回声不是
「认」，候选在合成通道下认不了，所以公开 CI 用录制传输证明这一段；真实往返的本机记录
附在 PR 里，不进灯。原 RT 判据与未勾独立复验状态不变。

## 路线选边（#194 要求开工第一步说清楚）

**走「mist 当宿主，pi 当零件库」**，不走「在 pi 上改造、以 pi 扩展形式跑」。

理由一、D28 二的硬约束是「住户的真源归 mist……不在 pi 里另起一份副本」。走 pi
扩展那条路，这条约束变成一个**每次升级都要重新举证的义务**——RT-07 得一直盯着
pi 的会话与上下文管理有没有绕过 D8、D9（D28 代价段明写了这笔税）。走 mist 当宿主，
它是**结构上成立**的：唯一 writer 就是 `src/one-stream/writer.ts` 的
`CanonicalStreamWriter`，全仓只有一个构造点；pi 只提供模型通道与画框。

理由二、RT-02「不出现第二条会话」和 RT-07「没有第二份」的地基已经在 `src/` 里了。
`CanonicalStreamStore` 按 residentId 键、一户一个 `*.stream.json`，
`CanonicalStreamWriter` 进程内独占（第二个写句柄抛 `WriterOwnershipError`）。
`buildBootPack`、`sealLetter`、`BreathCycle.breathe()`、`turn-gate` 的触发线同样是现成的。
本单要交的是**把它们接成一个循环**，不是把它们在 pi 里重写一遍。

理由三、D25 三已经把通道拆干净了：Claude 订阅走 pi-claude-bridge，其余走 pi-ai。
两条都是外部扩展，由用户 `pi install` 装，不内置、不 fork、不 submodule。
「pi 当零件库」在通道这一层本来就是既定事实。

代价（照 AGENTS.md「每条设计决定写代价」）：pi-ai / pi-tui 版本随上游走，
升级是长期成本。（原先 `webui/` 里钉着 `pi-ai` 0.82.1、与 pi-claude-bridge 要求的
pi ≥ 0.86.1 对不齐，这一头已随 `webui/` 退役，D30。）pi 的 TUI 很简，第一版只能是能用、不好看（D28 已认）。
反过来，若评审要求改走 pi 扩展路线，RT-02 与 RT-07 的判据不动，只是把 pi 侧目录
经 `auditRoots()` 纳入检索、并补证 pi 的会话管理没绕过 D8、D9。

## 判卷边界

- **只判可核事实**：比较字节、序号、内容 hash、结构化错误与真实副作用。**不判回复的
  措辞**——「醒来还是同一个人」翻译成「启动包与一窗流逐字可读回」，不翻译成
  「聊起来像不像」。像不像是玄学，字节是证据。同一纪律延伸到交接信：**不判信的内容**，
  只判它是不是原件、格式合不合法、签名代际对不对。
- **真源归 mist**：一窗流的唯一 writer（D9）、交接信换代（D8，不做自动 compact）、
  启动包与事实账都用 `src/` 里已有的实现。RT-07 判的就是这条，两条路线同样判。
- **真实往返只在本机**：RT-01、RT-04 的模型往返走安装器已配的真实通道；公开 CI 用
  合成通道，不带任何密钥（AGENTS.md：不许引入需要密钥才能跑通的代码路径）。
  合成通道必须走完整条凭证路径，不许绕过 RT-06 的扫描面。
- **正对照先行**：每盏灯都先证明被判的行为确实有机会发生，再证明它没被偷懒糊过去。
  读不到有三种命运——真的被拒、通道根本没通、判卷没找对入口。这三种不许塌成
  同一个空集。
- **灯与灯不共享住户状态**：每盏灯用自己的 `residentId` / `windowId`，runner 另在每盏
  灯前调 `reset()`。两道一起上——「前一盏留下的状态把后一盏判红」是判卷自己造的假红，
  不是被测实现的毛病（#200 审读第 1 条）。
- **不预设实现路线**：判卷只通过驱动契约观察，不 import `src/` 实现。

代价：判卷自带蜜罐密钥走完整条凭证路径，意味着实现必须真的把凭证存进凭证面，
RT-06 才能证明「存了但没漏出」；一个干脆不落凭证的空实现反而过不了 RT-01 的正对照。
RT-05 判的是渲染输入的结构（帧、增量、状态栏字段、错误文本），不判观感——观感留给
验收席的真实观察记录，附在 PR 里，不进灯。这是「不判措辞」纪律在界面上的延伸。

## 模型输入的补充回归

`#227` 第 1/2 项沿现有输入读口：system prompt 保留身份、原交接信与固定权威说明，本代历史按原
user/assistant 角色进入私有 Pi session，动态承诺/记忆/currentFacts 放在历史之前，当前
user 仍排在历史之后。历史 assistant 使用合法 content 数组，导入 metadata/零计数只用于上游 schema，
不作为实测或本轮 usage；session 与 prompt 回合后删除。没有改一窗流、事实账和信档的口径。

Usage 定向回归覆盖终态存在/缺失/部分/显式零/非法数字、重复事件、失败/取消；真实 runtime
回调到 `logs/<residentId>.usage.jsonl` 与 `turnUsage()` 的链路、字段 allowlist、canonical
residentId 身份隔离、坏行计数/截断后的正常追加和写日志失败后的正常正文/ACK。累计只针对已记录且上游报告的字段，附覆盖数，不是 context
占用或完整账单；上游默认零可能没有真实读数，不能宣称缓存已命中或节省费用。
代价：每回合生成、删除私有 session/配置投影并追加诊断日志；日志无轮转、读取全文件且可能遗漏，正式 provider
缓存收益仍需实测。自动换气与亲笔交接信仍归第 3/4 项另单，本项不施工。

上游格式依据为 `@earendil-works/pi-coding-agent` 0.86.1 / 1.2.0 的 session v3 与 RPC；
这些 pi 包要求 Node ≥22.19，外部通道不随主仓安装。bridge 启动修复撤回，待 #232 后另件。

`tests/pi-transport.test.ts` 核 session cwd 稳定、私有配置禁压缩和 prompt 前有效策略确认，
原 settings 带 npm/git `packages` 时私有根不出现 `packages`、不复制 auth/trust/models-store，
坏/不可读 settings 在启动 pi 前给出具体错误且不调模型；`compaction_start` / `compaction_end`
使真实 runtime 失败且不落流。私有根不继承项目信任或动态模型缓存，代价见 runtime-config。
`npm run verify:pi-wire -- /path/to/pi`
驱动真实 pi 向本机假 Anthropic 端点发请求：核完整 system（含 cwd）稳定、上一轮角色/正文
是下一轮消息前缀、材料变化立即可见，以及 24 条长历史不触发摘要请求。前缀比较只剥除
`cache_control` 这种请求元数据；两轮断点的消息正文与位置保留。settings 带 `packages`
且不设 `PI_OFFLINE`，本地 npm/git 陷阱核零包管理器尝试。原 settings 逐字不变。
这项检查使用合成 key，不证明真实 provider 的 cache hit 或费用，也不代替独立验收。

`bootPack()` 诊断读口和 `say()` 的模型请求共用 runtime 装配路径：从现役存储读身份、
承诺、记忆、可选现行事实和最新交接信。无信为 `null`；信档无法解析或条目结构无法读出
时，两处均报 `letter-invalid`，模型不被调用、既有一窗流不变。

消费端回归在 `tests/resident-runtime.test.ts`：用 recording transport 捕获真正由
`say()` 发出的请求，核对手动换代、阈值自动换代、runtime 关闭后从同一目录重建、无信、
坏信和住户隔离。捕获的请求还交给现役 `renderSystemPrompt()`，检查标题、作者代际、
写信时间、三档原文；承诺必须继承、事实可核对、判断可不同意的语义由
`tests/pi-transport.test.ts` 核对。旧代原始对话不会随换代自动进入本代历史，现行事实与
本代正常历史继续保留。

```bash
npm test -- tests/resident-runtime.test.ts tests/pi-transport.test.ts
```

这些回归使用临时目录、合成凭证与本地 transport；重建覆盖的是同进程里的新 runtime
实例读盘。独立宿主进程的持久化由 RT-02 的子进程判卷另行检查，真实 provider 往返仍需
本机证据。合法三档信的消费 fixture 用现役 `sealLetter()` 与 `LetterStore` 预存原件；
当前 `composeLetterDraft()` 确定性装配草稿；commitment 从权威账 `currentSet()` 取 `ledgerSeq`
及短引用，旧字符串承诺仍 fail-closed 拒绝。上述检查证明已有信被送入模型，
不判信的内容质量，也不替代 D8「当刻亲笔」的语义核对或正式独立验收落章。

## 回合恢复补充回归

`say({ residentId, text, turnId? })` 成功返回 `value.turnId`，结构化失败返回 `error.turnId`。
省略时由 runtime 分配；同回合重试必须带原锚与原文，复用锚却换文本仍报
`turn-id-conflict`。已完成回合回放原 assistant 的 reply/model/generation/streamed，
不新调模型、不新写 user/assistant。

认证新回合先读确认存储；损坏或不可读时在模型、写流和账交付之前报 `writer-unavailable`。
文件须人工检查权限或从可靠备份恢复，不自动覆盖损坏记录。认证回合按顺序写两条正文、
立即计入 D8、消费 SessionRegistry 的真实 settlement、提交 FactLedger ACK，
最后发布耐久确认元数据。assistant 的 `ledgerDelivery` 保存原 resident/scope/window/generation、
dispatchId 与 targetSeq；`turns/<residentId>.turns.json` 只保存确认元数据和原 assistant 指针，
不复制对话或事实正文，不恢复旧 dispatch authority。原确认回执或**后续**同身份的真实交付
回执覆盖原 target，才允许成功回放。当前 latestSeq、登记 baseline 或更早的回执都不能代替它。
新增目录纳入 `secretScan()` 的按户扫描，凭证仍只落专属私有凭证面。

ACK 或确认记录写失败时保留真实正文与已经发生的 ACK，并返回 `writer-unavailable`。
晚失败不跳过到线换气；旧代回执在换代前尝试结算，错误仍如实返回。TUI 在已显示回复后附上
错误；同锚重试等待协调时也不抹掉该回复，错误不代表已取得确认。
此后同锚重试在模型调用前返回 `reconciliation-needed`，直到有合法确认依据；它不重开
已落流回复，也不尝试消费失效的旧回执。修好落盘后，同代后续正常交付可以覆盖原 target；
跨代未确认回合须宿主协调，新代 baseline 不补确认。

只有 user 腿耐久且仍是同窗同代最后一条事件时，修好 writer 后可以重新调用模型，
请求历史去掉本条 user，当前输入仅一次；去重 user 并补 assistant。后面已有同窗同代事件则
报 `reconciliation-needed`，在模型和写流前拒绝补写，不把旧 assistant 插到后来回合之后；
原模型输出尚未耐久保存，因此不能保证回复逐字相同。重启、换气或猝死后若已跨窗/跨代，
保留孤立 user，返回 `reconciliation-needed`，在模型调用前阻断，不冒写旧代。
旧 assistant 缺少 `ledgerDelivery` 时，认证装配不能重建原交付身份，明确等待协调；
无认证账的 legacy 嵌入继续按完整正文回放。新回合用 `ledgerDelivery: null` 明示创建时无认证交付，
以后启用账也不会给它补造 ACK；已有认证 target 则不能通过关闭账选项降级成成功。

代价：认证回合多一次本地原子写入与 fsync；确认记录保留各回合，数量增长，每回合整文件
读改写，不做压缩。确认文件损坏须人工处理，会使新回合停在模型调用前、已完成正文等待协调；
恢复材料须随 runtime 数据一起保留。旧认证回合缺材料不会自动迁移或重算，跨代半回合
本轮只准确阻断，不提供丢失输出的重建或宿主协调工具。

```bash
npm test -- tests/resident-turn-recovery.test.ts tests/resident-tui.test.ts tests/resident-runtime-host-boundary.test.ts
```

这些回归用临时目录与 synthetic transport，真实 `EISDIR` 落盘故障分别截断 assistant、
ACK 和确认记录；同时检查模型调用次数、原 generation/target、最终流条数、回放字节。
新增回归覆盖截断/不可读确认文件的零副作用、ACK/确认记录晚失败仍触发 D8 换代、TUI 保留
回复与可见错误、立即孤立 user 重试仅输入一次，以及隔着 B 后重试 A 拒绝且流序逐项不变。
TUI 的 ACK 故障回归从 `tui.submit()` 发出后续补账消息，再从 `/retry` 恢复原回复与原显示行；
后续普通回合成功不会清掉待恢复锚，恢复成功才清除，后来的新失败接替最近失败锚。
真实 CLI stdin 验证 `/retry` 与普通同文本提交，IPC 子进程验证返回锚、同锚回放与跨宿主
重启的 pending 状态。它们是恢复补充证据，不替代 RT 八灯、真实 provider 或独立验收落章。

## 终端命令输入回归

`tests/resident-tui.test.ts` 从真实 `src/resident-runtime/cli.ts` 子进程的 stdin 输入
`/new`、`/clear`、`/compact`，观察落盘信、代际、同一窗号与主流正文；命令不得成为聊天
回合。另注入信文件落盘失败，验证错误可见、代际未推进、拒绝后普通对话仍可进行。
`/retry` 的恢复回归也从真实 stdin 进入：连续重试保留原回合，确认记录落盘故障修好后，
后续正常交付和原回复回放只产生两次模型请求、两对正文；原错误显示行恢复原回复。
恢复后再次 `/retry` 显示无可重试回合的错误，普通同文本输入仍落独立回合。
空行、普通输入、`/exit` 与 SIGINT 的既有回归继续保留。

这些测试用临时目录和 synthetic 通道：身份先由 synthetic candidate 本人显式自认，
再经 `provisionChannel()` 配通道。不覆盖安装器正式提交到 CLI 的交接，也不证明
真实 provider 往返或 intent 当刻亲笔成立。
原 RT-03 判据与未勾独立复验状态保持不变。

## 九盏灯

每条带主证据形式。标 [集成] 的由 Vitest 集成测试或验收驱动提供（真实宿主子进程、
真实文件系统目录，杀得起拉得起，可注入故障）；标 [静态] 的由代码检索与类型检查提供。

- [ ] **RT-01 醒来** [集成]：按 `residentId` 读启动包，经安装器已配的通道完成一次真实
  对话往返；没有凭证或凭证失效时 fail-closed，给出可操作提示，不静默。
  **判过**：四件事同时成立——从未配过凭证时报 `credential-missing`、凭证失效时报
  `credential-invalid`（两种失败码机器可分，不许塌成一个）；两种情况的 `remedy` 与
  `message` 都非空（「可操作提示」的机器形式）；配好凭证后确实拿到非空回复且启动包
  `residentId` 正确、`identity` 非空（正对照）；两次失败都不往一窗流落任何带标记的
  事件——失败不许伪造回复。

- [ ] **RT-02 写流** [集成]：用户消息和住户回复都经 one-stream 唯一 writer 落账；
  关掉进程重开，同一条主流可读回，不出现第二条会话。
  **判过**：说一句落 user + assistant 各一条且顺序为 user→assistant（正对照）；
  一户的 canonical stream 落盘文件**恰好 1 个**，说两句之后仍为 1 个——这是
  「不出现第二条会话」的机器形式；硬杀进程再拉新进程（`pid` 与 `bootId` 都必须变，
  `dataDir` 不变），读回的事件数量与逐条指纹（eventId / streamSeq / kind / text /
  payloadHash）与死前逐项等价。只在单进程内存里成立的实现判红。

- [ ] **RT-03 换代** [集成]：到成员配置的触发线时，住户亲笔写交接信后换代（D8）；
  新一代读得到交接信；`/new`、`/clear`、`/compact` 都走同一流程，不存在自动 compact。
  **判过**：触发线真绑，且绑的对象分得清——开工时设得进线（正对照）；**窗**开工后再
  请求改自己的线被 fail-closed 拒绝并报 `breath-refused`（D8 明文「临近红线的窗无权给
  自己续命」）；**主人**改成员配置是允许的，但**从下一代生效**：改完当刻这一代仍按开工
  那条线换气、新一代才用上新线。跨线后代际恰好 +1；每代恰好一封信，签名是
  `` `${residentId}#${换代前那代}` ``——代际对不上即冒署；标题非空、`writtenAt` 非空、
  条目 tier 只在 commitment / fact / judgment 三档内（D8 补记三、四）；新一代启动包里
  注入的信与当刻亲笔那封是**同一封的原件**（醒来即已读，D8 补记三）。
  `/new` `/clear` `/compact` **同流程的机器形式是结构不变量**：三者各让代际 +1、各产一封
  格式合法且签名正确的信、`windowId` 不变、旧流水逐字不动。**不比不同代信的内容**——
  D8「当刻亲笔」就写着内容每代不同，比内容等于逼实现写死模板（#200 审读第 3 条）。
  不存在自动 compact 的机器形式：换代一律 +1，且旧流水逐字留底、条目只增不减
  （自动 compact 的形状是「压了正文没换代」）。另判猝死：没写信就杀，那代的原始流水
  **一条都不自动进**继任者的记忆与承诺栏（D8 三）。

- [ ] **RT-04 通道** [集成]：Claude 订阅经 pi-claude-bridge，其余经 pi-ai（D25）；
  同一住户切换模型或通道后 `residentId`、启动包和一窗流不变。
  **判过**：路由映射判死——`claudeSubscription: true` 必须落 `pi-claude-bridge`，
  其余落 `pi-ai`（D25 三「Claude 订阅是唯一特例」，接反即红）；A 通道跑通（正对照）后
  换到不同模型的 B 通道，`residentId` 逐字不变、启动包记忆集合同指纹（D25 五「身份、
  记忆和绑定不变」）、一窗流旧条目逐字不变且只追加。

- [ ] **RT-05 TUI** [集成]：只有一条会话，没有会话列表（D9、D11 四）；能看到流式回复、
  错误和当前是哪位住户、哪个模型。
  **判过**：画面确实渲染出刚敲进去的那句（正对照）；流式回复被切成 **≥ 2 个增量**，
  拼接非空且出现在末帧可见区里（「流式」的机器形式，不是一次性吐出）；每一帧的会话数
  恒为 1（没有会话列表）；状态栏 `residentId` 与 `model` 逐字等于配置（看不清现在跟谁
  说话就判红）；注入通道故障后画面出现非空错误文本——出错却为 `null` 就是静默失败。
  观感不在判卷范围，由验收席留真实观察记录。

- [ ] **RT-06 凭证** [集成 + 静态]：密钥只走环境变量或凭证引用，日志、一窗流和交接信
  里不出现明文。
  **判过**：`provisionChannel` 返回的 `credentialRef` 非空且**不等于**密钥字面量
  （引用不是明文）；正对照先行——拿一段刚落进一窗流的确定文本去扫，必须命中且命中面
  含 `stream`（否则一个恒返回空 `hits` 的扫描器也能点绿）；再拿判卷自带的蜜罐密钥去扫
  日志 / 一窗流 / 交接信 / 启动包四个面，命中数必须为 0。

- [ ] **RT-07 真源** [静态]：全局检索确认一窗流、交接信、启动包没有第二份写入路径
  （走 pi 扩展时同样适用）。
  **判过**：**按定义判，不按调用判**。三样东西各自的唯一实现在检索树里**恰好定义一次**
  ——一窗流 `CanonicalStreamWriter`（类定义，D9）、交接信 `sealLetter`（函数定义，D8）、
  启动包 `buildBootPack`（函数定义；启动包必须由存储生成，不是手写文件）。0 次判红
  （没接线，或检索根指错），> 1 次判红（长出第二份，含 pi 扩展里的同名副本）。
  三个刻意的不算：**方法门面不算**（类上叫 `buildBootPack` 的包装方法只是接线层的一格，
  不是新装配器）、**别名调用不算**（`import { buildBootPack as x }` 复用的是同一个
  装配器）、**调用次数不限**（启动包是纯读函数，醒来要调、换代后要调、各路驱动也要调）。
  检索根**永远至少包含仓内 `src/`**；走 pi 扩展那条路线时由驱动经 `auditRoots()` 追加
  扩展目录，这个方法只能加根、不能减——把第二份藏进扩展目录照样被抓。审计自身带三组
  正对照（干净夹具树报 0 findings、零定义树三面各报 missing、扩展根里那份被判 duplicated
  且点到具体文件），`tests/resident-runtime-write-surface.test.ts` 另钉住上述三个「不算」。

- [x] **RT-08 回合恢复** [集成＋跨进程]：认证回合正文已经耐久、确认记录缺失时不能
  假报成功；同锚重试与跨代孤立 user 都在模型调用前停下，不追加或改写一窗流；运行时
  生成的失败锚和成功回放锚经 IPC 原样往返。
  **判过**：先用真实落盘故障卡住 `turns/<residentId>.turns.json.tmp`，正对照必须已经
  调用一次模型并落下完整 user→assistant，返回 `writer-unavailable` 与非空 `turnId`；修好
  故障后立即同锚重试必须报 `reconciliation-needed`，模型调用计数不增，事件逐项指纹不变。
  再用后续真实交付覆盖原 target，旧锚只允许零模型调用、零正文写入的成功回放，返回的
  `TurnResult.turnId` 仍等于原锚。另把一个完整回合在宿主关闭后裁成只有耐久 user 腿，
  从同一数据根拉起新宿主并真实换代；跨代重试仍报 `reconciliation-needed`，模型计数与
  孤立 user 的逐项指纹都不变。判卷自检分别把「缺确认假绿」「拒绝前偷调模型」「拒绝仍写
  正文」「跨代重新生成」「失败丢锚」五种实现改坏，RT-08 必须逐一转红。

- [x] **RT-09 正常退出接回同一代** [集成＋跨进程]：终端正常退出（`/exit`、stdin 结束）落一笔
  「这一代暂停」，下次启动对得上就接着同一个 windowId、同一代，历史照常从一窗流读回；硬杀、
  崩溃，或暂停记录缺失、损坏、身份对不上，照旧按 D8 三猝死开新一代（#234 主笔裁定 A）。
  **判过**：六段，每段用自己的住户。
  一、退出前（正对照）：同一进程里第二句的模型请求逐条带上第一句的 user/assistant，证明历史
  观察口看得到历史；认证账追加两条事实，第二句交付后确认位确认到第一条、第二条留作缺口，
  且 baseline 落在第一条之前——不然「重新登记」与「接回原来那次激活」在确认位上长得一样。
  二、`stopHost()` 走正常关闭路径、子进程自己退出；暂停中读落盘确认位，与退出前逐项相同
  （暂停不是交付）。
  三、再启动：`pid`、`bootId` 都变；第一句仍落在退出前那一代；模型请求的历史逐条等于退出前
  那段的 4 条；一窗流旧事件指纹逐项不变、只多这一回合的 2 条；认证账确认位的窗号、代际、
  baseline 都不动，acked 经这一回合的真实交付从原位前进到账尾。
  四、硬杀：另一位从没正常退出过的住户硬杀后开新一代，归档查得到上一代，上一代原始流水一条
  都不在模型请求里；接回过一次的住户再硬杀也开新一代（暂停记录只用一次），确认位按新一代
  重登记、baseline 挪到账尾——这一步同时是确认位观察口的正对照。
  五、同一次正常退出后用 `tamperPauseRecord()` 把三位住户的记录分别弄成缺失、损坏、身份对不上：
  三位都开新一代，旧流水不进请求、归档可查、旧事件不动；同一轮里没被弄坏的对照住户照样接回
  （正对照）。
  六、`raceHosts()` 在同一数据根上起两个宿主进程（顺序起：先起的 ready 了再起第二个——同一刻
  起两个会撞上 main 上就有的认证账启动竞态，一边在 ready 前崩掉），两边都 ready 后同一时刻
  各说一句，暂停记录认领与住户锁在这一句上真撞。不可退的断言：两边都起到 ready、ready pid
  是两个不同的进程；两边的 say 都真返回（不是起不来、不是请求抛错）；输的一边只认 say 自己
  返回的结构化 `writer-unavailable`。在此之上：至少一边说成（正对照），至多一边接回暂停那代；
  两边都说成时代际不同、pid 不同。

## RT-09 的口径与边界（#234 判卷先行）

#234 改的是「换代时带走什么」和一窗流按代读回的口径，按 D32 第二条走严格路径：判卷先出、
先在现役代码上跑红，施工另在后面的提交里把灯点绿，验收席另请（主笔裁定点名 Elio）。

**现役代码红在哪**：报告模式 8/9，RT-09 红在第一条行为断言——「正常退出（stopHost）后再启动，
回合落在第 2 代，退出前是第 1 代——正常退出被当成猝死换了代（#234 裁定 A：暂停记录对得上就
接着同一代）」。它之前的正对照（第二句带上第一句、确认位随交付前进、`stopHost` 由子进程自己
退出、暂停中确认位不变）在现役代码上都过，红不是判卷自己造的。

**施工落下什么**（#234 施工，判卷文字不动）：`runtime.close()` 给每扇已完成初始交付的活窗
落一笔 `sessions/paused/<residentId>.json`（0600，tmp→fsync→rename；初始事实还没交付的窗不落，
写失败不拦关 writer）；下次启动在已知窗路径上用 rename 把记录挪成本进程专属名来认领，只此一次、
认领后不论好坏都删；`SessionRegistry.resumePaused` 对照 journal 的窗身份、末代和 scope 代际，
认证账 `resumeViewport` 对照落盘窗行的五元组重新认领、不挪 baseline；任一处对不上就照旧
猝死换代（账不认时先把接回的窗归档）。驱动 `tamperPauseRecord` 已实现，`STUBBED` 清空。
第六条的并发两宿主靠住户宿主锁 `sessions/active/<residentId>.lock` 定死（D9 一流一写方）：开窗时、
认领暂停记录之前先拿（完整内容写进独有临时文件再 link，已存在即拿不到），之后每回合开头核对
令牌（猝死前也核对）；锁在另一个活进程手里、读不出、被非文件占住或被接管，就在调模型、写流之前
以 writer-unavailable 拒绝；pid 已死或解析不了才 rename 接管；被挤掉的一边关闭时不落暂停记录；
`close()` 一开头停止认锁，关完 writer 后放。
于是两个宿主只有拿到锁的一边开窗写流，另一边由 say 返回 writer-unavailable，不再两边同时撞在
一窗流固定的 `.tmp` 上、一边都没说成（三个以上进程抢陈锁的边界见 D33）。

**驱动契约新增**（判卷仍只经契约观察，不 import `src/`）：

- `stopHost()`：宿主正常关闭，与终端 `/exit`、stdin 结束走同一条路径（现役是
  `runtime.close()`，宿主子进程的 `stop` 命令调它），驱动只等子进程自己退出，不许 SIGKILL
  冒充；限时不退或退出码非 0 即抛错。施工若把暂停挂在 `close()` 之外，宿主子进程必须同走
  那条路径，评审对照 `cli.ts` 查。
- `lastModelRequest()`：本宿主进程里这位住户最近一次 transport 实际收到的请求，只带本句与
  历史的角色、正文，不带凭证原文和启动包。只看代际排除不了「代号接上、上下文是空的」和
  「代号换了、旧流水塞进来」；读流只证明落了账，不证明进了模型。
- `appendLedgerFact()` / `ledgerAlignment()`：前者经宿主现役 `host.system()` 入一条现行
  事实，造出「账上有、窗还没确认到」；后者只读 `residents/<residentId>.facts.json` 的落盘
  确认位，宿主停着也读得到。
- `tamperPauseRecord()`：宿主停着时把一位住户的暂停记录弄成缺失、损坏或身份对不上，别的
  住户不动。现役代码没有暂停记录，驱动把它申报为明桩（见下「真灯与桩灯」）；判卷在走到它
  之前就已判红。施工落下暂停记录时一并实现并从 `STUBBED` 划掉。
- `raceHosts()`：驱动自己的宿主停着时，在同一数据根上先 spawn 一个宿主进程等它 ready，再
  spawn 第二个等它 ready，然后同一时刻各说一句，说完话的正常关闭、没起来或请求抛错的杀掉。
  每一边走到哪一步照实报在 `ContendedTurn.stage` 上（`said` / `not-ready` / `request-failed`，
  带 spawn pid 与 ready pid）：起不来、请求抛错都不许折成 say 的结果。顺序起是因为认证账
  启动时用固定的 `<residentId>.facts.json.tmp` 重写全部账档，同一刻起两个宿主时一边会在
  ready 前因 rename ENOENT 退出——那是 main 上就有的启动竞态，不是本灯要验的东西；暂停记录
  认领与住户锁都在第一句 say 上，仍被同时发出的两句真撞。

**第 5 条为什么判 baseline**：认证账的 `registerViewport` 认「已登记」靠进程内存（重启后
从盘上恢复的窗行不算已登记）。接回后若按同一身份再登记一次，账会新起一行：baseline 挪到
那一刻的 latestSeq、acked 抬平到 latestSeq、初始事实重新冻结——暂停前没交付的缺口被吞掉，
已交付的事实又当成新一轮初始交付。模型请求里的现行事实每回合都从 `currentSet()` 现取，
一窗流也不记交付位，所以这件事只在落盘确认位上留痕。判卷的机器形式是：窗号、代际、
baseline 不动，acked 只经真实交付前进。施工须知：`src/store/fact-ledger.ts` 恢复路径的
注释写着 PR #98 拍板「初始快照不落盘、旧 active 窗不续接」，接回同一代要动这条口径，
归施工与主笔，不归本灯。

**第 4 条判真并发**：驱动起第二个宿主进程不需要大改（拆出一个按子进程收发的函数即可），
所以判真并发，不只判顺序的「只用一次」（顺序那一面在第四段另判）。两进程同时构造
runtime、同时开窗，能稳定抓住两类错：两边都按启动时的盘面认领暂停记录（都接回），以及
两边都按启动时的窗账各开同一个新代（现役形状）。认领本身不原子（先读后删）只有时序撞上
才现形，判卷不保证抓到，这一面靠评审看认领是不是原子的（`O_EXCL`、`rename` 之类）。
两个宿主各开一代、同写一份一窗流文件是 D9 唯一 writer 的跨进程互斥，本灯只判代际，不判
那一面（读源码：`CanonicalStreamWriter` 只在进程内独占，一窗流文件按整份读改写，没有跨进程锁）。

**不替施工选的**：`stopHost` / `killHost` 管整个宿主进程，里面的住户一起暂停或一起猝死；
暂停的窗是启动时一并接回还是第一句时才接回，由施工定。所以「暂停中、还没接回」的住户
都不跨一次硬杀再被判。

代价：RT-09 一盏要起 6 个宿主进程，runner 多几秒；确认位读的是认证账的落盘格式，
施工改格式要连驱动一起改；历史按「逐条等于本代一窗流」判，施工若想往接回后的请求里另加
提示（比如「刚恢复」），得先改判卷、过验收席；真并发对不原子的认领只是概率性的抓。

判卷自检在 `tests/resident-runtime-checks.test.ts`：合规合成驱动点绿一例，另把十九种实现
改坏、每种都要红在对应那条断言上——正常退出也开新代（现役）、硬杀照接、坏记录照接、记录
用两次、接回后重写旧流水、接回后请求不带上一段、接回时账重新登记、接回换了窗号、暂停时
吞掉缺口、硬杀后旧流水进请求、两宿主都接回、弄坏记录时抹了归档、历史观察口恒空、确认位
观察口冻住，以及并发段把 ready 前崩溃折成锁拒绝、宿主未 ready、请求抛错、两边复用同一
pid、输方返回别的错误码。

## 判据修订记录

| 日期 | 改了什么 | 依据 |
|---|---|---|
| 2026-09-24 | runner 每盏灯前调 `reset()`；每盏灯用自己的 `residentId` / `windowId` | [#200 审读第 1 条](https://github.com/mist-agent-harness/mist-agent/pull/200)：七盏共用一个住户，正确实现会被判红 |
| 2026-09-24 | RT-07 从「数调用点」改成「数定义」，显式排除方法门面、别名调用与调用次数 | 同上第 2 条：方法声明被数成调用点（假红），别名调用看不见（假绿）；且启动包是纯读函数，按调用次数判唯一做完必然假红 |
| 2026-09-24 | RT-03 不再比不同代交接信的内容，改成比结构不变量 | 同上第 3 条：比内容等于逼实现写死模板，与 D8「当刻亲笔」和本页「不判措辞」冲突 |
| 2026-09-24 | RT-03 区分窗 / 主人两种改线权限，主人的改动从下一代生效 | 同上建议第 3 条：原判据比 D8 更严，连主人改配置一起禁了 |
| 2026-09-24 | RT-03 代际按 1 起点算（开工第 1 代、首封信签名 `#1`、换代增量 1→2→…） | [#200 技术门（复审 ca2ec60）第 1 条](https://github.com/mist-agent-harness/mist-agent/pull/200)：原判据写死 0 起点，与现役 `SessionRegistry.open`（第一代 (last ?? 0)+1）、journal 拒 `generation<1`、`formatAuthor` 的 1 起点冲突，接真实栈的正确实现被判红 |
| 2026-09-24 | RT-03 把「窗无权改自己的线」的拒绝断言移到第一句 say **之后**（回合已起才锁） | 同上第 2 条：现役 turn-gate 的锁在 `beforeTurn` 之后才合上（MV-D02：开工 configure 成功、先 say、再改才 CONFIG_INVALID）；放在起回合前会把「开工阶段窗还能配线」的正确实现判红 |
| 2026-09-24 | RT-03 猝死单判加：猝死前标记确已入流（正对照）+ 继任者代际必须更高（真换代）+ 归档按代可查（D8 三正面）；驱动契约新增只读 `archivedTranscript` | 同上第 3 条：原判据只查「启动包里没有标记」，空的 `suddenDeath` 也能点绿，且没验 D8 三「原始流水进归档可查」，允许丢史 |
| 2026-10-17 | 新增 RT-08：确认缺失、同锚重试、跨代孤立 user、模型零调用、正文零新增与 IPC 锚往返合成一盏恢复灯 | [#223 D32 主笔裁定](https://github.com/mist-agent-harness/mist-agent/pull/223#issuecomment-6214284808)：恢复语义动一窗流与事实账，施工方单测不能替代可执行判卷与独立验收席 |
| 2026-10-17 | 新增 RT-09：正常退出接回同一代，硬杀与坏暂停记录照旧猝死，暂停记录只用一次，两进程不拿同一代，认证账确认位不重登记；驱动契约新增 `stopHost`、`lastModelRequest`、`appendLedgerFact`、`ledgerAlignment`、`tamperPauseRecord`、`raceHosts` | [#234](https://github.com/mist-agent-harness/mist-agent/issues/234) 主笔裁定 A（2026-10-17）：动换代时带走什么与一窗流按代读回的口径，D32 第二条严格路径，判卷先行 |
| 2026-10-18 | RT-09 第六条改判：两宿主顺序起、都 ready 后同时说；两边都起到 ready 且 pid 不同、两边 say 都真返回、输的一边只认 say 返回的 writer-unavailable，全部不可退；`ContendedTurn` 加 `stage` / `readyPid` / `failure`，`result` 只在 `said` 时有 | [PR #235](https://github.com/mist-agent-harness/mist-agent/pull/235) 验收席 Elio（zaymb）P1-1：同时起两宿主时一边在 ready 前因认证账固定 `.tmp` 的 rename ENOENT 退出，夹具把它折成 writer-unavailable，「至少一边成功」照样点绿，失败方根本没走到住户锁——假绿 |

## 2026-10-17 D32 独立验收落章（#223）

- 被验实现：PR #223 的施工方 head `8b9af1ea22a70e20e2e89bf2209e0e36b9e33431`。
- 独立验收席：Elio（`zaymb`）。本席没有参与 #223 的运行时实现；本轮只补 RT-08 判卷、
  判卷反对照、驱动观察口与收卷清理。
- 驱动契约背书：`reconciliation-needed` 保留「正文已耐久但交付真实性待协调」这一种可机分
  状态，不能塌成通道失败或重新生成；`TuiStep.retry` 把复用旧锚的动作与普通同文本新回合
  分开；`TurnResult.turnId` 必填让成功回放也能原样交还幂等锚。三项都由 RT-08 的真实 IPC
  往返、模型调用计数和一窗流指纹共同约束，不只靠类型声明。
- 负例：同一份 RT-08 判卷套到 PR 基线 main `8cc44dde37dc501436dd16c00cdad30080cf8afa`，
  严格运行得到 7/8；RT-08 红在「确认记录写失败却返回成功——缺确认假绿」。
- 正例：PR head 上 `npm run acceptance:resident-runtime:strict` 为 8/8；判卷自身 43/43，
  恢复相关四文件 84/84，完整套件 1603 passed / 38 todo；lint 与 typecheck 通过。
- 边界：本席落章只覆盖 #223 的 D32 回合恢复增补与上述三项驱动契约，不改写 RT-01～RT-07
  原有未勾状态，也不声称真实 provider 或断电验证已经发生。

**Elio / zaymb，D32 独立验收席，2026-10-17。**

## 2026-10-18 D32 独立验收落章（#235）

- 被验实现：PR #235 的施工方 head `ad7f5694e15dd5a68a4139e26f1c6dec8c565a03`。
- 独立验收席：Elio（`zaymb`）。本席没有参与 #235 的运行时实现；先在
  `bf78d7ccd4ad1dbaf93f6b2ab6bd958d2767db1b` 抓出 RT-09 并发段假绿与 macOS 符号链接
  放回失真，施工方修补后按新 head 独立复验。
- 负例：判卷先行提交 `6f6c8a388928e34bee4f36a0ed411b12510eb728` 独立严格运行得到
  8/9，RT-09 红在正常退出后从第 1 代跳到第 2 代。并发判卷另有五个故障合成驱动，分别把
  ready 前崩溃折成锁拒绝、宿主未 ready、请求抛错、两边复用同一 pid、非
  `writer-unavailable` 拒绝逐一判红。
- 正例：macOS 上 `npm run acceptance:resident-runtime:strict` 连跑五次均为 9/9，两个宿主
  的两种胜负顺序都出现；锁接管、真实双宿主边界与判卷自检三个文件 81/81；完整套件
  1717 passed / 38 todo；lint、typecheck 与 GitHub CI 通过。
- 驱动契约背书：`ContendedTurn.stage` / `readyPid` / `failure` 把宿主生命周期与 `say`
  返回分开；`result` 只在 `said` 阶段存在。RT-09 第六段因此只接受两个不同进程都 ready、
  两边 `say` 都真返回且输方由 `say` 返回 `writer-unavailable` 的证据，启动崩溃与 IPC 失败
  不再冒充住户锁拒绝。
- 边界：本席落章覆盖 #235 的 D33 正常退出接回、暂停记录一次性认领、住户级进程锁、认证账
  确认位接回和 RT-09 驱动契约。认证账启动时固定 `.tmp` 的既有跨宿主竞态仍按 D33 代价行
  保留，本单只保证两个宿主都 ready 后的第一句真并发。

**Elio / zaymb，D32 独立验收席，2026-10-18。**

## 真灯与桩灯

驱动模块可以导出 `STUBBED: string[]` 申报哪些方法还是代写的判卷桩。runner 拿每条验收
的 `uses` 清单对照申报名单：依赖桩方法跑绿的灯显示 🟡 桩灯——行为通过，但不计入完成。
只有九盏**真绿**才算 RT-01～RT-09 全部交付。各包交付时从名单里划掉自己那几个方法，
桩灯就地转真。隐瞒申报按伪证论，评审在 PR 里对照 TODO 标记查这份名单。
现役申报为空：`tamperPauseRecord`（RT-09 暂停记录故障夹具）已由 #234 施工随暂停记录一起
实现并划掉，RT-09 按真绿计。

出处归结构（照 `acceptance/README.md` 三条边界第 2 条）：真实现必须住在 `src/` 自己的
模块目录里，`src/resident-runtime-acceptance-driver.ts` 只准 import 和接线；在总装文件里
内联写的实现，一律按桩论，不论申报什么。

判卷自身也要被判：`tests/resident-runtime-write-surface.test.ts` 钉 RT-07 的审计，
`tests/resident-runtime-checks.test.ts` 用合成驱动 + 改坏对照钉九盏灯本身——证明
合规实现能点绿、每条判据被破坏时确实变红。**判卷没被测过，等于判卷没被验过。**

## 完成条件

- [ ] 从公开驱动运行本单主验收，逐条留下证据。
- [ ] 相关实现 PR 通过仓库要求的 lint、typecheck、测试与合入审查；根套件绿不替代本验收。
- [ ] 独立验收席核对上述编号（施工席与验收席分两个人，验收席没参与施工）；
      RT-05 另附真实界面观察记录。
