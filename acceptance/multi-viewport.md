# 验收清单：多 viewport 地基（对应 [design/multi-viewport.md](../docs/design/multi-viewport.md)）

判卷先行：本清单与图纸同 PR 进仓，实现完成的标准是逐条可勾。
每条带主证据形式；标 [集成] 的由 Vitest 集成测试提供（真实宿主子进程，杀得起拉得起），标 [单测] 的由单元测试提供。

## A. 窗口层

- [x] **MV-A01 多开合法**：同一 residentId 连续 `open` 两次（同 scope），返回两个不同 windowId，各自 generation=1，两窗皆活。旧语义「重复 open 原地换代」不再存在。[集成]
- [x] **MV-A02 隐式单窗假设清零**：全局搜代码中对「一住户一活会话」的依赖点（按 residentId 单键索引会话的存储/缓存/路由），逐一改为 (residentId, windowId) 或显式拒绝。静态检查 + 集成各半。[集成]
- [x] **MV-A03 kill 幂等与归档**：`kill(windowId)` 两次返回同一结果；归档后窗只读，写入返 `WINDOW_ARCHIVED`；`kill(residentId)` 杀掉全部活窗。[集成]
- [x] **MV-A04 默认 scope 不是全局**：开窗缺省 scopeId 时落「私聊」，任何代码路径不得默认「全局」。[单测]
- [x] **MV-A05 新窗不背全史**：账内预置 50 条历史裁定后新开一扇窗，断言其 ackedSeq = 开窗时 latestSeq（baseline），开工闸不触发全史拉取；现行有效集已随启动包注入。[集成]

## B. 代际与回执

- [x] **MV-B01 回执窗级归属**：两窗并行派发，互相的迟到回执在对方窗不被误杀；同窗换代后旧代回执被丢弃。断言四象限全对。[集成]
- [x] **MV-B02 住户级无当前代际**：试图在住户级查询「当前 generation」的 API 不存在或显式报错。[单测]
- [x] **MV-B03 日志三元组**：派发、回执、丢弃事件的日志必带完整 `(residentId, windowId, generation)`；出现缺字段的日志本条变红。[集成]（2026-09-09 主笔授权勾：#135 已合 main；`tests/dispatch-logging-host.test.ts` 逐字段验三元组，干净 worktree `npm test` 过）

## C. 权威事实账与开工闸

- [x] **MV-C01 横向可见（D7 第四前置验收线）**：窗 A 开工中，裁定落账；窗 B 下一轮开工前必须可见该裁定（经拉取+回执）。[集成]
- [x] **MV-C02 拉是正确性来源**：裁定推送全部丢弃（模拟推送通道全灭），窗 B 下一轮照样经开工闸拉到裁定。结果与不丢时一致，只差延迟。[集成]（2026-08-26 勾：仓内尚无推送通道，「推送全灭」为 vacuous 成立，证据是拉取路径的集成测试；将来引入推送通道时本条必须重验）
- [x] **MV-C03 查账失败按缺处理**：账查询注入失败，窗的裁定级动作 fail-closed；普通动作放行且日志记「缺口未知」。「查不到」与「查到是零」不得编码成同一值。[集成]
- [x] **MV-C04 闸在非缺失方**：未知悉裁定的窗发起裁定级动作，拦截由账侧/必经路径执行，不依赖窗自查。[集成]（2026-09-09 主笔授权勾：#141 已合 main；`tests/turn-gate-host.test.ts` 落后窗拒收 + unknown fail-closed + 追平放行，干净 worktree `npm test` 过）
- [x] **MV-C05 回执丢失归传播机制**：回执丢失场景下窗不被记为「已知悉」也不被记为「失约」，重拉后正常 ack。[集成]
- [x] **MV-C06 序号而非时间戳**：账的新鲜度判据只有序号差值；代码中出现用时间戳做缺口判据的路径本条变红。[单测]
- [x] **MV-C07 supersede 是追加不是涂改**：解除一条承诺后，旧条目字节不变；新出现一条 `kind=supersede` 账目且自带序号；已 ack 旧条目的窗在下一轮开工前经缺口通道可见该解除；现行有效集视图不再含旧条目。[集成]

