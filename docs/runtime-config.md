# 运行时配置与环境变量清单

状态：全项目唯一的环境变量登记处，现役清单 + 泳道 3 施工前的配置面预告。
**任何施工引入或改动环境变量，必须先在本文档登记再进代码**——代码评审时
发现本文档没有的 `process.env` 读取，打回。住户和用户想知道「这个旋钮在
哪、默认是什么」，只查这一页。

纪律（AGENTS.md）：密钥永远走环境变量，不进 git、不进快照、不进简历式文档。
本清单只列名字、用途、默认值，不列任何真实值。

## 现役（代码里已存在）

| 变量 | 读取点 | 默认 | 用途 |
|---|---|---|---|
| `MIST_DATA_DIR` | `src/installer/cli.ts` | `~/.mist` | 住户数据根目录 |
| `MIST_WINDOW_ARCHIVE_PATH` | `tests/fixtures/session-registry-host.ts` | 空 = 纯内存 | 窗生命周期 JSONL 归档路径（`window_opened` / `window_archived` 追加写）。不设则不持久化，供无持久化需求的嵌入方 |
| `MIST_TURN_GATE_DATADIR` | `tests/fixtures/turn-gate-host.ts` | 空 = 纯内存 | 开工闸集成宿主的落盘目录：给了则 ResidentStore 与 FactLedger 同目录共存（各自后缀），供父进程 SIGKILL 后原目录拉起，验猝死切点；不设则全内存 |
| `MIST_DEMO_DATA_DIR` | `demo/main.ts` | `.mist-demo` | demo 数据目录 |
| `MIST_DEMO_PORT` | `demo/main.ts` | `4317` | demo 服务端口 |
| `MIST_DEMO_CLAUDE_MODEL` | `demo/main.ts` | 内置默认 | demo 用的模型名 |

## 泳道 3（换气与交接信）施工要落地的配置面

图纸 `docs/design/multi-viewport.md` §4 已定语义，实现时按此暴露，不许另造名字：

| 配置 | 语义（图纸为准） | 形态约束 |
|---|---|---|
| 换气阈值 | 上下文 ≥ 阈值即触发换气；默认 300k token | **成员级配置，只能在窗开工时设定**；窗运行中（尤其临线）请求改阈值必须拒绝，返回 `CONFIG_INVALID`（验收 MV-D02）。不是全局 env，归窗级启动配置 |
| 交接信长度上限 | 默认 2000 token，实现时校 | 超限写入被拒，错误信息指明上限值与当前实际长度（MV-D08）；信不计入窗口阈值核算（D8 补记二） |
| 窗归档路径 | kill 归档写盘，append-only，无索引无导出（#79 定稿口径） | 现役 `MIST_WINDOW_ARCHIVE_PATH` 即此物，泳道 3 把它从测试夹具提升为正式宿主配置 |

## 明确不走环境变量的东西

- **换气阈值**：见上，归窗级开工配置。做成全局 env 等于让临线的窗有权给自己续命，D8 拍板禁止。
- **裁定账路径与 seq**：账是地基本体的一部分，跟住户数据根目录走，不单独暴露开关。
- **任何密钥**：进 `~/.secrets/` 或部署平台的 secret 管理，本清单永不列值。

## 新增变量的规矩

1. 名字带 `MIST_` 前缀；
2. 本文档先登记（表格一行：读取点、默认、用途），代码后落地；
3. 没有默认值就不能缺省启动——缺省行为的歧义在评审时解决，不留到运行时。
