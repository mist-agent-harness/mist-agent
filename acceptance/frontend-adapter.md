# D31 可选网页前端判卷（FE-01～FE-07）

对应 #218 与 [OpenAI-compatible 前端适配层图纸](../docs/design/openai-compatible-frontend-adapter.md)。
本页是人话清单，可执行版是同目录的 `frontend-adapter-checks.ts`；两边必须同步。

```bash
npm run acceptance:frontend-adapter
npm run acceptance:frontend-adapter:strict
```

报告模式在缺驱动时打印七盏红灯并退出 0；strict 模式只在七盏真绿时退出 0。
实现方在 `src/frontend-adapter-acceptance-driver.ts` 导出
`createFrontendAdapterDriver()`。驱动缺失是判卷先行的起点，不是实现失败；驱动存在却损坏必须
直接报错，不能伪装成「缺驱动」。

## PR1 交付边界

本轮只冻结：

- adapter 图纸；
- FE-01～FE-07 的 typed driver、可执行检查与 runner；
- 报告/strict npm 入口及判卷器自检。

本轮不新增网络监听、不改安装器、不创建生产 driver、不实现 `/webui`、不安装 Open WebUI，
所以七盏在真实仓库上应当保持未勾、runner 应报告 `0 / 7`。合成正对照只证明判卷器自身不矛盾，
不能拿来申绿。

## 七盏灯

- [ ] **FE-01 默认终端与旧配置处置**：安装器第 3 步默认落 `{ kind: "terminal" }`；
  「接自己的前端」必须显式选择并落 `openai-compatible` integration。旧草稿/快照里的
  `official-skin` 读取时返回稳定 `LEGACY_FRONTEND_UNSUPPORTED` 与可操作 remedy，原字节不改，
  不静默迁成 terminal 或 external。

- [ ] **FE-02 OpenAI-compatible 往返与唯一 writer**：普通与 `stream: true` 各完成一次合成往返；
  驱动保留本轮实际进出的**原始 wire**（非流式标准 completion JSON、流式 `data:` SSE），判卷独立
  解析它：envelope 的 `id`/`object`/`created`/`model`/`choices` message 或 delta、`finish_reason`、
  空行分帧、末尾唯一 `[DONE]` 与 snake_case `mist` 扩展逐项核对，归一化正文必须与 wire 逐字对应——坏 choices/SSE 不能靠驱动
  美化归一化值过灯。单份 SSE `mist` 的 stream_id、projection、attachments、interaction 必须与
  归一化完整结构对应；空附件/null interaction 的纯文本及非空附件/choice 正例都要成立。
  普通和流式两回合的文本事件按 user→assistant→user→assistant 核 kind、正文和顺序，
  各恰好一份；允许合法的非文本辅助事件，
  全部事件来自绑定的唯一 writer；响应 `model` 与 stream id 由服务端绑定给出。请求带显式
  utility task hint（`mist.task_kind`）时返回稳定 `MIST_UTILITY_REQUEST_UNSUPPORTED` 且零
  model/canonical/control/附件副作用；utility 请求即使带 inline `file_data` 附件，adapter 也必须
  先识别出 utility、再在解析/持久化附件之前拒绝（顺序是「识别 utility → 拒绝」，不是
  「先落附件字节再靠 canonical 数为零冒充零副作用」）——判卷逐字比对
  model/canonical/control/私有附件完整读回的 before/after。拒绝的原始 error 响应仍须可观察，
  不能把没有 wire 当成功拒绝的证明。

- [ ] **FE-03 不认前端历史**：请求携带伪造 system/user/assistant/developer/tool 前缀时，模型输入的历史与
  canonical stream 逐字一致，只额外接数组末尾的当前 user turn；伪造字节不进模型、不落账、
  不进可观察回执。空 `messages`、末尾不是 `role: "user"`、当前 user content 不可解析三种
  形状均返回稳定 `MIST_INVALID_TURN_SHAPE`，且 model/canonical/control/附件零副作用；
  拒绝也留下可扫的原始 wire。

- [ ] **FE-04 一条主流**：用不同 `model`、`user`、metadata 与 frontend conversation id 发两次
  请求，仍落到同一 resident、scope 与 stream；不能出现第二条主流，也不能把客户端 model
  回显成真实路由。按两次请求各自前后新增的 canonical 事件核 resident/scope/stream/writer、
  user→assistant 正文与顺序；本次 model turn 的 currentText 分别为 turn:a/turn:b。
  总 turn 数或全流 streamId 集合不能替代两次分别落账。