## D. 换气与交接信

- [x] **MV-D01 阈值硬闸 + 回合容差**：上下文过线后当前回合（含工具调用）跑完，随后进入 writing_letter；下一回合不被允许开始。[集成]（2026-08-28 望舒勾：阈值 10 开工配下，过线回合完整落树、下回合硬拦零写入、threshold_reached 事件带三元组、换气后新代放行；`tests/breath-host.test.ts` MV-D01 独立重跑通过）
- [x] **MV-D02 阈值只能开工时配**：窗运行中（尤其临近红线时）修改阈值的请求被拒绝，返回 `CONFIG_INVALID`；开工时配置生效。[集成]（2026-08-28 望舒勾：首回合过闸后修改被拒，0 值与陌生窗同罪，换代后重新可配且立即生效；同上重跑通过）
- [x] **MV-D03 手动入口统一**：`/new`、`/clear`、`/compact` 全部映射到同一换气状态机入口，无 compact 旁路。[单测]（2026-08-28 望舒勾：三命令同 state 同 source、阈值与手动同入口、归一化、MistDriver.say 拦截不落树；`tests/breath-trigger.test.ts` 4 条全过）
- [x] **MV-D04 信随启动包注入**：新代醒来的上下文里交接信全文已在，无需任何工具调用即可见；信不计入窗口阈值核算。[集成]（2026-08-28 望舒勾后半：口径立在 turn-gate `usageOf` 计量口契约（头注明文不含交接信，D8 补记二）；肥信（>阈值）注入后 usage 低于阈值、usage+信长 >阈值 的对照行防 vacuous，新代首回合放行；前半已于第二刀勾过）
- [x] **MV-D05 标题必填即召回锚点**：无标题的信写入被拒；时间线按标题 chunk 可召回该代细节。[集成]（2026-09-09 主笔授权勾：#142 已合 main；`tests/handover-timeline.test.ts` 缺标题/复用标题拒收 + 按 title 召回，`tests/breath-host.test.ts` 跨进程 recallLetter，干净 worktree `npm test` 过）
- [x] **MV-D06 三档标注条目级**：letter schema 校验「一条只装一档」；intent 半的条目带当刻亲笔标记（author=`residentId + generation`，即写下它的那一代；附当刻写入时间）；commitment 档条目在后续代不可标记作废（只能走正常解除流程）。[单测]
- [x] **MV-D07 猝死不自动注入**：杀死写信前的窗（模拟猝死），新代醒来上下文中无猝死窗流水；归档查询可达。[集成]（2026-08-28 望舒勾：suddenKill 后新代 context 空、usage=0、四条流水节点归档可查、新代照常开工）
- [x] **MV-D07b 猝死残骸不得阻断后续换气**：模拟一次回合中途猝死（只写入半条回合记录），随后的换气必须能正常完成。换气前的流水卫生检查须分档——**中断产生的合法残骸降为警告并记档；只有会导致下游 API 调用失败的畸形结构才硬拦**。同一份残骸不得使后续所有换气尝试连续失败。[集成]（2026-08-28 望舒勾：残骸后连续两次换气完成且不重复记档；畸形硬拦走 stage=hygiene、隔离后重试完成；生产分档探针——连续 assistant 硬拦（Claude Messages 严格交替，旦九 08-27 裁定）、连续 user 降警告放行）
- [x] **MV-D08 信长度上限**：超上限的信写入被拒，错误信息指明上限值与当前实际长度。[单测]
- [x] **MV-D09 换气失败必须外显**：换气尝试被拒绝或失败时，必须产生**对人可见的通知**，不得只落一个日志字段；失败后的下一次阈值穿越**必须重新发预告**，不得因「本周期已发过」而静默。[集成]（2026-09-09 主笔授权勾：#136 已合 main；`tests/breath-host.test.ts` 失败 notice + canonical stream 失效事件 + 再次穿越重新预告，干净 worktree `npm test` 过）
- [x] **MV-D10 换气不改窗身份**：换气前后 `windowId` 逐字不变，变的只有 `generation + 1`（图纸 §1.2）。换气前指向该窗的引用——派发回执 `(windowId, generation)`、外部绑定、时间线锚点——在换气后仍解析到同一扇窗，不得出现悬空引用。**判红样例**：换气流程中重新签发 `windowId`；或换气后旧 `windowId` 查不到该窗。[集成]（2026-09-09 主笔授权勾：#134 已合 main；`tests/breath-host.test.ts` 真换气三条——id 逐字不变、回执跨代不悬空、连续三次换气与时间线锚点，干净 worktree `npm test` 过）

