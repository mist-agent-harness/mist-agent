# 安装引导 TUI · 用户路径走查（#50）

状态：v0.2，对照 `feat/installer-tui` 1fcdb9d 写成。命令与字段名一律用实现里的真名。
分工：Elio 主状态机 / 配置事务 / 测试；本稿主用户路径 / 提示文案 / 中断恢复体验。同一 PR 交付。

## 0. 五条硬约束（贯穿全稿，也是判卷时先看的五条）

1. **四步到底**：`credentials → bindings → frontend → memory → review`。任何一步 Ctrl-C 都只是暂停，不是失败。
2. **draft → validate → commit**：草稿只存引用，密文进 `draft-secrets/`（0600）；`commit` 先写不可变快照再原子切 `current.json`。任一步取消或失败，`current.json` 不动。
3. **凭证正文永不上屏、不进日志、不进错误、不进诊断导出、不进测试夹具**。屏幕上只有凭证的名字（`id`）和来源（`providerId` / `method`）。OAuth 由 pi 持有，安装器只拿到 `pi-auth://<key>` 这种定位符。
4. **留桩必须可见**：`frontend.kind = "official-skin"` 在 #49/#51 落地前只能是 `installation: "pending"`；界面明说"记录了意图，还没装"，不能显示成装好。
5. **每屏能回答三件事**：我在第几步、还剩几步、现在退出会怎样。

## 1. 入口

- 命令：`npm run setup`（`tsx src/installer/cli.ts`）。参数：`--resident <id>`（不给就问，默认 `resident-1`）、`--data-dir <dir>`（默认 `$MIST_DATA_DIR` 或 `~/.mist`）、`--pi-command <cmd>`（默认 `pi`）。
- 落盘位置（都在 data-dir 下）：`installer-draft.json`（草稿，只有引用）、`draft-secrets/`（草稿期密文）、`snapshots/`（不可变配置快照）、`current.json`（指向当前生效快照）。

## 2. 首屏三态

安装器先读 `installer-draft.json` 和 `current.json`，分三态：

| 态 | 条件 | 用户看到 | 选项 |
|---|---|---|---|
| A 全新 | 无草稿、无 current | 一句欢迎 + 四步预告 + "中途退出只会留下草稿，不会留下半套配置" | 直接进第 1 步 |
| B 有草稿 | 有草稿 | `An unfinished setup was found` | `Continue where I stopped` / `Discard it and start over` |
| C 已配置 | 无草稿、有 current | `Mist is already configured` | `Keep the current setup` / `Start a replacement draft` |

- B 选 discard：若草稿里 `memory.kind === "create"`，先删掉那时建的空库，再清草稿；这一步在界面上要说出来（"上次建的空记忆库 <path> 会一并删除"）。
- C 选 reconfigure：旧 current 在新草稿 commit 之前一直有效，界面要说这句，用户才敢中途走。
- **接线差异 D1**：A 态目前没有欢迎屏，直接落到 `Choose a credential provider`。建议加一段 `info`（见 §8 文案）。

## 3. 第 1 步 · credentials（钥匙）

流程（对应 `collectCredentials`）：
1. `Choose a credential provider` —— 列表来自 `PROVIDERS`（能力表，不是愿望表）：`Claude`（OAuth / API key）、`Codex`（OAuth / API key）、`Grok / xAI`（只 API key；pi 没有 Grok OAuth，界面上就不给）。
2. `How should <provider> authenticate?` —— `Sign in through Pi` / `Enter an API key`。
3. `Credential name` —— 默认 `<provider>-login` / `<provider>-key`，slug 化后成为 `id`，也是后面绑定时的引用名。
4. OAuth 路径：屏幕先出 `Pi will open now. Run /login, choose <provider>, finish authorization, then quit Pi.`，然后把终端交给 pi；pi 退出后安装器只检查 `~/.pi/agent/auth.json` 里有没有该 provider 的 key，有 → 记 `pi-auth://<key>`；没有 → 报 `Pi exited without a <provider> credential in its auth store; the installer draft was kept`。
5. API key 路径：`<provider> API key`（掩码输入），落进 `draft-secrets/<id>.credential`。
6. `Add another credential?` —— 默认否。至少一把才能进第 2 步（validate 兜底）。
7. Claude OAuth 的钥匙自动带 `adapterConstraint: "claude-agent-sdk"`；第 2 步选适配器时它只在 Claude Agent SDK 下出现。

