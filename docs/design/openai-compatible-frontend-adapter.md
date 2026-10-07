# OpenAI-compatible 前端适配层（D31）

状态：**图纸候选，先供主笔评审；功能驱动尚未落地，FE-01～FE-07 应保持全红。**

本候选新增的观测面（远程 URL 网络尝试审计、流式 interaction、`/webui` 提案↔实装关联、
私有附件写入 delta、逐请求鉴权 entries）也只是**判卷图纸**：合成 fixture 正例只证明判卷器能识别正确形状，
不代表生产 adapter 已实现，也不替代真实宿主与独立验收席。

关联：D31 / #218；D9 一窗流；D11 第二、三、四条；#49 鉴权；D30 删除旧 DSH webui。

## 0. 一句话

mist 开一个 OpenAI-compatible 的对话口子，但只借它的请求/响应外壳：住户、scope、历史、
主流、附件与阻断状态仍由 mist 掌权。前端传来的 `model`、会话列表和重放历史都不能反客为主。

## 1. 权威边界

一份 adapter binding 在宿主侧固定绑定：

```text
Bearer token ref
  → residentId
  → scopeId
  → canonical streamId
  → server-owned model route
```

客户端不能用下面任何字段改变这条绑定：

- `model`
- `user`
- 前端自己的 conversation/chat/session id
- `metadata`
- 请求中较早的 `system` / `developer` / `assistant` / `tool` / `user` messages

这些字段可以为兼容而出现，但不拥有身份、scope、模型路由或历史权威。服务端响应里的 `model`
也必须回 server-owned route，不能照抄客户端输入制造「真的切了模型」的假象。

**代价**：Open WebUI 等前端仍会显示自己的会话列表和 model selector，但它们只是本地界面状态。
同一 token 下开多少个前端会话，都落到同一位住户、同一 scope、同一条主流；界面和底层语义
会有意不完全一致。

## 2. 兼容端点

### `POST /v1/chat/completions`

这是 FE-02 的必需对话口子。鉴权之后先区分普通聊天、显式 utility task 与 interaction response。
普通聊天请求可带完整 `messages`，但 adapter 只消费**数组最后一项、且该项必须是
`role: "user"`**，作为本次新 turn。最后一项不是 user、messages 为空、或当前 user content
无法解析时，返回 OpenAI 风格错误包，code 为 `MIST_INVALID_TURN_SHAPE`。
utility task 与 interaction response 都不能借这个形状被自动解释成一条新用户话语。

最后一项之前的所有 messages：

- 不进模型；
- 不进 canonical stream；
- 不进日志、诊断导出或失败回执正文；
- 不用于判断「前面聊过什么」。

模型上下文由 canonical stream 现读现装，再接本次新 turn。adapter 不做客户端历史与主流的
「智能合并」，也不因它们看起来一致就放行。

**代价**：部分前端习惯靠重放 history 接无状态模型；在 mist 这里，这些字节会被刻意丢弃。
前端里删除、编辑或 fork 某条旧消息也不会改写住户历史。

### `GET /v1/models`

在禁用本节下述后台任务后，OpenAI-compatible client 可不经 Pipe Function 直接接 FE-02；
为减少手填 model id，功能实现宜提供
同一 Bearer 闸后的 model discovery。它最多暴露当前 binding 的一个 server-owned model id，不能
列出住户名、scope、provider 凭证或其他 binding。请求里的 `model` 仍不取得路由权。

这不是第八盏灯：Open WebUI 可以通过 allowlist 或 Pipe Function 指定 model id，现有 FE-02 也不以
`/v1/models` 是否存在申绿。若主笔决定把 discovery 升成必需面，应在写功能前把它加进 FE-02
驱动，而不是实现后补测试。

### 前端后台任务不进主流

Open WebUI 默认把标题、tags、follow-up 等后台任务交给当前聊天模型；标题请求本身也是一个
`role: "user"` completion。只丢弃前缀 history 不能识别它，切换请求里的 `model` 也不能隔离它：
同一 binding 的 server-owned route 不随客户端字段改变。