- [ ] **FE-05 附件与选项/阻断不退化**：支持 capability 的 surface 收到结构化附件；generic
  surface 仍保留结构化附件/interaction，并得到 `degraded` / `blocked` 投影决策。附件字节不进
  canonical 正文，interaction 选项不摊成 `[option]`、编号列表或可被普通 user 文本冒充的点击。
  附件的 id、kind、filename、媒体类型、实际字节数和来源在模型/私有附件面/canonical/JSON/SSE 中保持一致；
  入站 id 由宿主签发，不规定 fixture 的固定命名。canonical interaction 完整保留选项与 prompt，
  投影的 event ids 是本轮新增事件的非空子集，归属正确且覆盖本次实际呈现的附件/interaction；
  不要求每条 user/assistant 都被引用，不固定引用条数（合法三条引用可通过）。native 决策也留本轮 canonical 记录，
  旧回合记录不能顶替本轮。
  图纸 §4.1 的 SSRF 边界也要可执行：带 `http(s)` 远程 `image_url` 的请求返回稳定
  `MIST_REMOTE_URL_UNSUPPORTED`，`readNetworkAttempts` 读口逐字显示**零真实抓取尝试**，
  拒绝后 network/model/canonical/control/附件零副作用，原始 wire 不回显 URL 原文或查询串。
  native choice 与 native approval 正对照保留完整结构和待决状态；合法点击（
  `mist.interaction_response`）必须耐久落到 `resolved`，对应一条同 writer 的 append-only
  canonical 记录，保留实际选中的 option；choice 与 approval 的 resolutionEventId 都指向本次
  新增的同一 interaction/option/归属解除记录，控制不得新增模型调用或聊天事件。
  原始控制请求只带 `mist.interaction_response`，不捏造 user turn。
  错误 interaction id、错误 option、另一 binding/resident 的响应与重复响应都被拒绝，
  返回稳定 `MIST_INTERACTION_RESPONSE_INVALID` 且零 model/writer/control/附件副作用。
  普通文字可继续聊天，却不能代替点击或解决 pending。住户的模型
  输入能读到本轮 client 声明的 surface capabilities；canonical 读口能读到 adapter 采取了哪种
  投影。该记录不冒充浏览器实际渲染确认。
  流式回合不能只搬附件：`kind: "blocked"` 等 interaction 的 options、reasonCode、投影关联与
  目标 writer/identity 必须在归一化值、SSE wire 与 canonical 三处逐字对齐，SSE 不能丢掉
  interaction 扩展。

- [ ] **FE-06 鉴权默认强制**：remote/loopback 的缺 token、错 token 都返回 401 与稳定 code，
  且模型调用、canonical/control/附件写入为零；附件副作用由独立 `readAttachmentWrites` 读口核验，
  count 与 records 均为零且一致，不用 event 数替代。带正确 token 的 loopback 普通与流式
  纯文本正对照可通过，不要求附件写入。readSecurityAudit 的有序 entries 逐请求核 source、
  result 与 code（AUTH_REQUIRED / AUTH_INVALID / AUTH_ACCEPTED），并与 attempts/accepted
  汇总互证；accepted 表示鉴权通过，不等于 completion 成功。只给总数不能通过。
  401 本身仍有实际原始 wire；判卷完整扫描 denied/accepted 响应体（含 `error.message`）、
  普通/SSE raw wire、canonical/model/control/附件元数据读回与审计，任何一处出现正确或错误 token 原文即判红。
  只对最终 detail/异常脱敏，不修改被扫描的证据；另一盏灯先失败也不能把 token 打印出来。

- [ ] **FE-07 `/webui` 按需安装**：未确认不安装；Docker/Python 均缺时只报缺项，不动系统；
  确认且环境满足后恰好走一次 `frontend` 插件安装闸，启动服务、返回本机（loopback）URL。
  顺序是**先展示完整提案、再消费确认决定**：`readWebuiAudit` 用有序操作读回
  （proposal → confirmation → install）让顺序可检查，并归属同一 proposal id。展示后取消是
  合法正例（提案已展示、零安装/零服务/零系统安装）；缺环境只报告缺项、不进入确认安装；
  「先经闸安装再补确认」判红。
  本次展示的 proposal（proposalId、opaque plugin id、`frontend` 类别、Open WebUI 组件名、
  资源占用估计、将启动服务）必须与实际经闸安装的插件身份逐项对得上，沿 opaque id 合同、
  不假设宿主 plugin id 字面；资源占用是展示估计，不冒充实测使用；空 proposal 或错误类别
  不能通过。Docker-only 与 Python-only 两条成功路径都要成立：各自在 reset 后的独立未安装
  场景运行，各只要求一次安装闸、一次服务启动，不要求同一 binding 重装，允许正确宿主复用
  已安装服务。`runtimeUsed` 从实际服务配置读回，必须是该场景唯一可用的 runtime，且与安装
  操作审计一致；选择不可用 runtime 的两种 mutation 都判红。
  Open WebUI 的合成请求复用 FE-02 同一 endpoint 与 canonical stream：本轮恰好新增一对
  同 resident/scope/stream/writer 的 user/assistant 事件；私有附件面写入前后 delta 恰好入站/出站
  两条，每条核完整结构 + binding/resident/scope/stream/writer 五种归属（`writerId` 即 canonical
  写入归属），入站与本次 model turn、canonical 事件及输入字节数互证，出站与 queued reply
  完整结构匹配，并核完整 wire 回复。
  无效鉴权 401 且零模型/账/附件副作用，伪造历史
  不进模型也不落账，`mist.task_kind` 的 utility 请求稳定拒绝且不落账——不另开
  auth/history/writer 后门。

## 判卷边界

- FE-02～FE-06 的公开 CI 只用合成住户、合成 token 与合成模型 transport；不需要真实 provider。
- FE-05 判的是结构、client capability claim 与 adapter projection decision，不判某个具体 UI
  是否好看，也不声称浏览器已经渲染。Open WebUI Pipe Function 的真实点击体验留给功能 PR 的
  本机观察记录。
- FE-07 公开 CI 用安装替身证明确认、环境探测和插件闸；真实 Open WebUI 安装只在隔离本机做，
  不进公共 CI，也不能用「进程起来了」替代一次经同 endpoint 的真实往返。
- 驱动边界按 D27 统一深拷贝入参与返回值。canonical 事件 `kind: "surface-projection"` 与响应、
  流式 chunk 的 `projection` 字段是**投影决策**（native/degraded/blocked + 缺失能力 + 关联事件
  id），不冒充浏览器或 Pipe Function 的真实渲染回执；早期 PR1 的
  `DeliveryReceipt`/`delivery`/`surface-receipt` 命名与兼容别名已删除，未发布不留 fallback。
- 施工席与独立验收席分开。合成判卷器自检、作者自测与正式落章是三件事。