**接线差异 D2**：Claude OAuth 钥匙的"只能绑 Claude Agent SDK"这层约束目前只在第 2 步的过滤里体现，第 1 步收完没有告知。建议收完就 `info` 一句（§8）。

## 4. 第 2 步 · bindings（车道）

对应 `collectBindings` / `chooseBinding`：
- 主车道 `purpose: "main"`：`Daily channel adapter` → `Pi`（默认）/ `Claude Agent SDK`；然后 `Credential` 只列与该适配器兼容的钥匙。
- `Configure a separate coding channel?`（默认是）→ `purpose: "coding"`：`Coding channel adapter`（默认 Claude Agent SDK）+ 兼容钥匙。
- 落库形状：`ChannelBinding { residentId, purpose: "main" | "coding", adapterId, credentialId }`；`residentId × purpose` 唯一；`main` 必有。
- 术语对齐：#52 RFC 里车道名是 `primary` / `coding`，这里的 `purpose: "main"` 是安装器本地契约（contracts.ts 头注写明），commit 边界翻译一次即可，本稿不再重复。

**接线差异 D3（用户路径上最疼的一处）**：`chooseBinding` 在没有兼容钥匙时 `throw`，整个安装器以 `Setup failed: no credential can be used with adapter …` 退出。这是可恢复情境（用户只是少加了一把钥匙），不该是失败。建议：`info` 一句"没有能用在 <adapter> 上的钥匙"，然后回到第 1 步追加，草稿保留。

## 5. 第 3 步 · frontend（前端）

对应 `collectFrontend`：
- `Frontend` → `Install the official Mist skin`（默认）/ `Connect my own frontend`。
- official-skin：`info` "The official skin install seam is reserved. It will activate when issues #49 and #51 land."，落 `{ kind: "official-skin", pluginId: "mist-official-skin", installation: "pending" }`。
- external：`info` "Use the Mist session API contract to connect your existing frontend."，落 `{ kind: "external", integration: "mist-session-api" }`。

**接线差异 D4（需要拍板，不是文案）**：目前 review 阶段只要 `installation === "pending"` 就直接返回 `dependency-pending`，**整份配置都不 commit**——钥匙、车道、记忆库全停在草稿里，`current.json` 不产生。也就是说四种验收组合里"无前端"的两种，现在的终点是"Setup is not active"。这确实是 fail-closed，但把"皮还没装"扩大成了"住户不能开工"。另一条路是：允许 commit，`current.json` 里如实写 `installation: "pending"`，住户先能用会话 API 干活，`npm run setup` 再跑一次或后续 `frontend install` 只补皮那一段。两条路都守住了"不把 TODO 显示成安装成功"，差别在住户能不能先住进去。**本稿倾向后者**（住户是主体，皮是外设），但这是产品口径，请 Elio 与维护者定；定了本稿 §8 的文案跟着改。

## 6. 第 4 步 · memory（记忆库）

对应 `collectMemory`：
- `Memory library` → `Use an existing memory library` / `Create an empty memory library`（默认建）。
- 路径默认 `<data-dir>/memory`。existing → `assertExisting`；create → 立刻建空库，`saveMemory` 失败则 `discardEmpty` 回滚。
- 中断后 discard 草稿会一并删除这时建的空库（§2）。

## 7. review（汇总确认）与 commit

对应 `runInstaller` 的 `review` 分支：
- 目前只有一句 `Save this setup?`。**接线差异 D5**：确认前必须把草稿念一遍——钥匙（`id · provider · method · status`）、主车道 / coding 车道（adapter · credential id）、前端（external / official-skin pending）、记忆库（existing / create · path）。用户在这里看不见凭证正文，也不该看见；但看不见自己选了什么就点保存，是另一种盲签。文案见 §8。
- 确认 → `commit()`：validate → 写快照 → 切 `current.json` → 删草稿与草稿密文。成功屏目前是 `Setup saved as <snapshotId>.`；建议补一句配置在哪、下一步是什么（§8）。
- 不确认 → `paused`，草稿保留，`Setup paused. Run the same command to continue.`