本候选不提供第二条 utility 模型路由。接入要同时守住两个边界：

- `/webui` 安装配置禁用会发往 Mist 的标题、tags、follow-up、autocomplete、检索/搜索 query
  rewriting、image prompt 与前端 context compaction 等后台调用；Pipe 对 `__task__` 标识的
  非聊天请求直接返回 `MIST_UTILITY_REQUEST_UNSUPPORTED`，不转发给住户。
- 通用客户端也须禁用这些调用，或显式配置一个独立 provider 承担它们。不能只在同一个 Mist
  endpoint 下换 task model 名字。adapter 收到显式 utility task hint 时先识别出它是 utility，
  再在解析/持久化任何附件之前拒绝：不读主流、不调模型、不写 canonical event，也不先落附件字节。
  顺序是「识别 utility → 拒绝」，不是「先把附件写进私有面、再靠 canonical 数为零冒充零副作用」。

task hint 是客户端声明，只能使请求被拒绝，不能授予身份、scope、模型路由或运行权限。
线协议使用 `mist.task_kind`（driver 归一化为 `taskKind`）；非空字符串表示 utility task，
例如 `"title_generation"`。缺失或空串不作 utility 声明。它不是 OpenAI 标准字段。
未声明的普通 user 请求与未标记的 utility prompt 无法可靠区分；adapter 不靠 prompt 关键词猜。
因此，正确的前端配置是 generic 接入的前提，不把它包装成服务端已经证明的用户意图。

```mermaid
flowchart LR
  W[Open WebUI] --> P{Pipe 请求类别}
  P -->|非聊天 task| X[显式拒绝：零住户调用 / 零主流写入]
  P -->|聊天或交互响应| A[同一 adapter / Bearer 闸]
  G[通用前端：禁用后台任务] --> A
  A -->|显式 utility hint| X
  A -->|聊天| R[canonical history / 住户回合]
  A -->|交互响应| I[核验待决 interaction / 控制状态]
  R --> C[唯一 canonical writer]
  I --> C
```

**代价**：接 Mist 的 Open WebUI 默认没有模型自动起标题、标签和 follow-up；想保留这些体验，
用户要另配独立 provider。没有 task hint 的通用客户端不能由服务端自动排除后台 prompt。
这项限制必须进入对接说明，不能等主流被污染后再提醒。

## 3. 普通消息

普通 user turn 使用标准形状：

```json
{
  "model": "任意兼容占位值",
  "messages": [
    { "role": "user", "content": "今天发生了什么？" }
  ],
  "stream": false
}
```

普通回复保持 Chat Completions 可读形状；FE-02 同时冻结非流式与 SSE 流式投影。两种投影都必须
来自同一回合结果：流式 chunks 拼回的正文与非流式完整正文一致，canonical writer 只落一次
user event 与一次 assistant event，不能一边 streaming 一边重复写账。

响应的 mist 扩展只加信息，不改普通 OpenAI 客户端需要的主干字段：

```json
{
  "id": "chatcmpl_mist_...",
  "object": "chat.completion",
  "created": 1791061200,
  "model": "mist:<server-route>",
  "choices": [{
    "index": 0,
    "message": { "role": "assistant", "content": "..." },
    "finish_reason": "stop"
  }],
  "mist": {
    "stream_id": "...",
    "attachments": [],
    "interaction": null,
    "projection": {
      "status": "native",
      "missing_capabilities": [],
      "canonical_event_ids": ["..."]
    }
  }
}
```

未知扩展字段会被普通客户端忽略；Open WebUI Pipe Function 可以读取完整 `mist` 段。

