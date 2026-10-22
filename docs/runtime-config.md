# 运行时配置与环境变量清单

状态：全项目唯一的环境变量登记处。现役读取点与设计约束分列；实现差异不改写已决语义。
**任何施工引入或改动环境变量，必须先在本文档登记再进代码**——代码评审时
发现本文档没有的 `process.env` 读取，打回。住户和用户想知道「这个旋钮在
哪、默认是什么」，只查这一页。

纪律（AGENTS.md / RT-06）：模型子进程的密钥走专属环境变量；产品状态只带凭证引用。
安装器与 runtime 的明文只落各自专属私有凭证面，不进入 git、公开配置、日志、一窗流、
交接信或启动包。安装器快照中的 `credentials/` 是私有凭证面，不能当成可发布配置导出。
本清单只列名字、用途、默认值，不列任何真实值。

## 现役（代码里已存在）

| 变量 | 读取点 | 默认 | 用途 |
|---|---|---|---|
| `MIST_DATA_DIR` | `src/installer/cli.ts`、`src/resident-runtime/cli.ts` | `~/.mist` | 安装器与终端的数据根；各入口的 `--data-dir` 优先。不带 `--resident` 的 `npm run resident` 从这里的当前安装启动（#182）；带 `--resident` 的老入口不读安装 |
| `MIST_RESIDENT_RUNTIME_TRANSPORT` | `src/resident-runtime/channels.ts`、`src/resident-runtime/cli.ts` | `synthetic`（未设或空字符串）；不带 `--resident` 从安装启动时为 `pi` | `synthetic` 为确定性合成通道；`pi` 经外部 pi CLI 调真实模型。其他值拒绝启动。从安装启动时由第一次启动按安装配通道；带 `--resident` 时设为 pi 不自动完成通道配置 |
| `PI_CODING_AGENT_DIR`（pi 上游变量） | `src/resident-runtime/pi-transport.ts`、外部 pi CLI | `~/.pi/agent`；单独 `~` 展开为 HOME（与 pi 相同） | 原配置根只读：每回合把 settings 去掉 `packages` 后投影到 0700 私有临时配置根，强制 `compaction.enabled=false`，models.json 以原路径符号链接。不复制 `auth.json`、`trust.json`、`models-store.json` 或其他配置根状态，也不把 `packages` 带进新根，避免 npm / git 包每回合重装或克隆。子进程用临时根，启动后先读有效策略；仅当项目 settings 经有效信任加载且仍启用 compaction 时，在 prompt 前拒绝。不写用户全局或项目 settings |
| `MIST_RESIDENT_RUNTIME_DIR` | `src/resident-runtime/host-process.ts` | 无；缺失拒绝启动 | runtime IPC 宿主的落盘根，判卷 adapter 显式注入。普通 `npm run resident` 的数据根仍走 `--data-dir` / `MIST_DATA_DIR` |
| `MIST_GROUP_CHAT_DATA_ROOT` | `src/group-chat/host-process.ts` | 无；缺失拒绝启动 | 群聊 IPC 宿主的落盘根，由群聊判卷 adapter（`src/group-chat-acceptance-driver.ts`）显式注入 |
| `MIST_WINDOW_ARCHIVE_PATH` | `tests/fixtures/session-registry-host.ts` | 空 = 纯内存 | 窗生命周期 JSONL 归档路径（`window_opened` / `window_archived` 追加写）。不设则不持久化，供无持久化需求的嵌入方 |
| `MIST_TURN_GATE_DATADIR` | `tests/fixtures/turn-gate-host.ts` | 空 = 纯内存 | 开工闸集成宿主的落盘目录：给了则 ResidentStore 与 FactLedger 同目录共存（各自后缀），供父进程 SIGKILL 后原目录拉起，验猝死切点；不设则全内存 |
| `MIST_WINDOW_HISTORY_DIR` | `src/window-host/window-history-host.ts`（及后续 window-history 验收宿主夹具） | 空 = 无缺省，须显式传 `dataDir` | window-history 生产宿主的落盘根：canonical stream 文件（`*.stream.json`，窗的代际与归档态也以窗账事实的形式落在这条唯一底座里）、存储格式迁移控制/墓碑账（`window-history.migration.json`）、迁移前字节备份（`window-history.backup/`）、每窗格式记录（`*.wh-format.json`）与故障注入标记（`window-history.faults/`）都落在这里。`WindowHistoryHost` 构造入参 `dataDir` 优先；不给才回落读本变量；两者都缺则拒绝启动（无歧义缺省，见「新增变量的规矩」第 3 条） |