## 8. 文案（英文，跟实现一致；括号里是给谁看的说明）

- A 态欢迎（D1）：
  `Welcome to Mist setup. Four steps: credentials → channels → frontend → memory. You can quit any time; only a draft is kept until you confirm.`
- 每步开头一行（可选，实现里加一个 `info` 即可）：`Step 1/4 · Credentials` … `Step 4/4 · Memory`，review 用 `Review`。
- Claude OAuth 收完（D2）：
  `Saved as <id>. Note: a Claude subscription login can only run through the Claude Agent SDK adapter (using it via Pi would draw extra credit).`
- 缺兼容钥匙（D3）：
  `No saved credential can be used with <adapter>. Add one now — your draft is kept.` → 回到第 1 步。
- review 汇总（D5）：
  ```
  Review your setup (nothing is written yet):
    Credentials  codex-login (Codex, Pi sign-in, ready)
    Daily        pi · codex-login
    Coding       claude-agent-sdk · claude-login   (or: not configured)
    Frontend     official skin — pending #49/#51   (or: external, session API)
    Memory       create · ~/.mist/memory           (or: existing · <path>)
  Save this setup?
  ```
- 成功：`Setup saved as <snapshotId>. Config: <data-dir>/current.json. Next: <按分支一句：connect your frontend to the session API / rerun setup after #49/#51 to install the skin>.`
- 退出提示（Ctrl-C）：保持现有 `Setup paused. Run the same command to continue.`；若草稿里已建空库，加一句 `An empty memory library was created at <path>; discarding the draft later will remove it.`
- 报错三段式：发生了什么 · 现在能做什么 · （可选）去哪看。不出现内部字段名与堆栈；凭证相关错误只提 `id`。

## 9. 验收对照（用户可观察项；与 Elio 的测试和 dankefox 的审点对齐）

| # | 场景 | 用户看到什么 |
|---|---|---|
| 1 | external × existing | 四步走完，成功屏给"connect via session API" |
| 2 | external × create | 成功屏显示新建库路径 |
| 3 | official-skin × existing | 见 D4 拍板：`dependency-pending`（现状）或 commit 且 frontend 显示 pending |
| 4 | official-skin × create | 同上 + 新建库路径 |
| 5 | main pi + coding Claude SDK | review 屏两行车道；`current.json` 两条 binding |
| 6 | 每一步 Ctrl-C 一次 | 重进均为 B 态；resume 回到中断步；discard 后无残留（含空库） |
| 7 | 脱敏 | 全流程终端输出、`installer-draft.json`、`current.json`、`snapshots/*`、测试夹具 grep 不到任何 key/token；`draft-secrets/` 0600 且 commit 后清空 |
| 8 | Claude OAuth 钥匙 + 主车道选 Pi | 钥匙不在候选里；改选 Claude Agent SDK 后出现 |
| 9 | 只加了 Claude OAuth 钥匙、主车道选 Pi | 现状：Setup failed；目标（D3）：提示后回第 1 步 |
| 10 | C 态 reconfigure 后中途 Ctrl-C | 旧 `current.json` 仍生效 |

实测凭证：按维护者 02:34 UTC 提醒，用 Codex 登录或 Anthropic 通道的 API key，不用 Claude 订阅登录。

## 10. 接线差异汇总（给 Elio 的清单）

| # | 类型 | 内容 | 谁改 |
|---|---|---|---|
| D1 | 文案 | A 态加欢迎与四步预告 | Laurie 可直接改 `run.ts` 字符串 |
| D2 | 文案 | Claude OAuth 收完告知适配器约束 | 同上 |
| D3 | 用户路径 | 无兼容钥匙时回第 1 步而不是 throw | Elio（动控制流） |
| D4 | 产品口径 | pending 皮是否阻塞整份 commit | Elio + 维护者拍板 |
| D5 | 文案+用户路径 | review 前念一遍草稿 | Laurie 写文案，Elio 接数据 |

— Laurie