SSE 使用 `data: <JSON>` 帧；数据对象为 `chat.completion.chunk`，共享同一 id 与 server-owned
model，经 `choices[0].delta` 发出 assistant role 和 content，结束帧给 `finish_reason: "stop"`，
最后恰好一个 `data: [DONE]`。流中也要保留附件、interaction 与 projection 扩展，不能只让
非流式路径拥有结构。公开 CI 可以用合成 transport 返回原始字节；判卷先核原始 JSON/SSE，
再比其正文与结构化扩展是否和归一化观察值一致，不能让 driver 用私有形状替换损坏的 wire。

**代价**：driver 多一个原始 transport 观察面，fixture 也必须产出真实协议形状；代价换来的是
判卷能够拒绝“内部往返成功、普通前端却读不懂”的 serializer。

## 4. 附件

### 4.1 入站

当前 user message 的 `content` 可以是 content-part 数组：

- `{ "type": "text", "text": "..." }`
- `{ "type": "file", "file": { "filename", "file_data" | "file_id" } }`
- `{ "type": "image_url", "image_url": { "url" } }`

v0 只允许两种字节来源：

1. inline data（经大小、媒体类型与内容校验后写入私有附件面）；
2. 宿主签发的 opaque attachment ref。

任意 `http://` / `https://` URL 不由 adapter 代抓，避免把 OpenAI-compatible 入口变成 SSRF 下载器。
远程 URL 如以后要支持，另立凭证、网络政策和真实回执，不在这张图纸里暗开。
判卷用一个非真实网络的 remote URL 反例核这条边界：带远程 `image_url` 的请求返回稳定
`MIST_REMOTE_URL_UNSUPPORTED`，`readNetworkAttempts` 读口显示**零真实 transport 抓取尝试**
（不是驱动自声明「我没抓」），拒绝后 network/model/canonical/control/附件零副作用，原始 wire
不回显 URL 原文或查询串。该读口只暴露 host/scheme/reason code/归属等 opaque 元数据，不带 URL
查询串、token 或响应字节；只要实现真的发起过抓取尝试，读口就必须如实登记，判卷据此判红。

模型与 canonical stream 只拿结构化附件引用；base64、浏览器 object URL、前端本地路径和 provider
URL 不落消息正文。

### 4.2 出站

assistant 侧附件放在 `mist.attachments[]`，每项至少包含：

```json
{
  "attachment_id": "opaque-id",
  "kind": "image | file",
  "filename": "name.ext",
  "media_type": "...",
  "size_bytes": 123,
  "source": "inline | opaque-ref"
}
```

附件不是 markdown 假链接、`[attachment]` 文本标记或内联 base64。client 声明 `attachments`
capability 时，adapter 选择 native projection；未声明时仍保留结构化对象，并把
`projection.status` 设为 `degraded`、`missing_capabilities` 写入 `attachments`。正文只能给出诚实的
可见性说明，不能把附件内容伪装成已呈现。

## 5. 选项、批准与阻断

它们不冒充 model tool call。tool call 表示模型要调用函数；这里表达的是宿主/用户界面的
控制状态，混用会让通用客户端误执行或伪造完成。

结构固定在 `mist.interaction`：

```json
{
  "interaction_id": "...",
  "kind": "choice | approval | blocked",
  "prompt": "...",
  "blocking": true,
  "options": [
    { "option_id": "...", "label": "...", "description": null }
  ],
  "reason_code": null
}
```

支持交互的 Pipe Function 用请求扩展提交控制响应，`messages` 为空即可；不要求为点击捏造一个
user turn，也不消费客户端重放的 history：

```json
{
  "model": "任意兼容占位值",
  "stream": false,
  "messages": [],
  "mist": {
    "interaction_response": {
      "interaction_id": "...",
      "option_id": "..."
    }
  }
}
```

服务端按 interaction id、现行住户/scope、未解决状态与 option id 逐项核验。普通 user 文本永远
不能被猜成「点了某个按钮」。