## E. 线协议对齐

- [x] **MV-E01 session 映射**：`session.list/create/history` 三个端点的行为与本图纸 §5 映射表一致；webui 侧不需要感知住户级概念。[集成]
- [x] **MV-E02 文档同步**：实现合入的同一 PR 更新 docs/design/session-api.md §1.1（「将要变成什么」降为已实现语义，差距段清零）。人工勾。

## 2026-09-10 逐条复验附注（#148）

核验施工：小卷（Codex / chaodeng060-source）。本节不是独立验收署名。
上方勾选保留既有合入与主笔授权记录；截至本轮查验，#148 楼内尚未指定独立验收席，
因此不写“独立复验落章”，也不宣布 D13 解锁。

### 基线、命令和结果

- 干净起点：`origin/main = 21d3c451c6ee9ae877bdfeecb6425844e6137092`；
  测试补强提交 `453e03b`。本轮收尾读取远端 main 仍为同一 SHA，没有混入其他版本。
- 基线完整 `npm test`：539 passed / 38 todo；补强后完整重跑仍为
  539 passed / 38 todo（51 passed files / 3 skipped files，48.13 s）；31 次变异全部恢复后
  最终全量重跑同样 539 passed / 38 todo（52.92 s）。
  todo 不计通过。根 Vitest 排除了 `webui/**`，不能用这份结果替 E01 背书。
- `npm run acceptance`：六盏真绿。这是第一里程碑的六条，不是本页 28 条的自动判卷。
  `npm run lint`、`npm run typecheck` 均退出 0。
- E01 单独运行（在 `webui/`）：`corepack pnpm exec vitest run
  apps/dev-server/tests/mist-session-wire-adapter.spec.ts
  apps/dev-server/tests/mist-session-wire-host.spec.ts
  packages/host/apiproxy/tests/rpc-schemas.spec.ts`：3 files / 37 passed。
- 补建完整 webui 后，再将 `apps/dev-server/tests/mist-plugin-host-composition.spec.ts`
  和 `apps/dev-server/tests/mist-plugin.spec.ts` 加入上面同一命令：**5 files / 49 passed**
  （7.96 s）。覆盖官方插件经真实事务宿主取得 handler、HTTP 三端点可用、缺服务不发布。
  `corepack pnpm run build` 完整退出 0，包含 host/client 库与网页构建。
  初跑的 8 failed / 41 passed 不隐去：新副本缺编译产物；只 build:web 又缺 vendor lib，
  完整构建到末段还暴露 shell 找不到 pnpm。按 host → client → web 正常顺序构建、
  将 Corepack 的 pnpm shim 加入本次 shell PATH 后通过；没有用空 dist 或 mock 绕过。
- Node `v22.23.1`；根依赖按 `npm ci --ignore-scripts --no-audit --no-fund`，
  webui 按锁定的 pnpm `11.7.0` 安装。运行时输出中的绝对 checkout 路径在公开附件中
  归一成 `<repo>`；宿主无关环境清理前缀不进入项目复现命令。