pi 通道在子进程中仅按当前 provider 设置一项专属凭证变量，值来自住户凭证，不继承主进程中其他 provider 的密钥；未知 provider 拒绝启动，不回退到 `PI_API_KEY`。支持的变量名：
`ANTHROPIC_API_KEY`、`OPENAI_API_KEY`、`GEMINI_API_KEY`、`OPENROUTER_API_KEY`、`MISTRAL_API_KEY`、`GROQ_API_KEY`、`ANT_LING_API_KEY`、`QWEN_TOKEN_PLAN_API_KEY`、`QWEN_TOKEN_PLAN_CN_API_KEY`、`AZURE_OPENAI_API_KEY`、`NVIDIA_API_KEY`、`DEEPSEEK_API_KEY`、`GOOGLE_CLOUD_API_KEY`、`CEREBRAS_API_KEY`、`XAI_API_KEY`、`RADIUS_API_KEY`、`AI_GATEWAY_API_KEY`、`ZAI_API_KEY`、`ZAI_CODING_CN_API_KEY`、`MINIMAX_API_KEY`、`MINIMAX_CN_API_KEY`、`MOONSHOT_API_KEY`、`HF_TOKEN`、`FIREWORKS_API_KEY`、`TOGETHER_API_KEY`、`BASETEN_API_KEY`、`OPENCODE_API_KEY`、`KIMI_API_KEY`、`META_API_KEY`、`CLOUDFLARE_API_KEY`、`XIAOMI_API_KEY`、`XIAOMI_TOKEN_PLAN_CN_API_KEY`、`XIAOMI_TOKEN_PLAN_AMS_API_KEY`、`XIAOMI_TOKEN_PLAN_SGP_API_KEY`、`COPILOT_GITHUB_TOKEN`、`AWS_BEARER_TOKEN_BEDROCK`。
## 换气与交接信：设计约束与现役实现