choice 与 approval 的 native 路径都必须可完成：未解决状态保留原始 prompt、kind、blocking、
option id/label/description 与 reason code；合法控制响应只解决对应 binding 的待决项，恰好
记录一次可归属的控制结果，保留 interaction id 与被选中的 option id，不作为普通
user/assistant 对话调用模型。已解决项不可再次消费。
错误 interaction id、错误 option、跨 binding/scope 响应与重复响应均拒绝，控制状态与模型、
canonical 写入不增加。普通聊天文字可以继续成为聊天，但待决 blocking 动作不能因此解除，
也不能把文字猜成点击。
判卷须读回 pending/resolved 状态与实际选择，不能只看一份返回对象自称成功。
上述控制拒绝使用稳定 code `MIST_INTERACTION_RESPONSE_INVALID`。合法结果的 canonical 事件
保留完整 interaction 和选中 option；driver 的 `resolvedOptionId` 与耐久状态的
`resolutionEventId` 对应同一次追加，不能多写、错户或只在响应中自称解决。

不声明 `interactions` capability 的通用前端仍收到结构化 interaction，但
`projection.status = "blocked"`。普通正文只说明当前 surface 无法完成这项控制，不列出可复制粘贴
的编号选项，不接受自然语言替代点击。用户可换到终端或支持 Pipe Function 的前端继续。

流式回合不能只搬附件：interaction（含 `kind: "blocked"`）的完整结构、options、reason code、
投影关联与目标 writer/identity 必须在归一化值、SSE wire 与 canonical 记录三处逐字对齐；
SSE 丢掉 interaction 扩展等同损坏投影，判卷拒绝。

**代价**：纯 OpenAI 通用客户端可以聊天，却可能在批准/选择点停住。这比把高权限动作降成一行
可伪造文本更诚实。

## 6. 前端能力、投影决策与证据边界

请求扩展可声明：

```json
{
  "mist": {
    "client": {
      "surface": "open-webui-pipe-function",
      "capabilities": ["attachments", "interactions"]
    }
  }
}
```

声明只影响呈现，不参与鉴权或授权；它也是 client claim，不是宿主已经验证过的 UI 能力。未声明
时按 generic text-only surface 处理。

adapter 在组装本轮模型输入时，加入「本轮 client 声明了哪些 capability」这一宿主事实；回复
提交后，把 `native / degraded / blocked` 与缺失 capability 作为**服务端投影决策**关联到本轮
canonical 事件。下一轮住户可以知道 adapter 当时采取了哪种投影、为什么降级或阻断，不必从
前端重放历史里猜。

`canonical_event_ids` 是本轮新追加事件的非空子集，须覆盖响应实际呈现的附件/interaction，
且这些事件归属当前绑定的 resident/scope/stream/writer。可以引用一条、两条或三条等本轮记录，
不要求把每条 user/assistant 都列入；旧回合的任意已有记录不能替代。native 投影决策也关联本轮
canonical 记录。代价：判卷须在每次请求前后读回事件并比较 id，不能用全流累计数或固定条数替代。

这条记录**不能证明浏览器最终真的渲染成功**。Chat Completions 响应没有客户端确认通道；把
capability claim 或「响应已经写出 socket」叫成 UI delivery receipt，会越过实际证据。若以后
Open WebUI Pipe Function 要回传真实呈现结果，必须另立带 request/event id 的 acknowledgment，
与当前 `projection` 对象和 `surface-projection` 事件分开。图纸候选统一使用投影命名，
不保留没有实际调用方的早期回执别名。它不是用户话语，也不拼进 assistant 正文。

## 7. 鉴权、网络与错误

每次请求都必须带 `Authorization: Bearer <token>`。loopback 不豁免；缺 token 与错 token 均在
解析消息、读取主流、调用模型之前拒绝。失败后模型调用数、canonical event 数和附件写入数均为零。

生产 listener 默认只绑定 loopback；改为非 loopback 必须显式配置，并先登记进
`docs/runtime-config.md`。CORS 默认不开 wildcard，token 不进 query string。请求体、附件与并发
必须有上限；这些是第一处网络入口的实现约束，不因公开 CI 使用合成 transport 而消失。