[机器可读证据与逐个变异配方](evidence/multi-viewport-148-2026-09-10.json) 保存每个
M 编号的文件、原行、替换行、工作目录、实际仓库测试命令、失败断言和恢复退出码。
共 **31 次单点变异：31 次对应专项退出 1，31 次恢复后退出 0；每次专项恰有一个测试失败**。
其中 28 次改实现，3 次改宿主测试装配（M18/M24/M28，不能冒充实现内部闸门）。
为 26 个 MV 条目提供变异证据；B02 的“不存在 API”另有单测与静态核对，E02 人工核对文档。
一次变异只跑该专项，不声称其他测试在变异状态下仍绿；恢复后才跑完整回归。

复现时以附件 `baseline` 加测试补强提交为准，一次仅替换一个 `before → after`，
在指定 `cwd` 运行 `command`，检查所记失败，再原样恢复并重复同一命令。
不要把多个变异叠在一起，也不要留下变异源码用于正常测试。

### 28 条证据账

下表“通过”指本轮所列证据通过，不改写独立验收身份。PR 是实现来源；
具体命令与判红位置由 M 编号链接到同一附件，避免再造第二套判据。

| 条目 | 来源 PR | 本轮证据与结果 | 拔闸／边界 |
|---|---|---|---|
| MV-A01 | #86 | `tests/multi-viewport-host.test.ts`：同住户同 scope 两次 open，id 不同、generation 都为 1，两窗皆活；通过。 | M01 复用首窗 id，id 不等断言红。 |
| MV-A02 | #86 | 同上及 `tests/session-registry.test.ts`：杀一窗后另一窗 head、dispatch 仍可用；静态索引盘点见下；通过。 | M02 按 residentId 取首窗，回执归属断言红。 |
| MV-A03 | #86 / #88 | 同上：重复 kill 同结果、归档后 setHead/issueDispatch 均拒 `WINDOW_ARCHIVED`、归档快照不变；unit 另验 killResident 不动另一住户；通过。 | M03 归档 setHead 静默返回，拒写断言红。 |
| MV-A04 | #86；本轮补强 | `tests/session-registry.test.ts` 的 MV-A04：默认值独立断言字面 `private`，显式 scope 不变；通过。 | M04 将实现常量改 global：旧测试仍绿；修正期望来源后明确红，恢复绿。 |
| MV-A05 | #85 / #98 | `tests/turn-gate-host.test.ts` 的 MV-A05：50 条历史、baseline=ackedSeq=50、无全史 gap、初始有效集一次性交付；通过。 | M05 ackedSeq 从 0 起，baseline 断言红。 |
| MV-B01 | #86 / #88 | `tests/multi-viewport-host.test.ts`：两窗同代回执均有效，依次重开后各自旧代无效／新代有效，另一窗不被连坐；通过。 | M06 不验 generation，旧代回执断言红。 |
| MV-B02 | #86 | `tests/session-registry.test.ts` 的 MV-B02：同住户两窗同时为 generation 1、2，实例无 `currentGeneration`；公开方法和索引静态核对通过。 | 无可摘运行闸；不为“不存在 API”伪造拔闸计数。 |
| MV-B03 | #135 | `tests/dispatch-logging-host.test.ts`：issued / accepted / dropped 全部逐字段带 residentId、windowId、generation；通过。 | M07 日志 generation 缺失，三元组断言红。 |
| MV-C01 | #85 / #98；本轮补强 | `tests/turn-gate-host.test.ts` 的 C01/C02：明确 hold A 的 responder，确认仍在途后落 ruling；B 下一轮 prompt 带裁定并 ack；通过。 | M08 不注入 gap，B prompt 缺裁定而红。 |
| MV-C02 | #98 | 与 C01 共用真实宿主拉取断言；通过现有 pull 路径。 | 仓内无 push 通道，“丢全部推送”仍是原注所说的 vacuous 条件；M08 不冒充真实 push 故障试验。引入 push 后须重验。 |
| MV-C03 | #85 / #98 | `tests/turn-gate-host.test.ts` 的 MV-C03：unknown 时普通动作可过且有日志，裁定级动作拒绝；与零缺口区分；通过。 | M09 查询失败放行裁定级动作，reject 断言红。 |
| MV-C04 | #141 | `tests/turn-gate-host.test.ts` 的“闸在非缺失方”及 `tests/fact-ledger.test.ts`：账侧拒落后／unknown，追平放行；身份、代际与 system 能力不由窗自报；通过。 | M10 摘账侧 seq 闸，落后写入被收而红。 |
| MV-C05 | #85 / #98 | `tests/turn-gate-host.test.ts` 的 MV-C05：丢 ack 不推进已知序号，下一轮重拉后才 ack；通过。 | M11 提前 ack，0 变 1 而红。 |
| MV-C06 | #85 | `tests/fact-ledger.test.ts` 的 MV-C06：时钟倒行也只按 seq 判 gap；通过。 | M12 改用时间戳，已 ack 后仍残留旧条而红。 |
| MV-C07 | #85 / #98 | `tests/turn-gate-host.test.ts` 的 MV-C07：supersede 追加、旧条字节不变、下一轮见解除、currentSet 排除旧条；通过。 | M13 不排除被 supersede 的项，有效集断言红。 |
| MV-D01 | #117 | `tests/breath-host.test.ts` 的 MV-D01：过线当前回合落树、下回合零写入、threshold_reached 三元组、换代后可开工；通过。 | M14 摘阈值硬闸，下回合错误放行而红。 |
| MV-D02 | #117 | 同文件 MV-D02：开工时配置有效、回合开始后修改拒 `CONFIG_INVALID`、换代后重新可配；通过。 | M15 摘本代已开工闸，修改请求不再拒绝而红。 |
| MV-D03 | #105 / #117 | `tests/breath-trigger.test.ts`：/new、/clear、/compact 同入口及归一化，driver 不走普通 say；4 条通过。 | M16 排除 /compact，统一入口断言红。 |
| MV-D04 | #105 / #117 | `tests/breath-host.test.ts` 的 MV-D04：新代含全文肥信，usage 不含信、首回合可过；通过。 | M17 断注入使信缺失；M18 装配计量误加信使 159 不小于 20，分别红。计量口契约不是原生模型 tokenizer 实验。 |
| MV-D05 | #105 / #142 | `tests/handover-letter.test.ts`、`tests/handover-timeline.test.ts`、`tests/breath-host.test.ts`：无标题／重复标题拒绝，新进程仅按 title 召回原代细节；通过。 | M19 摘标题校验、M20 错改 title 查找，分别红。 |
| MV-D06 | #105 | `tests/handover-letter.test.ts`：条目只一档、intent 的 residentId#generation 与时间戳、承诺不能在信内作废；通过。 | M21 章缺代际、M22 放过多档、M23 放过承诺作废，分别红。 |
| MV-D07 | #117 | `tests/breath-host.test.ts` 的 MV-D07：suddenKill 后新 context 空、usage=0，旧流水可查，新代可开工；通过。 | M24 装配时误把旧流水注入新 context，空上下文断言红。这里模拟窗死亡，不声称杀了 OS 进程。 |
| MV-D07b | #117 | 同文件 MV-D07b：合法残骸降警告并记档，连续两次换气可完成；畸形硬拦／隔离后恢复，生产分档规则另验；通过。 | M25 把合法残骸升级硬拦，正常换气报 `BREATH_CYCLE_FAILED[hygiene]` 而红。 |
| MV-D08 | #105 | `tests/handover-letter.test.ts` 的 MV-D08：越界拒绝，错误含 limit 与 actual，边界可过；通过。 | M26 摘长度闸，不再有 LetterSchemaError 而红。默认是保守字符估算和可注入 measure，不冒充精确 tokenizer。 |
| MV-D09 | #136 / #138 | `tests/breath-host.test.ts`：timeline append／swap 失败均有 notice 和 host 签发 canonical event，effect 明确未生效，自动重试／需人处理分档，失败后重发预告；通过。 | M27 保留预告锁，第二次预告缺失；M28 装配断 canonical 提交，只剩 notice，分别红。与 OS-05 用同一断言来源。 |
| MV-D10 | #105 / #134 | 同文件的 MV-D10 三条：真换气 id 不变、旧代回执淘汰／新代有效、连续三次 generation 递增、时间线锚点可查；通过。 | M29 换代不传原 id，新发 id 而红。external binding 是夹具中的 Map 引用解析，不是 TG 等外部系统联调。 |
| MV-E01 | #112 / #121 | `webui/apps/dev-server/tests/mist-session-wire-{adapter,host}.spec.ts` 与 `webui/packages/host/apiproxy/tests/rpc-schemas.spec.ts`：真实 HTTP list/create/history、活／归档列表、默认 scope、拒客户端 id、住户隔离；37 条通过。加入同目录 `mist-plugin-host-composition.spec.ts`、`mist-plugin.spec.ts` 后 49 条通过。 | M30 列表漏归档窗、M31 取消住户归属检查，真实 HTTP 对应断言各红。history 端口是 fixture，不能替 #120 持久化判卷。 |
| MV-E02 | #112 / #113；本轮订正 #121 / #139 后的旧文 | `git show 0ef8925 -- docs/design/session-api.md` 可核 #112 同 PR 对齐；本轮 §1.1 映射逐项对照实现，并订正固定 mock／延期 v0.1／#84 方向未定的过期说明。 | 人工文档核对，不计为变异。 |

