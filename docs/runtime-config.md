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
| `MIST_GROUP_CHAT_DATA_ROOT` | `src/group-chat/host-process.ts` | 无；缺失拒绝启动 | 群聊 IPC 宿主的落盘根，由群聊判卷 adapter（`src/group-chat-acceptance-driver.ts`）显式注入 |
| `MIST_WINDOW_ARCHIVE_PATH` | `tests/fixtures/session-registry-host.ts` | 空 = 纯内存 | 窗生命周期 JSONL 归档路径（`window_opened` / `window_archived` 追加写）。不设则不持久化，供无持久化需求的嵌入方 |
| `MIST_TURN_GATE_DATADIR` | `tests/fixtures/turn-gate-host.ts` | 空 = 纯内存 | 开工闸集成宿主的落盘目录：给了则 ResidentStore 与 FactLedger 同目录共存（各自后缀），供父进程 SIGKILL 后原目录拉起，验猝死切点；不设则全内存 |
| `MIST_WINDOW_HISTORY_DIR` | `src/window-host/window-history-host.ts`（及后续 window-history 验收宿主夹具） | 空 = 无缺省，须显式传 `dataDir` | window-history 生产宿主的落盘根：canonical stream 文件（`*.stream.json`，窗的代际与归档态也以窗账事实的形式落在这条唯一底座里）、存储格式迁移控制/墓碑账（`window-history.migration.json`）、迁移前字节备份（`window-history.backup/`）、每窗格式记录（`*.wh-format.json`）与故障注入标记（`window-history.faults/`）都落在这里。`WindowHistoryHost` 构造入参 `dataDir` 优先；不给才回落读本变量；两者都缺则拒绝启动（无歧义缺省，见「新增变量的规矩」第 3 条） |
| `MIST_FRONTEND_ADAPTER_DRIVER` | `acceptance/frontend-adapter-run.ts` | `../src/frontend-adapter-acceptance-driver.ts`（相对 run.ts） | **判卷专用 seam**，#218/D31：只给 `acceptance/frontend-adapter-run.ts` 在隔离场景下覆盖前端适配层驱动的 specifier（例如把「缺驱动七红」搬到一个不存在的路径上核验）。不是产品入口，不进生产运行路径；不设或空串按默认驱动路径处理 |
| `MIST_FRONTEND_HOST_DIR` | `tests/fixtures/frontend-text-host.ts` | 无；缺失拒绝启动 | **判卷夹具专用**，#218/D31-1：夹具宿主进程用它作 `assembleResidentRuntime` 的 dataDir（受控 transport 的真实 runtime）。生产宿主走 `MIST_RESIDENT_RUNTIME_DIR`，不读此变量 |
| `MIST_ADAPTER_URL` | `assets/openwebui/mist-pipe.py`（Pipe 运行时读取） | 空 | **Open WebUI Pipe 专用**：#218/D31-1 adapter base URL，只从宿主进程环境读取；只允许 HTTP loopback 与空路径或单个 `/v1`，Pipe 规范化一次。用户可编辑 Valve 不拥有 endpoint 权威，重定向不跟随 |
| `MIST_ADAPTER_TOKEN` | `assets/openwebui/mist-pipe.py`（Pipe 运行时读取） | 空 | **Open WebUI Pipe 专用、私有执行边界**：adapter Bearer 原文，只从进程 env 读取并发往上列可信 loopback endpoint，**不写入 Valves/源码/持久配置/日志**。由 WebUI 启动时为 Pipe 进程注入（RT-06） |
| `MIST_WEBUI_ENDPOINT` / `OPENAI_API_BASE_URL` / `OPENAI_API_KEY` | `src/frontend/webui-platform.ts`（WebUI 子进程映射配置） | 启动时由平台注入 | **WebUI 子进程映射配置（非主人全局 export）**：endpoint 引用与 Bearer 随启动注入 WebUI 容器/进程的 child env；token 只在该私有 child env，不进 argv/账/公开快照 |
| `MIST_PIPE_PYTHON` / `MIST_PIPE_PYTHONPATH` | `tests/frontend-pipe.test.ts` | 无（回退 PATH 的 `python3.12`/`python3.11`） | **原生 Pipe 测试专用**：指定 Python 3.12 解释器与额外依赖目录（starlette/pydantic/requests）。不进生产。CI 用 `actions/setup-python@3.12` + `pip install -r assets/openwebui/requirements.txt` |
| `WEBUI_ADMIN_EMAIL` / `WEBUI_ADMIN_PASSWORD` | 官方 `open-webui` 进程（`main.py` startup `create_admin_user`）；由 `src/frontend/webui-platform.ts` 注入 | 无；启动时按需生成 | **WebUI 专属实例 admin 凭据**：#218/D31-1 随机 dedicated admin，只落专属私有凭据面 `webui/credentials/webui-admin.json`（0700 目录 / 0600 文件，exclusive create，拒 symlink/损坏/过宽权限，重启复用不换 password）。Docker 用无值 `--env`、值只在 child env；Python 走同一 child env；**不进 argv/URL/日志/公开配置/操作账/提案/模板**（RT-06） |
| `WEBUI_AUTH` | 官方 `open-webui` 进程（`env.py`） | 平台固定 `True` | **WebUI 认证保持开启**：#218/D31-1 禁止 `False`/默认 admin 捷径；专属 admin 由上面的 `WEBUI_ADMIN_EMAIL/PASSWORD` 建立，不直接改 SQL/DB |

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
`MIST_RESIDENT_RUNTIME_TRANSPORT`（默认 synthetic）与宿主 `MIST_RESIDENT_RUNTIME_DIR`，
不新增变量。认证账跟着 `dataDir` 落在
`residents/<id>.facts.json`。candidate 本人接受后，room 与账在同一物化入口创建；
启动时为 active 身份恢复 room / 账，查询与 `provisionChannel()` 不负责开户。
嵌入方可选 `ledger: { dataDir }` 接认证宿主，或
`factLedger` 接已有账的只读视图；两者互斥，都不传则 `currentFacts` 缺席。
交接信的 `commitment` 只保存 seq 指针和短引用，不复印正文；现行正文随 `currentFacts`
进入启动包，Pi 系统提示按 `[#seq] 正文` 渲染，供信里的指针定位。
宿主维护经 `AuthenticatedLedgerHost.system(senderId).append`，新承诺用 `active_rule`；
住户写入仍须经过已认证 ingress 和现役 `forDispatch(...).append`，没有新增终端立承诺命令。
