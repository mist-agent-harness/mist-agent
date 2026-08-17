# 会话 API（session API）· 给 external 前端的接入说明

状态：v0.1 草稿（refs #58 第 3 条）。本页分两半：**上半是本仓已经存在的会话语义**，来自 `src/session/session-registry.ts`，任何前端都必须遵守；**下半是线协议**（HTTP/WS 端点、鉴权、信封），真源目前在 #49 官方素皮仓的 `docs/research/mist-wire-contract.md`，等它上游或链接进来之前，这里只放占位，不另造第二份。

## 0. 一句话

mist 不替前端保管任何东西。前端连的是"住户当前这一次活会话"，会话可以被结束、重开、换代；住户的记忆、消息树、关系记录都在别处，会话没了它们还在。

## 1. 本仓已定的会话语义（`SessionRegistry`）

| 概念 | 含义 | 前端要做的事 |
|---|---|---|
| `residentId` | 住户 id，一位住户同一时刻最多一个活会话 | 一切请求都带它 |
| `generation` | 活会话的代际号。`kill` 后再 `open` 必换代 | 记住当前代际；收到不同代际的结果一律丢弃 |
| `headId` | 活会话当前指向的消息节点（不是消息树本身） | 只读它定位"现在在哪"，别拿它当历史 |
| `context` | 尚未落入持久存储的在途上下文 | 不要缓存它、不要当真源 |
| `DispatchReceipt {residentId, generation, dispatchId}` | 每次派发都发一张回执 | 用它把异步结果对回请求；`generation` 不等于当前会话就是迟到结果 |
| `kill(residentId)` | 幂等结束活会话 | 结束后本地状态清零；重开要拿新 `generation` |

三条前端必须遵守的规矩：

1. **迟到结果不进当前会话。** `belongsToActiveSession(receipt)` 只认代际相同的回执。前端若自己做重连/重放，也要按同一规则过滤，不能把上一代的流水拼进这一代。
2. **会话不是记忆。** 删掉一格活会话只能让一次对话结束，不能删除住户留下的任何东西；前端不要在会话结束时清用户可见的历史，历史另有来源。
3. **`open` 是显式动作。** 没有隐式复活；`kill` 之后必须再 `open` 才有新会话，前端界面上要能区分"会话结束"和"住户不在"。

## 2. 线协议（端点 / 鉴权 / 信封）—— 待上游

真源：`chez-nous-home/mist-webui` → `docs/research/mist-wire-contract.md`（线协议契约 v0，含信封协议、双下行流、seq/断线语义、token 门与部署形状）。

本节在该文件上游进本仓（或本仓放带版本号的链接桩）之前保持空白，避免两处各写一份互相漂移。落地后本节应至少包含：

- 端点清单（会话 open/kill、消息派发、下行流）与它们对应到 §1 哪个语义；
- 鉴权：token 从哪来、放哪（header / query / cookie）、loopback 是否豁免（#49 已定：**默认强制开启，loopback 也不豁免**）；
- 最小示例：一次 open → 一次派发 → 收到带 `generation` 的回执 → 一条下行消息 → kill。

## 3. 安装器里的入口

`npm run setup` 第 3 步选 `Connect my own frontend` 时，安装器落 `{ kind: "external", integration: "mist-session-api" }`，并应把用户指到本页（`run.ts` 的那句提示改成本页锚点，见 #58）。

— Laurie
