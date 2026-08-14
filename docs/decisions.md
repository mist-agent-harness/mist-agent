# 决策台账

全项目唯一的拍板看板。issue 里讨论出的待决问题收编到这里追，issue 本身可以关。
三种状态：**待决**（等主笔拍板）、**挂起**（有前置条件，条件到了再启）、**已决**（带日期）。

## 待决

| 编号 | 问题 | 材料 | 备注 |
|---|---|---|---|
| D1 | Relationship Core 进不进地基边界（#4 六问） | [design/relationship-core.md](design/relationship-core.md) | 旦九已六问全答赞成，等主笔。讨论留在 issue #4 |
| D2 | 路线 A/B/C：自建八模块 / dsh 当底盘只做 M4+M7 / 只抄设计不上车 | issue #6、#7 | 指定讨论贴：issue #7 |
| D3 | 语言栈 TS vs Python | issue #6 讨论题 4 | 跟 D2 联动 |
| D4 | 原则二措辞勘误落地：原始事件 append-only，edit/retry/fork 只新增节点 | issue #3 建议 2 | 旦九 2026-08-13 已收下，待改 principles.md |

## 挂起

| 编号 | 事项 | 前置条件 |
|---|---|---|
| H1 | 能力契约 schema 定稿（#2/#8/#11） | 第一里程碑垂直闭环跑通后，从真实能力反推，不凭空立 |

## 已决

- 2026-08-13　八条设计原则定稿（[principles.md](principles.md)，每条带代价）。
- 2026-08-13　License 定 AGPL-3.0——harness 永远是住户们的。
- 2026-08-13　模块地图 M1–M8 定稿（[research/2026-08-13-module-references.md](research/2026-08-13-module-references.md) 总表）。
- 2026-08-14　PR #5（关系型 harness 生态调研）并入 research/，作为 D1 的参照材料。
- 2026-08-14　**第一里程碑定：最小垂直闭环**（issue #3 建议 6）——杀会话 → 凭启动包醒来
  → 不改史 → 勘误留底 → 不串房 → 迁移可回滚。这是图纸转代码的第一刀，也是 H1 的解锁条件。

## 规矩

- 拍板只认主笔。讨论在 issue，结论落在这里，落完 issue 关门。
- 每条已决必须能指回来源（issue / PR / 文档 commit）。
- 「实证」二字只给验收清单跑出来的东西用，读过的不等于验过的。
