# mist 会话 API · webui 线协议契约（v0 草案）

单A 连接层的可执行规格：弟弟的 mock 按此实现，实现即契约测试桩；最终随上游 PR 提交 mist 定稿。
证据等级：**实查**（对冻结树 47f9438 读码 + 追调用点；boot 时序另经 ConnectionController 源码核实）。

## 总原则

- webui 不感知通道。客户端用原装 `AbstractApiClient` 族（`WebApiClient` 浏览器载体）——**客户端零协议改动**，换的是 `/api` 后面站着谁。
- webui 只传 UI 语义（session/prompt/parent），不传 Claude/pi/凭证；通道分派在 mist 内部（对齐 #51 通道绑定节）。
- 传输：unary 一律 `POST /api/{method}`（JSON envelope）；浏览器 v0 的两条下行流 `/api/events.mux`、`/api/events.host` 均走 WS。`MistHandler` 不感知载体；SSE 可后补，但不属于当前 dev server 交付。
- Envelope 形状照 `packages/host/apiproxy/src/api/rpc.ts` 的 `ClientRequest / ServerResponse / ServerRequest / ClientResponse / RpcReceipt`；zod schema 就是判据（客户端两级 parse：envelope + 方法 value）。

## 就绪握手（boot 三件 · ConnectionController 实查）

connected = `events.mux` onOpen + `events.host` onOpen + `host.describe` unary 成功，三者齐。
断线 → 'reconnecting' → 换代（generation）重连，重开双流 + 重发 describe；onConnected 触发 resync。

## P0 · mist 必须实现（真实语义）

| 方法 | 触发点 | mist 侧映射 |
|---|---|---|
| `host.describe` | 每代就绪握手 | 静态描述（名称/能力位）；**不含 dsh 品牌** |
| `session.list` | onConnected resync | 住户可见会话列表（消息树 heads） |
| `session.create` | 新会话 | SessionRegistry.open + 树锚点 |
| `session.history` | 打开会话/重连重拉 | history snapshot + **单 session 递增 seq**（弟弟四面之一） |
| `session.prompt` | 发消息 | submit turn → dispatch 收据（residentId+generation+dispatchId 关联键） |
| `session.cancel` | 停止按钮 | cancel 在途 turn |
| `settings.describe` | 欢迎声明加载 | 返回含 `ui-onboarding` 的可写 namespace views |
| `settings.mutate` | 欢迎声明确认 | 通用 path set/unset；内存持久化已读版本并返回新 view |
| `api.respond` | approval/question 回答 | client-response 回填原 rpcId（pending interaction 关联） |
| `workspace.list` | onConnected resync | v0 返回单个合成 workspace（mist 无多工作区概念） |
| `events.mux` | 常开 | 会话事件下行（见帧节） |
| `events.host` | 常开 | session-added/removed/status 下行 |

## P1 · 可后补（UI 有入口但 v0 可降级）

`session.search / rename / fork / attachment / updateQueue / models / selectModel`、`subagent.*`、`skills.list`、`settings.*` 其余、`credentials.*`、`llm.*`、`goal.*`、`agentPreset.*`、`workspace.*` 其余、`host.pickDirectory / listDirectory / createDirectory / openPath`。

**未实现方法必须返回结构合法的 RpcError**（envelope 过 zod，`result.ok=false` + 错误码），不许 404/500 裸奔——UI 各面板对 err result 有降级路径，裸 500 会打穿。v0 锁定为 `internal` + `not implemented by Mist webui v0: {method}` + 空 `details`；上游的闭合错误码集合没有 `unimplemented`，不得自造新码。headless 实证：桩子全 `internal` 回答下页面零崩溃开机，cordis 面板等消费方按降级路径落地。