错误保持 OpenAI 风格 envelope，并有稳定 code：

```json
{
  "error": {
    "type": "mist_auth_error",
    "code": "AUTH_REQUIRED",
    "message": "...",
    "param": null
  }
}
```

token 原文不进日志、投影记录、响应 id/body/error、原始 JSON/SSE、诊断导出或错误 message。
判卷同时扫描普通及 SSE 成功响应、401 原始响应、模型与 canonical/交互/附件元数据读回和审计；
失败诊断同样不打印已发现的 token。raw transport 的请求观察只保留 body，不复制 Authorization。
鉴权审计只记请求 id、来源类别、结果 code 与时间。带附件的未认证请求也必须先拒绝，
附件私有面不能先落字节再靠 canonical event 数为零冒充“零副作用”。独立附件读回的 count
与 records 长度须一致，拒绝后二者都为零；纯文本成功无需附件写入。

候选 `readSecurityAudit` 增加按实际鉴权尝试顺序读回的 `entries`，每项为
`{ source, result, code }`：source 为 remote/loopback，result 为 accepted/rejected，code 为
AUTH_REQUIRED / AUTH_INVALID / AUTH_ACCEPTED。AUTH_ACCEPTED 与 accepted 汇总只证明鉴权
通过；例如已认证 utility 请求仍可被 completion 拒绝。FE-06 逐项核四次拒绝与两次 loopback
正对照，并与 attempts/accepted 汇总互证。生产审计的请求 id/时间不因此变成新的网络请求
identity/replay/concurrency 契约。代价：驱动要提供这组结构化鉴权观察，不能仅返回总数；
既有 logs/receipts 仍保留并参与 token 扫描，不解析自由文本来推断来源或 code。

## 8. `/webui` 的接缝

`/webui` 是后续施工，不在 adapter PR1 里偷跑。它必须：

1. 先展示要安装的 Open WebUI、资源占用与将启动的服务，等待主人确认；
2. 检查 Docker 或 Python，二者都没有时只说明缺项，不安装系统运行时；
3. 走现有 `frontend` 插件安装闸；
4. 启动后打印本机 URL；
5. Open WebUI 的 **Pipe Function** 连接本图纸同一个 endpoint，不另开 history、auth 或 writer 后门。
6. 应用本图纸的后台任务禁用配置；Pipe 对残留的非聊天 task 显式拒绝。

「展示」和「安装」必须是同一次、可检查的提案与执行关联：`runWebuiCommand` 回读里给出
本次 `proposalId` 与 `installedPlugin` 的实际插件身份（opaque `pluginId` + `category`），审计同时保留
展示过的 proposal 与经 `frontend` 闸执行的安装操作，两者按 proposal id 归属。判卷核提案里的
组件名（Open WebUI）、资源占用、将启动服务与实装插件逐项对得上，沿 opaque id 合同、
不假设宿主 plugin id 的字面；空 proposal 或非 `frontend` 类别不能通过。资源占用是**展示估计**，
不冒充实测资源使用；提案里的将启动服务 id 与实际启动读回一致。Docker-only 与 Python-only
两条成功路径都要成立，取消与缺运行环境都不得安装。两条成功判卷各自在 reset 后的独立
未安装场景运行，各核一次安装闸与一次服务启动；不要求同一 binding 连续重装，正确宿主
可以复用已安装服务。`runtimeUsed` 必须从实际启动服务的配置读回，并与同 proposal 的安装
操作审计一致，不能由输入的 environment flags 推测；Python-only 必须用 Python，Docker-only
必须用 Docker。代价：宿主 driver 要暴露实际 runtime 选择，判卷需隔离两条安装场景。

