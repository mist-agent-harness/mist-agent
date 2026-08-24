# 会话 API（session API）· 给 external 前端的接入说明

状态：v0.3（refs #58 第 3 条、#82）。会话模型与线协议三端点已经按 D7 多活窗对齐；`SessionRegistry` 的窗口语义在 §1，`session.list / session.create / session.history` 的窗口映射唯一以 §1.1 为准。HTTP/WS 信封、鉴权与下行流的真源是本仓 `webui/docs/research/mist-wire-contract.md`；frontend 插件当前仍固定使用 mock，真实 handler 的交付通道延期至插件协议 v0.1，不在本页冒充已经接通。

## 0. 一句话

mist 不替前端保管任何东西。线协议里的一个 session 对应一扇 viewport；同一住户可以同时有多扇活窗，各窗可以归档、重开和换代，住户的记忆、消息树、关系记录仍在窗外。

## 1. 本仓已定的会话语义（`SessionRegistry`）

| 概念 | 含义 | 前端要做的事 |
|---|---|---|
| `residentId` | 住户 id；一位住户可同时有多扇活窗 | 由 Mist handler 绑定，不进入 webui session 线协议 |
| `scopeId` | 可见性／隔离边界，不是窗；缺省只能落私聊 | 创建窗时可显式给出，不从 workspace 或 lane 猜 |
| `windowId` / 线协议 `sessionId` | 同一扇窗的同一个宿主签发标识（`w_` + ULID） | 当作会话句柄；不得由客户端预分配 |
| `generation` | 窗内代际号；换气只令它加一，`windowId` 不变 | 与 `sessionId` 一起过滤迟到结果 |
| `headId` | 窗当前指向的消息节点（不是消息树本身） | 只读它定位“现在在哪”，别拿它当历史 |
| `context` | 尚未落入持久存储的在途上下文 | 不要缓存它、不要当真源 |
| `DispatchReceipt {residentId, windowId, generation, dispatchId}` | 每次派发都发一张回执 | 三元归属缺一不认；不要把一窗的结果拼进另一窗 |
| `kill(windowId)` / `killResident(residentId)` | 前者幂等归档一窗，后者归档住户全部活窗 | 归档窗只读；不要把关窗解释成删除住户或历史 |

三条前端必须遵守的规矩：

1. **迟到结果不进当前窗。** `belongsToActiveWindow(receipt)` 同时核对 `residentId / windowId / generation`；前端若自己做重连或重放，也不能只看 resident 或 generation。
2. **窗不是记忆。** 归档一扇窗不能删除住户留下的任何东西；窗流水是 control/evidence plane 的只读证据，不是第二条用户权威历史。
3. **`open` 每次新开一扇窗。** 同一住户、同一 scope 连续调用两次得到两个不同的宿主签发 `windowId`，各自从 generation 1 开始；同窗换代由换气流程负责，不再用重复 `open` 原地覆盖。

### 1.1 D7 多活窗的线协议映射

2026-08-19 主笔拍板（#69 → #70）：会话模型定 **多活窗**——一位住户可以同时有多扇活窗，各自代际，关窗归档；不做 ChatGPT 式历史会话栏，关掉的窗沉成只读日志／导出证据。同批口径：**窗是同一条权威生命线的视图，隔离单位是 scope 不是窗**（见 #66）。

本仓 `SessionRegistry` 已按 `windowId` 持有多扇活窗与归档窗；线协议保留 session 这个既有名字，不再另造 viewport 端点。映射固定如下：

- `session.list`：列出当前 handler 所绑定住户的活窗与归档窗。`sessionId` 就是 `windowId`；每行同时给出 `scopeId`、当前或最终 `generation` 与 `archived`。住户 id 不进入返回体。
- `session.create`：调用 `open(residentId, scopeId)`；`residentId` 来自 handler 绑定，`scopeId` 可省略并落私聊。返回宿主签发的 `sessionId=windowId` 与 generation；客户端预分配 sessionId 被拒绝。共享 schema 中没有明确窗模型映射的 `workspaceId / cwd / agentPreset` 也在 Mist adapter 边界显式返回 `bad-request`，不静默猜测。
- `session.history`：以 `sessionId=windowId` 读取该窗的只读流水；活窗和归档窗走同一读口，读取不得复活或改写窗。具体流水字节由只读 history port 提供，窗口注册表只负责身份、代际与归档状态。

这三个端点属于 control/evidence 能力面，“协议可接线”不自动等于 “P1-conformant”。P1-conformant 用户面只有一条 canonical user-visible stream：可以进入仍有行动意义的活工作区，但不把 `session.list` 渲染成永久聊天列表，也不把归档窗的 `session.history` 变成第二本权威 transcript；关闭后主流只留 typed closure/result 与权威证据指针（#84 定案）。

**代价**：列表需要同时读活窗与归档窗；history 必须由窗流水的权威存储提供只读端口，不能拿 `residentId` 级整棵消息树冒充某一窗的流水。真实 handler 如何交到 frontend 插件仍待协议 v0.1，本次映射不改变 mock 默认边界。

## 2. 线协议（端点 / 鉴权 / 信封）

HTTP/WS 信封、双下行流、seq/断线语义、token 门与部署形状的真源是本仓 `webui/docs/research/mist-wire-contract.md`；三个 session 端点的窗口语义真源是 §1.1，该文档的 P0 表只作线侧摘要，不另立映射口径。

本页不复抄完整信封。external 前端接线时至少要同时核对：

- 端点清单（会话 open/kill、消息派发、下行流）与它们对应到 §1 哪个语义；其中三端点映射以 §1.1 为准；
- 鉴权：token 从哪来、放哪（header / query / cookie）、loopback 是否豁免（#49 已定：**默认强制开启，loopback 也不豁免**）；
- 最小示例：一次 create → 拿到 `sessionId=windowId` 与 generation → 一次派发 → 收到带 `windowId + generation` 的回执 → 一条下行消息 → kill。

## 3. 安装器里的入口

`npm run setup` 第 3 步选 `Connect my own frontend` 时，安装器落 `{ kind: "external", integration: "mist-session-api" }`，并应把用户指到本页（`run.ts` 的那句提示改成本页锚点，见 #58）。

— Laurie