图纸 [multi-viewport.md §4](design/multi-viewport.md#4-换气流程d8-落位) 已定语义。下表保留设计要求；
具体入口尚有差异，不能把现役默认值当成新的拍板：

| 配置 | 语义（图纸为准） | 形态约束 |
|---|---|---|
| 换气阈值 | 上下文 ≥ 阈值即触发换气；默认 300k token | **成员级配置，只能在窗开工时设定**；窗运行中（尤其临线）请求改阈值必须拒绝，返回 `CONFIG_INVALID`（验收 MV-D02）。不是全局 env，归窗级启动配置 |
| 交接信长度上限 | 默认 2000 token，实现时校 | 超限写入被拒，错误信息指明上限值与当前实际长度（MV-D08）；信不计入窗口阈值核算（D8 补记二） |
| 窗归档路径 | kill 归档写盘，append-only，无索引无导出（#79 定稿口径） | 现役 `MIST_WINDOW_ARCHIVE_PATH` 即此物，泳道 3 把它从测试夹具提升为正式宿主配置 |

现役 resident runtime 的成员触发线由 `ResidentRuntime.setBreathThreshold()` 管（状态落 `sessions/breath.json`）：窗只在本代开工前能改，
主人改线从下一代生效；未配置时 `BreathStateStore` 使用 `Number.MAX_SAFE_INTEGER`，
当前不会以图纸默认 300k 自动换气。封缄使用 `sealLetter()` 的 2000 token 默认上限。
窗生命周期可落 `SessionRegistry` 的 `archivePath`；`MIST_WINDOW_ARCHIVE_PATH` 仍由
测试宿主读取，未提升为 resident CLI 的环境变量。以上是实现边界，300k 默认要求仍在。

## 明确不走环境变量的东西

- **换气阈值**：见上，归窗级开工配置。做成全局 env 等于让临线的窗有权给自己续命，D8 拍板禁止。
- **裁定账路径与 seq**：账是地基本体的一部分，跟住户数据根目录走，不单独暴露开关。
- **任何密钥的真实值**：由专属凭证存储或部署平台的 secret 管理提供，调用模型时才注入 provider 环境变量。本清单只登记变量名，不列值。

## 新增变量的规矩

1. 名字带 `MIST_` 前缀；
2. 本文档先登记（表格一行：读取点、默认、用途），代码后落地；
3. 没有默认值就不能缺省启动——缺省行为的歧义在评审时解决，不留到运行时。

## 住户运行时的账装配

CLI 与宿主子进程共用 `src/resident-runtime/assembly.ts`，沿用现役
`MIST_RESIDENT_RUNTIME_TRANSPORT`（默认 synthetic；终端从安装启动时默认 pi）与宿主 `MIST_RESIDENT_RUNTIME_DIR`，
不新增变量。认证账跟着 `dataDir` 落在
`residents/<id>.facts.json`。candidate 本人接受后，room 与账在同一物化入口创建；
启动时为 active 身份恢复 room / 账，查询与 `provisionChannel()` 不负责开户。
嵌入方可选 `ledger: { dataDir }` 接认证宿主，或
`factLedger` 接已有账的只读视图；两者互斥，都不传则 `currentFacts` 缺席。
交接信的 `commitment` 只保存 seq 指针和短引用，不复印正文；现行正文随 `currentFacts`
进入启动包，Pi 的本轮 context 消息按 `[#seq] 正文` 渲染，供信里的指针定位。
宿主维护经 `AuthenticatedLedgerHost.system(senderId).append`，新承诺用 `active_rule`；
住户写入仍须经过已认证 ingress 和现役 `forDispatch(...).append`，没有新增终端立承诺命令。

Pi 模型输入布局：system prompt 放身份、原交接信与固定权威说明；本代 history 按 user/assistant
角色载入回合私有 session；当前承诺、记忆、可选现行事实放在 history 之前，当前 user
仍经 RPC `prompt` 只发一次。session 文件与 prompt 共用 0700 临时目录、文件 0600，
回合结束或取消后删除。header 的 cwd 取进程 cwd，不取随机临时目录；材料不变时上一轮
模型输入是下一轮的消息前缀，材料变化会让该前缀失效一次。
私有配置关闭 compaction，`get_state` 确认 `autoCompactionEnabled=false` 后才发送 prompt。
这项预检只在项目 settings 实际被加载时能看到项目覆盖：私有根不继承 `trust.json`，所以用户
曾在原根信任的项目目录不会因此自动获得信任；项目配置若没被加载，预检只确认投影后的
`false`。收到 compaction 事件也拒绝，用户 global/project settings 均不写。

私有根故意只投影 settings（去掉 `packages`）和 models.json：`pi install` 的 npm/git 扩展不会
每回合被安装或克隆，但子进程也看不到这些包；`--no-extensions` 本来就不加载它们。原根的
`auth.json` 不复制（凭证按 RT-06 走环境变量），`trust.json` 不继承（原根逐项目的信任不沿用；
settings 中显式的 `defaultProjectTrust` 策略仍会投影），
`models-store.json` 等动态模型缓存不继承（自定义静态模型仍从 models.json 读取，动态目录可能
缺项或由 pi 在新根重建）。其余配置根状态也不会出现。代价是项目级设置/信任和动态模型状态
与用户原 `pi` 会话不完全一致；mist 每回合都建一次小配置投影，不承诺原根扩展在 mist 通道内可用。

所核 Pi 1.2.0 源码中，请求模型不在可用目录而进入自定义模型 ID 回退时，会沿用同一 provider
默认模型（或目录中该 provider 的首个模型）的其余信息，包括上下文窗口和单价。这些值未必对应目标模型，
因而 `costTotal` 估算可能不准，也不能把回退窗口当作目标模型真实容量的已验证依据。
此回退分支仅核对上游源码，尚未做运行复验。

真实通道的外部包已迁至 `@earendil-works/pi-coding-agent`，要求 pi ≥0.86.1；
核过的 0.86.1 / 1.2.0 要求 Node ≥22.19。bridge 启动修复及其持久聊天史处理待 #232 后另件，
本项撤回显式 bridge loader。

Usage 无新增环境变量：成功回合追加到 `dataDir/logs/<residentId>.usage.jsonl`，文件 0600。
只记录 turnId、代际、模型、adapter、时间及有效的 reported 数值；缺失字段省略，合成通道
不造读数。`runtime.turnUsage()` 走身份读闸，只认 canonical residentId；按字段累计
附 `cumulativeCoverage`，其 `totalTurns` 仅计已记录回合，不涵盖丢失日志或失败模型调用。
`costTotal` 是上游报告的估算，不是账单；默认 0 可能来自上游归零，不能据此判定缓存。
写日志失败不会回滚完成的聊天/ACK；本进程的 `logError` 保留已知遗漏，重启后不重建它。
读盘访问失败报 `writer-unavailable`，不回显原文；坏行跳过，`invalidRecords` 报损坏记录数，
有效记录继续参与累计。追加前末字节非换行就先补分隔符，保留原损坏字节供人工调查。
日志无轮转、每次读整文件。累计不是 context 占用，换气估算门不变。

`npm run verify:pi-wire -- /path/to/pi` 使用已有真实 pi、回合私有配置与本机假 Anthropic
端点验证请求；不读真实 auth.json、不用真实 key、不请求真实 provider，不要求公开 CI 安装 pi。
探针的 settings 带 npm/git `packages`，且不设 `PI_OFFLINE`；PATH 前置只记录并失败的 npm/git
替身，核零安装/克隆尝试。该探针仍不证明真实 provider、真实缓存命中或费用。
模型输入投影由 `pi-transport.ts` 维护，usage 由 `usage-log.ts` 维护；相关回归在
`tests/pi-transport.test.ts` / `tests/resident-runtime.test.ts`，其验证边界见 resident-runtime 清单。