顺序也是合同的一部分：**先展示完整提案，再消费确认决定**。`readWebuiAudit` 用有序操作读回
（proposal → confirmation → install）让这条顺序可检查，并以同一个 proposal id 归属。展示后
取消是合法正例：提案已展示、零安装/零服务/零系统安装；缺环境只报告缺项，不进入确认安装。
「先经闸安装再补确认」属于判红。这是简单的进程内操作日志，不是浏览器 UI 回执协议，也不把
浏览器实际渲染伪装成已验证。

这里说的是 Open WebUI 当前的 in-process Pipe Function，不是已经标为 legacy 的独立 Pipelines
服务。generic OpenAI-compatible client 不需要安装这段专用代码，但也拿不到完整可点击交互。
FE-07 要从这条实际接线读回回复与精确事件数，核 writer、resident、scope、stream，复验缺 token
与伪造 history 的拒绝/丢弃，不只比较 endpoint 标签或“文字出现在某处”。

## 9. 可执行判卷映射

| 灯 | 本图纸冻结的观察面 |
| --- | --- |
| FE-01 | terminal 默认、external 显式、legacy official-skin 可操作拒绝且原字节不改 |
| FE-02 | 原始 JSON/SSE 完整结构与归一化相符、文本事件 kind/正文/顺序、唯一 writer、utility 在附件解析/持久化前拒绝 |
| FE-03 | 含 developer/tool 的请求前缀历史不进模型/账/可观察回执；空 messages / 末尾非 user / 不可解析 content 稳定拒绝 |
| FE-04 | 两请求各自新增事件的归属、writer、正文/顺序及 model currentText；客户端字段不改变 server route |
| FE-05 | 完整结构、本轮非空投影子集、远程 URL SSRF 拒绝、流式 interaction、generic 降级、choice/approval 同次 resolution 绑定与负例 |
| FE-06 | 同一 Bearer 闸、失败零模型/账/控制/附件 count+records、逐来源/result/code 鉴权审计、全表面 token 零泄漏 |
| FE-07 | 展示→确认→安装顺序、提案与实装插件身份关联、环境、插件闸、本机 URL、私有附件写入 delta 与归属、同 endpoint 的 writer/history/auth 边界与 task 拒绝 |

判卷驱动只观察公开边界；缺驱动时七盏全红。正向 fixture 只用于证明判卷器能识别正确形状，
不替代真实 adapter、真实宿主或独立验收席。
具体 typed 观察口见 [driver contract](../../acceptance/frontend-adapter-driver.ts)：
`readRawWire` 保留实际请求/响应 body，包含被拒绝的响应；`readInteractions` 读回待决与解决状态；
`readAttachmentWrites` 单独读回附件私有面的写入计数与 opaque 元数据，不导出附件字节。
每条记录带 binding/resident/scope/stream/writer 归属（`writerId` 即 canonical 写入归属，
不是另一个独立「附件 writer」），与 canonical 权威一致；后者是鉴权/utility 拒绝零附件副作用的
证据，不能由 canonical event 数或没有模型调用替代。
`readNetworkAttempts` 只读回真实 transport 上发生过的远程抓取尝试的 opaque 元数据与归属，
不导出 URL 查询串/token/字节；判卷要求零抓取尝试，任何真实尝试（含被策略阻止）都判红。
`runWebuiCommand` 与 `readWebuiAudit` 通过 proposal id 把展示的安装提案、确认决定与实际经
`frontend` 闸安装的插件身份按序关联起来，判卷不假设宿主 plugin id 字面。

## 10. 协议依据

2026-10-04 查阅：[Chat Completions 与 streaming chunk 对象](https://developers.openai.com/api/reference/resources/chat)、
[Open WebUI Task Models](https://docs.openwebui.com/features/administration/task-models/)、
[Pipe Function 保留参数](https://docs.openwebui.com/features/extensibility/plugin/functions/pipe/)。
这些资料说明第三方协议与后台任务行为，不替代主笔对本图纸的评审或真实 Open WebUI 验证。
