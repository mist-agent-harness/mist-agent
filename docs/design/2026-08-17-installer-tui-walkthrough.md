# 安装引导 TUI · 用户路径走查（#50）

状态：v0.3，已对齐 `feat/installer-tui` 当前实现与 PR #52 的插件协议词表。命令与字段名一律用实现里的真名。
分工：Elio 主状态机 / 配置事务 / 测试；本稿主用户路径 / 提示文案 / 中断恢复体验。同一 PR 交付。

## 0. 五条硬约束（贯穿全稿，也是判卷时先看的五条）

1. **四步到底**：`credentials → bindings → frontend → memory → review`。任何一步 Ctrl-C 都只是暂停，不是失败。
2. **draft → validate → commit**：草稿只存引用，密文进 `draft-secrets/`（0600）；`commit` 先写不可变快照再原子切 `current.json`。任一步取消或失败，`current.json` 不动。
3. **凭证正文永不上屏、不进日志、不进错误、不进诊断导出、不进测试夹具**。屏幕上只有凭证的名字（`id`）、来源（`providerId`）与公开类型（`CredentialType`）。OAuth 由 pi 持有，安装器只拿到 `pi-auth://<key>` 这种定位符。
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
- A 态欢迎屏已接入；C 态重配期间旧 `current.json` 保持生效。

## 3. 第 1 步 · credentials（钥匙）

流程（对应 `collectCredentials`）：
1. `Choose a credential provider` —— 列表来自 `PROVIDERS`（获取入口表，不是愿望表）：`Claude`、`Codex`、`Grok / xAI` 都有 Pi OAuth / API key。Grok 入口依据 Pi provider 表的 `/login xai` subscription 路径。
2. `How should <provider> authenticate?` —— `Sign in through Pi` / `Enter an API key`。
3. `Credential name` —— 默认 `<provider>-login` / `<provider>-key`，slug 化后成为 `id`，也是后面绑定时的引用名。
4. OAuth 路径：屏幕先出 `Pi will open now. Run /login, choose <provider>, finish authorization, then quit Pi.`，然后把终端交给 pi；pi 退出后安装器只检查 `~/.pi/agent/auth.json` 里有没有该 provider 的 key，有 → 记 `pi-auth://<key>`；没有 → 报 `Pi exited without a <provider> credential in its auth store; the installer draft was kept`。
5. API key 路径：`<provider> API key`（掩码输入），落进 `draft-secrets/<id>.credential`。
6. `Add another credential?` —— 默认否。至少一把才能进第 2 步（validate 兜底）。
7. `CredentialRef { id, type, issuerId }` 与 PR #52 一致；Pi OAuth 记 `issuerId: "pi"`，手填 API key 记 `issuerId: "mist-installer-api-key"`。Claude OAuth 的约束由 `type: "claude_oauth"` 表达，不另造 `adapterConstraint` 字段；它只在 Claude Agent SDK 下出现，收完时界面也会明说。

## 4. 第 2 步 · bindings（车道）

对应 `collectBindings` / `chooseCredential`：
- `primary` 主车道首版固定走 Pi，然后只列 Pi 能用的钥匙；Claude OAuth 不会混进来。
- `Configure a separate coding channel?`（默认是）→ `coding` 车道首版固定走 Claude Agent SDK，然后列 Claude OAuth / API key。
- coding 可选自定义 Claude-compatible gateway：`baseUrl + tokenCredentialRef`，token 必须引用一把 API key；这是 PR #52 PV0-D06 的首版能力，不是留桩。
- 落库直接使用 RFC 形状：`LaneBinding { residentId, lane: "primary" | "coding", adapterId, credentialRef, adapterConfig? }`；`residentId × lane` 唯一；`primary` 必有。`main` 是角色，不是车道。
- 若当前没有兼容钥匙，界面提示后回第 1 步追加；已有钥匙和草稿全部保留，不再把可恢复情境报成安装失败。

## 5. 第 3 步 · frontend（前端）

对应 `collectFrontend`：
- `Frontend` → `Install the official Mist skin`（默认）/ `Connect my own frontend`。
- official-skin：`info` "The official skin install seam is reserved. It will activate when issues #49 and #51 land."，落 `{ kind: "official-skin", pluginId: "mist-official-skin", installation: "pending" }`。
- external：`info` "Use the Mist session API contract to connect your existing frontend."，落 `{ kind: "external", integration: "mist-session-api" }`。