### 静态补证、真实缺口与未关闭边界

- A02/B02：`SessionRegistry` 的 active、archived、windowIdentity、lastGeneration 都以
  windowId 为键；`windowsOf(residentId)` 明确返数组，没有住户级当前代际 API。
  `ViewportTurnGate` 的 thresholds、turnStarted 和 generationOf 都以窗为键；
  `FactLedger` 是 resident → viewport ack 行，不是一住户一活会话。
  `MistDriver.#driverWindows` 是调用方显式拥有的单窗绑定，代码不让注册表猜“当前窗”。
  resident store、message tree、canonical stream 的住户级 Map 是持久住户数据／写入队列，
  不能为凑“清零”把它们误改成窗级。one-stream reply/workspace 路由也按 windowId 查注册表。
- 本轮发现并修复的是**验收漏洞**：A04 原来拿实现的 `PRIVATE_SCOPE` 常量作期望，
  常量错成 global 时测试仍绿。改独立字面量断言后，同一变异真实转红；业务默认值未改。
  另补真实子进程归档拒写／两窗回执四象限，以及 C01 的 A 确在途时序，不增加新产品语义。
- E02 的旧文“固定 mock、等 v0.1”被 #121 的 `webui/mist-plugin.ts` 服务注入实现推翻；
  #139 的 first-party read model／证据能力面也已落地。已据源码订正文档，仍保留
  history fixture、生产持久化和产品面验收之间的界线。
- 数字：本页确为 A=5、B=3、C=7、D=11（含 D07b）、E=2，合计 28。
  当前 H1 与 #78 **标题已经是 28**，不重复改成另一版；#78 正文仍写“25 条”，
  且 D 泳道仍只列 D01～D08，须更新为“28 条”及“D01～D10（含 D07b）”。
  本地记录不冒充 GitHub 已修改。
- 最终落章仍需 #148 楼内明确指定独立验收席，再由该席审阅本表、复跑与署名。
  本地施工、自审、CI、主笔授权勾、独立验收署名是不同事实。
