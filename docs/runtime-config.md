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
| `MIST_DATA_DIR` | `src/installer/cli.ts`、`src/resident-runtime/cli.ts` | `~/.mist` | 安装器与终端的数据根；各入口的 `--data-dir` 优先。共用根目录不表示安装快照已接到 runtime |
| `MIST_RESIDENT_RUNTIME_TRANSPORT` | `src/resident-runtime/channels.ts` | `synthetic`（未设或空字符串） | `synthetic` 为确定性合成通道；`pi` 经外部 pi CLI 调真实模型。其他值拒绝启动；设为 pi 不自动完成通道配置 |
| `MIST_RESIDENT_RUNTIME_DIR` | `src/resident-runtime/host-process.ts` | 无；缺失拒绝启动 | runtime IPC 宿主的落盘根，判卷 adapter 显式注入。普通 `npm run resident` 的数据根仍走 `--data-dir` / `MIST_DATA_DIR` |
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

现役 resident runtime 的成员触发线由 `configureBreathLine()` 管：窗只在本代开工前能改，
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