产品口径已定为 fail-closed：只要 `installation === "pending"`，整份配置保留在草稿，`current.json` 不变。原因不是把皮当主体，而是 #50 的默认分支明确承诺“安装官方皮”；依赖没落地时不能把另一条 external 路径悄悄当成完成。pending 屏提供“保留草稿退出 / 改选前端”，后者只退回第 3 步，已完成的记忆库不重做。

## 6. 第 4 步 · memory（记忆库）

对应 `collectMemory`：
- `Memory library` → `Use an existing memory library` / `Create an empty memory library`（默认建）。
- 路径默认 `<data-dir>/memory`，输入 `~` / `~/…` 会展开。existing → `assertExisting`；create → 先把路径和 `memory_dir_created` 副作用写进草稿，再原子建空库。若进程刚好死在两者之间，重进 review 会幂等补建；discard 仍知道该清理什么。
- 中断后 discard 草稿会一并删除这时建的空库（§2）。

## 7. review（汇总确认）与 commit

对应 `runInstaller` 的 `review` 分支：
- `Save this setup?` 前会先念一遍草稿：钥匙（`id · provider · type · status`）、primary / coding 车道（adapter · credential id · 可选 gateway）、前端、记忆库。用户看得见自己的选择，看不见凭证正文。
- 确认 → `commit()`：validate → 写快照 → 切 `current.json` → 删草稿与草稿密文。成功屏目前是 `Setup saved as <snapshotId>.`；建议补一句配置在哪、下一步是什么（§8）。
- 不确认 → `paused`，草稿保留，`Setup paused. Run the same command to continue.`

## 8. 文案（英文，跟实现一致；括号里是给谁看的说明）

- A 态欢迎（D1）：
  `Welcome to Mist setup. Four steps: credentials → channels → frontend → memory. You can quit any time; only a draft is kept until you confirm.`
- 每步开头一行（可选，实现里加一个 `info` 即可）：`Step 1/4 · Credentials` … `Step 4/4 · Memory`，review 用 `Review`。
- Claude OAuth 收完：
  `Saved as <id>. A Claude subscription login can only run through the Claude Agent SDK adapter.`
- 缺兼容钥匙：
  `No saved credential can be used with <adapter>. Add one now — your draft is kept.` → 回到第 1 步。
- review 汇总：
  ```
  Review your setup (nothing is written yet):
    Credentials  codex-login (Codex, Pi sign-in, ready)
    Primary      pi · codex-login
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
| 3 | official-skin × existing | `dependency-pending`；草稿保留，旧 current 不变 |
| 4 | official-skin × create | 同上 + 新建库路径 |
| 5 | primary Pi + coding Claude SDK | review 屏两行车道；`current.json` 两条 binding |
| 6 | 每一步 Ctrl-C 一次 | 重进均为 B 态；resume 回到中断步；discard 后无残留（含空库） |
| 7 | 脱敏 | 全流程终端输出、`installer-draft.json`、`current.json`、`snapshots/*`、测试夹具 grep 不到任何 key/token；`draft-secrets/` 0600 且 commit 后清空 |
| 8 | Claude OAuth 钥匙 + primary Pi | 钥匙不在候选里；coding Claude Agent SDK 下出现 |
| 9 | 只加了 Claude OAuth 钥匙 | 提示后回第 1 步追加兼容钥匙；Claude 钥匙保留 |
| 10 | C 态 reconfigure 后中途 Ctrl-C | 旧 `current.json` 仍生效 |

实测凭证：按维护者 02:34 UTC 提醒，用 Codex 登录或 Anthropic 通道的 API key，不用 Claude 订阅登录。

## 10. 接线差异汇总（已合入）

| # | 类型 | 内容 | 谁改 |
|---|---|---|---|
| D1 | 文案 | A 态加欢迎与四步预告 | 已接入 |
| D2 | 文案 | Claude OAuth 收完告知适配器约束 | 已接入 |
| D3 | 用户路径 | 无兼容钥匙时回第 1 步而不是 throw | 已接入并有回归测试 |
| D4 | 产品口径 | pending 皮是否阻塞整份 commit | fail-closed，旧 current 不变 |
| D5 | 文案+用户路径 | review 前念一遍草稿 | 已接入，敏感正文不出现 |

— Laurie