**boot 清单（headless 实证补充）**：页面启动吃宿主注入的 `window.__DSH_BOOT__` WebBootGraph（`{rev, entries[{id=包名, url:/plugins/<id>/client.js?rev, rev, inject?, immediately?}]}`，`<` 转义、head 首个 script）；UI 模块是按清单逐个加载的插件 bundle（来自各包 `exports["./client"]`）。mist 侧伺服职责因此比"静态 dist"多两样：清单注入 + `/plugins/` bundle 路由（dev-server `boot-graph.ts` 是参考实现）。roster 裁定：排除 `client-hmr`（上游 web profile 亦禁用）与 `ui-directory-picker-native`（与 browse 同槽冲突、mist 无宿主原生对话框）；`ui-cordis`/`cordis-client-runner`（dsh 自家插件管理面板）在 mist 语境无意义 建议汇合时剔除。

### P0 错误码锁定（mock 即判据）

| 情形 | RpcError code | details |
|---|---|---|
| P0 payload 未通过冻结树 zod schema | `bad-request` | `{ issues: ZodIssue[] }` |
| session id 不存在 | `session-not-found` | `{ sessionId }` |
| 同 id 重开但 cwd 不同 | `session-conflict` | `{ sessionId, requestedCwd, existingCwd }` |
| prompt 到已有在途 turn | `agent-busy` | `{ reason: "active-turn" }` |
| 指向非合成 workspace | `workspace-not-found` | `{ workspaceId }` |
| mock v0 收到 image prompt（附件契约未交付） | `attachment-error` | `{ reason }` |
| settings 乐观 revision 已过期 | `settings-conflict` | `{ ns, expected, actual }` |
| settings namespace 未注册/未暴露 | `settings-not-exposed` | `{ ns }` |
| settings path mutation 被拒 | `settings-rejected` | `{ ns }` |
| 任一 P1 方法未实现 | `internal` | `{}` |

`session.cancel` 对已空闲 session 幂等返回 `{ accepted: true }`；`api.respond` 对迟到或重复回答返回 carrier receipt `{ accepted:false, reason:"not-pending" }`，不是 RpcError。
仍在 pending 的 question 回答必须同时匹配外层 `rpcId`、session、按原顺序的 question id、选项标签、单/多选约束与 custom 规则；任一不符返回 `{accepted:false, reason:"bad-response"}` 且不得消费 pending entry。`result.ok=false` 只接受 `cancelled`，并收敛为 `question/resolved(outcome="cancelled")`。

## 事件帧（mux payload union · 按 UI 消费面裁）

P0 帧：`session/event`（turn 流式主体）、`session/subscribed`（带 lastSeq 基线）、`stream/error`。
P1 帧：`session/queue`、`session/jobs`、`session/projection`、`approval requested/resolved`、`question requested/resolved`。
host 流 P0 帧：`host/session-added`、`host/session-removed`、`host/session-status`。

`session/event.event` 直接使用冻结树 `@deepseek-ai/dsh-session/types` 的严格外壳：

```ts
{
  type: string
  seq: number       // 单 session 从 0 开始连续递增
  time: number      // Unix epoch milliseconds
  data: unknown     // 由 type 决定
  sourceEventSeqs?: number[]
  surfaceOp?: 'append' | { op: 'replace'; start: number; end: number }
  ignorable?: true
}
```

mock 锁定的 turn 映射如下：

- 边界：`turn/start`、`step/start`、`step/end`、`turn/end`；turn 与各 turn 内的 step 均从 1 开始连续递增，完成/失败/取消分别是 `reason.kind = completed / error / aborted`。
- 用户输入：`user/message`，`data` 是完整 `UserMessage`，`source.kind="user"` 且保留本次 prompt 的原始 `rpcId`，`surfaceOp="append"`。
- 流式块：`assistant/chunk`，内层 `StreamChunk` 使用 `block-start`、`reasoning-delta`、`text-delta`、`tool-call-delta`、`block-end`、`finish`。
- 完整助手消息：`assistant/message`，含 `turn/step/message`，来源固定为 `{kind:"model", provider:"mist", model:"mock"}`（仅测试桩事实，不是 WebUI 可选 provider）。
- 工具：`tool/call` 保存原始 arguments JSON 字符串；`tool/result` 保存关联 `callId` 的完整 `ToolResultMessage`。

每个下行 payload 都包在 `server-request`：纯 push 由壳 mint 新 `rpcId`，answerable/replay 帧由 handler 提供稳定 `rpcId`；outer `method` 必须等于 `payload.type`。handler 的 unary 入口同时收到 client-request 的原始 `rpcId`，否则 `user/message` 无法做 optimistic echo 对账。

## seq 与断线（小g底线）

- history 事件单 session 从 `seq=0` 连续递增；空 log 的 `lastSeq=-1`。订阅先发 `subscribed(lastSeq)` 基线再推有序 live。
- v0 不做复杂 cursor resume（dsh v1 的 since 实际也被忽略）：断线走 重开双流 → 重拉 list/history → seq gap repair。
- 三样不可缺：history+seq、RPC correlation（rpcId 回显）、pending interaction 重放。

## 部署形状

- dev：mist dev server = 静态 dist + `/api` 分发 + 双下行流，loopback 起步。
- 真身：mist 会话编排层（SessionRegistry + MessageTreeService 之后，通道无关——弟弟在 #49 汇总稿第五节的定位）背同一套 `/api`。
- demo/server.ts 的 say() 假流**不接**（最终全文伪装 delta，钉过的现状证据）。

### 鉴权（#49 楼内 2026-08-17 采纳 · 参考 kimicode 的默认形状，出处照家规注明）

- **token 验证默认强制开启，loopback 也不豁免**：CLI 入口无 `TOKEN` 环境变量时自动生成强随机 secret（24 字节 base64url），启动时以 `?token=` access URL 打印恰一次。
- 入口流：`/?token=…` → 302 落 `mist_dev_token` cookie 并从地址栏剥离 token；此后静态资源、API 与 WebSocket 全部凭 cookie 过闸（Safari 对子资源/WS 丢 Basic 凭证的老毛病由此整类绕开，2026-08-17 真机复现在案）。
- **公网监听必须显式** `BIND=0.0.0.0`；库层底线不变：非 loopback 绑定绝不允许无 token。
- **反代 ≠ 鉴权**：前置 nginx/CDN 只做转发，应用层始终自行验 token。野外已存在 dsh 反代后无密码公网部署（#49 楼内 wusaki0723 报），本形状即为堵此缺口。
- 测试/CI 逃生口：`INSECURE_NO_TOKEN=1` 仅限本机与 CI；不出现在任何部署示例中。
- 库合同不变：`createDevServer` 显式注入 token 供测试穿闸；auto-token 在非 loopback 兜底——强制默认活在 CLI 进程边界，不动库语义。

## 插件装载边界（#61 核验采纳 · 2026-08-18）

- **按插件协议 v0 装载后，webui 服务的仍是 mock 数据**：`PluginPrepareContext` v0 只有 `pluginId / config / register`，没有宿主向 frontend 插件交付服务实现的通道，`mist-plugin.ts` 的 handler 因此固定为 `createMockMistHandler()`。「真身：mist 会话编排层背同一套 /api」要等 RFC v0.1 定义 handler 交付通道后另出适配（协议侧欠账，Review 席自领 follow-up）。
- **装载前提是完整 build**：`pnpm run build` 的四步顺序不可拆着跑——跳过 `build:lib:host` 直接 `build:lib:client` 会因 typert 生成的 `/remote` 类型缺 host 面而报错（Review 席 2026-08-18 实测 31 个 TS 错）；`mist-plugin.ts` 的 `prepare` 对缺 dist fail-loud。
- **配置唯一来源是 `context.config`**：manifest 不声明 `env` 绑定（v0 未定义 env 值如何交付给插件，声明即死承诺）；RFC 补齐 env 交付语义后再回来声明。
